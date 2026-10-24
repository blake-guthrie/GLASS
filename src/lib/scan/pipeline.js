// Orchestrates the stages and streams partial reports so the panel fills in progressively.
import { DEFAULTS, PUMP_TOTAL_SUPPLY } from '../constants.js';
import { resolveMint } from './resolve.js';
import { findCreation, collectLaunchTxs, extractLaunchEvents } from './launch.js';
import { analyseLaunch, enrichWithJito, applyWalletKinds, toolPatternReasons } from './fingerprint.js';
import { annotateFeeWallets } from './feewallets.js';
import { profileWallets } from './wallets.js';
import { trackCluster } from './live.js';
import { discoverPriorLaunches, analysePriorLaunches, rateOperator, devExitOnLaunch, clusterExitOnLaunch, profileSummary } from './operator.js';
import { creatorProfile, toPriorLaunches, fetchCoin } from './devprofile.js';
import { computeScore } from './score.js';
import { dexTokenInfo, jitoBundleId, solPriceUsd } from '../market.js';
import { pMap } from '../http.js';
import known from '../../data/known.js';

export const STAGES = ['resolve', 'creation', 'launch', 'wallets', 'live', 'operator', 'score'];

/**
 * @param rpc        RpcClient
 * @param identifier mint or pair/pool address
 * @param opts       { settings, memory, emit(stageName, report), signal:{aborted}, hintIsMint, log }
 */
export async function runScan(rpc, identifier, opts = {}) {
  const settings = { ...DEFAULTS, ...(opts.settings || {}) };
  const emit = opts.emit || (() => {});
  const log = opts.log || (() => {});
  const aborted = () => opts.signal?.aborted;
  const t0 = Date.now();
  const report = {
    identifier,
    mint: null,
    stage: 'resolve',
    stages: {},
    errors: [],
    startedAt: t0,
    settings: {
      slotWindow: settings.slotWindow,
      earlyWindowSec: settings.earlyWindowSec,
    },
  };
  const stageStart = {};
  const begin = (s) => {
    report.stage = s;
    stageStart[s] = Date.now();
    report.stages[s] = { status: 'running' };
    emit(s, report);
  };
  const done = (s, status = 'done') => {
    report.stages[s] = { status, ms: Date.now() - stageStart[s] };
    report.rpcCalls = rpc.totalCalls;
    report.degraded = rpc.totalDegraded;
    report.rpc = {
      ...(report.rpc || {}),
      url: rpc.url,
      switched: rpc.switched,
      profile: rpc.profile?.name,
      failSummary: rpc.failSummary,
      rateLimited: rpc.rateLimited,
    };
    emit(s, report);
  };
  const fail = (s, e) => {
    report.errors.push({ stage: s, message: e?.message || String(e) });
    log(`stage ${s} failed: ${e?.message || e}`);
    done(s, 'error');
  };
  // Score + verdict + call from whatever the report holds right now
  const rescore = (launchOverride) =>
    computeScore({
      launch: launchOverride || report.launch,
      wallets: report.wallets,
      live: report.live,
      operator: report.operator?.rating,
      ctx: {
        profile: report.operator?.profile || report.devProfile || null,
        profileError: report.operator?.profileError || null,
        operatorDone: report.stages?.operator?.status === 'done' || report.stages?.operator?.status === 'error' || report.operator?.disabled,
        walletsFailed: report.stages?.wallets?.status === 'error',
        degraded: rpc.totalDegraded,
        rateLimited: rpc.rateLimited,
      },
    });

  // ---- resolve ----
  begin('resolve');
  try {
    const r = await resolveMint(rpc, identifier, {
      hintIsMint: opts.hintIsMint,
    });
    if (!r.mint) throw new Error(r.error || 'unresolved');
    report.mint = r.mint;
    report.resolvedVia = r.via;
    let pair = r.pair;
    if (!pair || pair.mint !== r.mint) pair = (await dexTokenInfo(r.mint)).best;
    // Resolved via a pair URL → still fetch the token's full pair list for the earliest pool time
    if (pair && pair.earliestPairCreatedAt == null) {
      const t = await dexTokenInfo(r.mint);
      if (t.best?.earliestPairCreatedAt) pair = { ...pair, earliestPairCreatedAt: t.best.earliestPairCreatedAt };
    }
    report.market = pair ? { ...pair } : { mint: r.mint };
    let supply = PUMP_TOTAL_SUPPLY;
    let confirmedSupply = null;
    try {
      const m = await rpc.getMintInfo(r.mint);
      if (m?.supply) supply = m.supply;
      if (typeof m?.supply === 'number' && Number.isFinite(m.supply) && m.supply > 0) confirmedSupply = m.supply;
      if (m?.tokenProgram) report.tokenProgram = m.tokenProgram;
    } catch {
      /* default */
    }
    report.supply = supply;
    // priceUsd is already denominated in USD, including USDC-quoted pairs.
    // Prefer it to a historical launch's quote price or an assumed SOL rate.
    if (report.market.marketCapUsd == null && typeof report.market.priceUsd === 'number' &&
        Number.isFinite(report.market.priceUsd) && report.market.priceUsd > 0 &&
        confirmedSupply !== null && Number.isFinite(report.market.priceUsd * confirmedSupply)) {
      report.market.marketCapUsd = report.market.priceUsd * confirmedSupply;
      report.market.mcapSource = 'DexScreener USD price × token supply';
    }
    solPriceUsd().then((v) => (report.solUsd = v || null)).catch(() => {});
    done('resolve');
  } catch (e) {
    fail('resolve', e);
    report.finishedAt = Date.now();
    emit('done', report);
    return report;
  }
  if (aborted()) return report;

  // ---- which endpoint still has the launch? Free RPCs prune history after ~14–30 h. ----
  let hrpc = rpc; // history client: launch / wallet / operator stages
  try {
    const createdMs = report.market?.earliestPairCreatedAt || report.market?.pairCreatedAt;
    if (createdMs) {
      const slotMs = await rpc.slotTimeMs();
      const nowSlot = await rpc.getSlot();
      const estSlot = Math.round(nowSlot - (Date.now() - createdMs) / slotMs) - 1500;
      const picked = await rpc.forSlot(estSlot);
      const hours = (x) => Math.round(((nowSlot - x) * slotMs) / 3600000);
      report.slotMs = Math.round(slotMs);
      const primaryStart = await rpc.historyStart();
      report.rpc = {
        ...(report.rpc || {}),
        historyHours: primaryStart ? hours(primaryStart) : null,
        archiveUsed: picked && picked !== rpc ? picked.url : null,
      };
      if (!picked) {
        const ageH = Math.round((Date.now() - createdMs) / 3600000);
        const deepest = rpc.archive ? await rpc.archive.historyStart() : primaryStart;
        throw Object.assign(
          new Error(`This token launched ~${ageH}h ago, but the free RPCs GLASS can use only keep about ${hours(deepest || primaryStart)}h of history. Add a free Helius API key in GLASS settings (click the icon) to scan older tokens.`),
          { friendly: true },
        );
      }
      hrpc = picked;
      if (hrpc !== rpc) log(`history for this launch comes from ${hrpc.url}`);
    }
  } catch (e) {
    if (e.friendly) {
      begin('creation');
      fail('creation', e);
      report.finishedAt = Date.now();
      emit('done', report);
      return report;
    }
    log(`history check failed: ${e.message}`);
  }

  // ---- creation ----
  begin('creation');
  let creation;
  try {
    creation = await findCreation(hrpc, report.mint, {
      pairCreatedAtMs: report.market?.earliestPairCreatedAt || report.market?.pairCreatedAt,
      log,
    });
    if (!creation.record) throw new Error(`creation tx not found (${creation.notes.join('; ') || 'no leads'})`);
    report.creation = {
      generic: !!creation.generic,
      launchProgram: creation.launchProgram || null,
      sig: creation.record.sig,
      slot: creation.record.slot,
      blockTime: creation.record.blockTime,
      createdAt: creation.record.blockTime ? creation.record.blockTime * 1000 : report.market?.pairCreatedAt || null,
      creator: creation.record.feePayer,
      method: creation.method,
      notes: creation.notes,
      bondingCurve: creation.bondingCurve,
      tokenName: creation.record.pumpIxs.find((p) => p.name.startsWith('create'))?.tokenName || null,
      symbol: creation.record.pumpIxs.find((p) => p.name.startsWith('create'))?.symbol || null,
    };
    done('creation');
  } catch (e) {
    fail('creation', e);
    report.finishedAt = Date.now();
    emit('done', report);
    return report;
  }
  if (aborted()) return report;
  // Start the dev profile now (one HTTP request, cached) so it is ready by the time the operator stage
  // runs — and surface the headline fact ("this wallet has launched 5,092 tokens") as early as possible.
  if (settings.operatorHistory && report.creation.creator) {
    creatorProfile(report.creation.creator, { currentMint: report.mint, log })
      .then((p) => {
        if (p?.available && !report.operator) {
          report.devProfile = profileSummary(p);
          emit(report.stage, report);
        }
      })
      .catch(() => {});
  }

  // ---- launch window ----
  begin('launch');
  let events = [];
  let analysis = null;
  try {
    const col = await collectLaunchTxs(hrpc, report.mint, creation, {
      slotWindow: settings.slotWindow,
      earlyWindowSec: settings.earlyWindowSec,
      log,
      onLaunchWindow: (recs) => {
        // Partial: launch window only (early window still loading)
        const ev = extractLaunchEvents(recs, report.mint, creation);
        const a = analyseLaunch(ev, {
          supply: report.supply,
          slotWindow: settings.slotWindow,
          earlyWindowSec: settings.earlyWindowSec,
        });
        a.partial = true;
        report.launch = a;
        report.score = rescore(a);
        emit('launch', report);
      },
    });
    events = extractLaunchEvents(col.records, report.mint, creation);
    analysis = analyseLaunch(events, {
      supply: report.supply,
      slotWindow: settings.slotWindow,
      earlyWindowSec: settings.earlyWindowSec,
    });
    analysis.txsRead = col.records.length;
    analysis.partialEarly = col.partialEarly;
    analysis.blocksRead = col.blocksRead;
    report.launch = analysis;
    emit('launch', report);
    if (settings.jitoLookup) {
      try {
        await enrichWithJito(analysis, events, jitoBundleId);
      } catch (e) {
        log(`jito enrich failed: ${e.message}`);
      }
    }
    // Is the "shared fee wallet" a popular bot's fee account or private infrastructure?
    try {
      await annotateFeeWallets(rpc, analysis, { memory: opts.memory });
      const reasons = toolPatternReasons(analysis);
      analysis.launchToolPattern = { detected: reasons.length >= 2, reasons };
    } catch (e) {
      log(`fee wallet check failed: ${e.message}`);
    }
    report.launch = analysis;
    // Fresh tokens are often not on DexScreener yet: derive mcap from the last trade's reserves, or from
    // the create event's initial virtual reserves when nobody has traded yet.
    if (report.market && report.market.marketCapUsd == null) {
      const last = [...events].reverse().find((e) => e.priceQuote);
      const createEv = creation.record.pumpEvents?.find((e) => e.type === 'create');
      const priceQuote = last?.priceQuote ?? (createEv?.vSol && createEv?.vTok ? createEv.vSol / createEv.vTok : null);
      const sol = priceQuote ? await solPriceUsd() : null;
      if (priceQuote && sol) {
        report.market.marketCapUsd = priceQuote * report.supply * sol;
        report.market.priceUsd = priceQuote * sol;
        report.market.mcapSource = last ? 'last launch-window trade' : 'initial bonding-curve price (no trades yet)';
        if (!report.market.dexId) report.market.dexId = 'pumpfun';
      }
    }
    report.score = rescore();
    done('launch');
  } catch (e) {
    fail('launch', e);
  }
  if (aborted()) return report;

  const clusterWallets = (analysis?.buyers || []).filter((b) => b.firstSlotOffset <= settings.slotWindow).map((b) => b.wallet);
  const creator = report.creation.creator;
  const launchTimeSec = report.creation.blockTime || Math.floor((report.creation.createdAt || Date.now()) / 1000);

  // ---- wallets ----
  begin('wallets');
  let walletsOut = null;
  try {
    const toProfile = clusterWallets.slice(0, settings.maxWalletProfiles);
    if (toProfile.length) {
      const launchBuyers = new Map((analysis?.buyers || []).map((b) => [b.wallet, b]));
      // Archive client for wallets whose beginning the primary RPC has pruned
      let archive = hrpc.isArchiveClient ? hrpc : null;
      if (!archive) {
        try {
          await rpc.forSlot(1); // instantiates rpc.archive as a side effect
        } catch {
          /* no archive */
        }
        archive = rpc.archive || null;
      }
      walletsOut = await profileWallets(hrpc, toProfile, {
        launchTimeSec,
        creator,
        known,
        buyersSet: clusterWallets,
        launchBuyers,
        archive,
      });
      report.wallets = {
        profiles: walletsOut.profiles,
        summary: walletsOut.summary,
      };
    } else
      report.wallets = {
        profiles: [],
        summary: {
          walletsProfiled: 0,
          reasons: [],
          behaviouralLinkScore: 0,
          kinds: {},
        },
      };
    if (analysis) applyWalletKinds(analysis, report.wallets.profiles);
    report.score = rescore();
    done('wallets');
  } catch (e) {
    fail('wallets', e);
  }
  if (aborted()) return report;

  // Operator cluster = creator + bundle-like (and unclassified) launch wallets + the wallets that paid
  // for or funded them (those usually carry the history when the buyers are fresh). Snipers and organic
  // buyers are tracked for insider flow but never treated as the operator.
  const linkers = [...(analysis?.sharedPayers || []).map((x) => x.address), ...(report.wallets?.summary?.sharedPayers || []).map((x) => x.address), ...(report.wallets?.summary?.sharedFunders || []).map((x) => x.address)].filter(
    (a) => a && a !== creator,
  );
  const operatorWallets = [...new Set([...linkers, ...(analysis?.classified ? analysis.bundle.wallets : clusterWallets)])];
  report.operatorCluster = {
    creator,
    linkers: [...new Set(linkers)],
    wallets: operatorWallets.length,
  };

  // Reputation: have we seen these sniper bots / fee wallets / funders / this dev on launches scanned before?
  if (opts.memory?.getReps && analysis) {
    try {
      const snipers = analysis.buyers.filter((b) => b.kind === 'sniper').map((b) => b.wallet).slice(0, 40);
      const fees = (analysis.sharedFeeRecipients || []).map((x) => x.address).slice(0, 10);
      const funders = linkers.slice(0, 10);
      const fpKey = analysis.fingerprints?.dominant?.wallets?.length >= 2 ? [analysis.fingerprints.dominant.key] : [];
      const [sn, fe, fu, dv, fp] = await Promise.all([opts.memory.getReps('sniper', snipers), opts.memory.getReps('fee', fees), opts.memory.getReps('funder', funders), opts.memory.getReps('dev', [creator]), opts.memory.getReps('fp', fpKey)]);
      const pack = (m) =>
        Object.entries(m)
          .map(([wallet, r]) => ({ wallet, seen: Math.max(0, (r.seen || 0) - (r.mints?.includes(report.mint) ? 1 : 0)), avoid: r.levels?.avoid || 0, caution: r.levels?.caution || 0, lastSeen: r.lastSeen }))
          .filter((x) => x.seen > 0)
          .sort((a, b) => b.seen - a.seen);
      report.reputation = { snipers: pack(sn), feeWallets: pack(fe), funders: pack(fu), dev: pack(dv)[0] || null, fingerprint: pack(fp)[0] || null };
    } catch (e) {
      log(`reputation lookup failed: ${e.message}`);
    }
  }

  // ---- live + operator history, in parallel (independent data; the RPC layer paces concurrency) ----
  const liveStage = async () => {
    begin('live');
    try {
      if (settings.liveTracking && analysis) {
        // Operator cluster = dev + bundle-like/unclassified launch wallets. Snipers are only balance-checked.
        const inWindow = analysis.buyers.filter((b) => b.firstSlotOffset <= settings.slotWindow);
        const cluster = [{ wallet: creator, tokens: analysis.creatorDevBuy.tokens, kind: 'dev' }, ...inWindow.filter((b) => b.kind !== 'organic' && b.kind !== 'sniper').map((b) => ({ wallet: b.wallet, tokens: b.tokens, kind: b.kind || 'bundle' }))].filter((c) => c.wallet);
        const clusterSet = new Set(cluster.map((c) => c.wallet));
        // Everyone else from the early window gets a balance check too (receipts "holds now" column)
        const others = analysis.buyers.filter((b) => !clusterSet.has(b.wallet)).slice(0, 60).map((b) => ({ wallet: b.wallet, tokens: b.tokens, kind: b.kind || (b.firstSlotOffset <= settings.slotWindow ? 'unclassified' : 'early') }));
        report.live = await trackCluster(rpc, report.mint, cluster, { launchTimeSec, supply: report.supply, tokenProgram: report.tokenProgram, maxWallets: 25, others });
        const snipers = inWindow.filter((b) => b.kind === 'sniper');
        if (snipers.length) {
          const bal = new Map(report.live.otherHoldings.map((h) => [h.wallet, h.now]));
          const bought = snipers.reduce((s, b) => s + b.tokens, 0);
          const now = snipers.reduce((s, b) => s + (bal.get(b.wallet) || 0), 0);
          report.live.snipers = { count: snipers.length, boughtPct: (bought / report.supply) * 100, holdsPct: (now / report.supply) * 100, exitedShare: bought ? Math.min(1, 1 - now / bought) : null };
        }
        report.live.cluster = cluster;
        report.score = rescore();
      }
      done('live');
    } catch (e) {
      fail('live', e);
    }
  };

  const operatorStage = async () => {
    begin('operator');
    try {
      if (settings.operatorHistory) {
        const sigLists = walletsOut?.sigLists || new Map();
        const cluster = {
          creator,
          wallets: operatorWallets,
          linkers: report.operatorCluster?.linkers || [],
        };
        // Two sources in parallel: pump.fun's record of everything this creator wallet (and its funders)
        // ever launched, and on-chain sampling for launches that other cluster wallets bundled.
        const linkerCreators = cluster.linkers.slice(0, 3);
        const [profile, linkerProfiles, prior] = await Promise.all([
          creatorProfile(creator, { currentMint: report.mint, log }),
          Promise.all(linkerCreators.map((w) => creatorProfile(w, { currentMint: report.mint, log }).catch(() => ({ available: false })))),
          discoverPriorLaunches(hrpc, report.mint, cluster, sigLists, {
            memory: opts.memory,
            maxWallets: settings.maxOperatorWallets,
            maxCandidates: settings.maxPriorLaunches,
            log,
          }),
        ]);
        const apiLaunches = toPriorLaunches(profile, creator);
        const apiMints = new Set(apiLaunches.map((l) => l.mint));
        for (let i = 0; i < linkerProfiles.length; i++) {
          const lp = linkerProfiles[i];
          if (!lp?.available) continue;
          for (const l of toPriorLaunches(lp, linkerCreators[i])) {
            if (apiMints.has(l.mint)) continue;
            apiMints.add(l.mint);
            apiLaunches.push({
              ...l,
              viaInfra: true,
              linkedBy: [
                {
                  wallet: linkerCreators[i],
                  how: 'a funder of the launch buyers created it (pump.fun record)',
                },
              ],
            });
          }
        }
        report.operator = {
          launches: [...apiLaunches, ...prior.filter((p) => !apiMints.has(p.mint))],
          rating: null,
          discovered: apiLaunches.length + prior.length,
          funderHops: prior.funderHops || [],
          profile: profile?.available ? profileSummary(profile) : null,
          linkerProfiles: linkerProfiles.filter((x) => x?.available && x.totalCreated > 0).map(profileSummary),
          profileError: profile?.available ? null : profile?.reason || null,
        };
        emit('operator', report);
        // Dev sells on the most recent launches, read from the dev's own token accounts (exact, cheap)
        const solUsd = await solPriceUsd();
        const devExitsP = pMap(
          apiLaunches.filter((l) => !l.viaInfra).slice(0, 10),
          async (l) => {
            try {
              // pick an RPC that still has that launch's history (archive for older ones); skip what nobody has
              let client = hrpc;
              if (l.createdAt) {
                const slot = await rpc.slotForTimeMs(l.createdAt).catch(() => null);
                client = slot ? await rpc.forSlot(slot).catch(() => null) : hrpc;
              }
              if (!client) {
                l.clusterExit = { sampledTxs: 0, sells: 0, firstSellMin: null, note: 'older than the free RPCs keep — add a Helius key to check' };
                return;
              }
              l.clusterExit = await devExitOnLaunch(client, creator, { ...l, athAt: profile.sample.find((c) => c.mint === l.mint)?.athAt || null }, report.supply, solUsd, { tokenProgram: report.tokenProgram });
            } catch {
              l.clusterExit = null;
            }
          },
          4,
        );
        // Launches found on-chain (funder-linked, other creators): outcomes from pump.fun's per-coin record
        // when it answers (one request each, no rate limit), GeckoTerminal/on-chain reconstruction otherwise.
        const chainOnly = prior.filter((p) => !apiMints.has(p.mint));
        const coinInfos = profile?.available ? await Promise.all(chainOnly.map((p) => fetchCoin(p.mint).catch(() => null))) : chainOnly.map(() => null);
        const viaApi = [];
        const viaChain = [];
        chainOnly.forEach((p, i) => {
          const c = coinInfos[i];
          if (!c || c.athMcapUsd == null) return viaChain.push(p);
          viaApi.push({ ...p, name: c.name, symbol: c.symbol, url: c.url, createdAt: p.createdAt || c.createdAt, athAt: c.athAt, peakMcapUsd: c.athMcapUsd, minutesToPeak: c.minutesToPeak, nowMcapUsd: c.nowMcapUsd, graduated: c.graduated, drawdown: c.athMcapUsd && c.nowMcapUsd != null ? 1 - c.nowMcapUsd / c.athMcapUsd : null, outcome: c.athMcapUsd >= 69_000 ? 'graduated' : c.athMcapUsd >= 25_000 ? 'fizzled' : 'rug', historyAvailable: true, source: 'pump.fun', dexId: c.graduated ? 'pumpswap' : 'pumpfun' });
        });
        const [analysed] = await Promise.all([
          analysePriorLaunches(hrpc, viaChain, cluster, sigLists, { supply: report.supply }),
          devExitsP,
          pMap(
            viaApi.slice(0, 6),
            async (l) => {
              try {
                l.clusterExit = await clusterExitOnLaunch(hrpc, l, cluster, sigLists, null, report.supply, solUsd);
              } catch {
                l.clusterExit = null;
              }
            },
            3,
          ),
        ]);
        const merged = [...apiLaunches, ...viaApi, ...analysed].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const rating = rateOperator(merged, {
          marketCapUsd: report.market?.marketCapUsd,
          supply: report.supply,
          profile,
        });
        report.operator = { ...report.operator, launches: merged, rating };
        if (profile?.available && profile.current?.athMcapUsd && report.market) report.market.athMcapUsd = profile.current.athMcapUsd;
      } else
        report.operator = {
          launches: [],
          rating: null,
          discovered: 0,
          disabled: true,
        };
      done('operator');
      report.score = rescore();
      emit('operator', report);
    } catch (e) {
      fail('operator', e);
    }
  };
  await Promise.all([liveStage(), operatorStage()]);
  if (aborted()) return report;

  // ---- score + memory ----
  begin('score');
  report.score = rescore();
  try {
    if (opts.memory && analysis) {
      await opts.memory.remember(report.mint, {
        creator,
        wallets: operatorWallets,
        createdAt: report.creation.createdAt,
        windowPct: analysis.window.pct,
        operatorScore: report.operator?.rating?.score ?? null,
      });
      if (opts.memory.noteRep) {
        const level = report.score?.call?.level || null;
        for (const b of analysis.buyers.filter((x) => x.kind === 'sniper').slice(0, 40)) await opts.memory.noteRep('sniper', b.wallet, report.mint, level);
        for (const f of (analysis.sharedFeeRecipients || []).slice(0, 10)) await opts.memory.noteRep('fee', f.address, report.mint, level);
        for (const w of linkers.slice(0, 10)) await opts.memory.noteRep('funder', w, report.mint, level);
        await opts.memory.noteRep('dev', creator, report.mint, level);
        if (analysis.fingerprints?.dominant?.wallets?.length >= 2) await opts.memory.noteRep('fp', analysis.fingerprints.dominant.key, report.mint, level);
      }
    }
  } catch (e) {
    log(`memory save failed: ${e.message}`);
  }
  report.finishedAt = Date.now();
  report.totalMs = report.finishedAt - t0;
  report.rpcCalls = rpc.totalCalls;
  done('score');
  emit('done', report);
  return report;
}
