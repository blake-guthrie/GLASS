// Stage 3: profile the launch wallets — age, pre-launch activity, funding source, generated-activity
// heuristics, and cross-wallet links (shared funder, funding time clusters, exchange diversity).
import { LAMPORTS_PER_SOL, PROGRAMS } from '../constants.js';
import { parseTx } from '../txparse.js';
import { pMap } from '../http.js';
import { fundingForWallet } from '../funding.js';

function stats(arr) {
  if (!arr.length) return { mean: 0, cv: null };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (arr.length < 3 || mean === 0) return { mean, cv: null };
  const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length);
  return { mean, cv: sd / mean };
}

/**
 * @param wallets  base58 addresses (already capped by the caller)
 * @param ctx      { launchTimeSec, creator, known: {exchanges}, buyersSet }
 */
export async function profileWallets(rpc, wallets, ctx, { onProgress } = {}) {
  const launchT = ctx.launchTimeSec;
  const sigLists = new Map(); // wallet → newest-first signature infos (reused by the operator stage)
  const historyFloor = typeof rpc.historyStart === 'function' ? await rpc.historyStart() : 0; // oldest slot this RPC still has

  const profiles = await pMap(
    wallets,
    async (wallet) => {
      const sigs = (await rpc.getSignaturesForAddress(wallet, { limit: 1000 })) || [];
      sigLists.set(wallet, sigs);
      const ordered = [...sigs].reverse(); // oldest first
      // "capped" = we did not see the wallet's real beginning: 1000-tx page limit, or the RPC pruned older history.
      const truncatedByRpc = historyFloor > 0 && ordered[0] && ordered[0].slot <= historyFloor;
      const capped = sigs.length >= 1000 || truncatedByRpc;
      const firstT = ordered[0]?.blockTime ?? null;
      const pre = ordered.filter((s) => s.blockTime != null && s.blockTime < launchT);
      const preGaps = [];
      for (let i = 1; i < pre.length; i++) preGaps.push(pre[i].blockTime - pre[i - 1].blockTime);
      const gapStats = stats(preGaps);

      const prof = {
        wallet,
        txCount: sigs.length,
        txCountCapped: capped,
        historyTruncated: truncatedByRpc,
        firstTxAt: firstT ? firstT * 1000 : null,
        ageHoursAtLaunch: firstT && !capped ? (launchT - firstT) / 3600 : capped ? null : 0,
        preLaunchTxs: pre.length,
        preLaunchWindowHours: pre.length > 1 ? (pre[pre.length - 1].blockTime - pre[0].blockTime) / 3600 : 0,
        gapCv: gapStats.cv,
        fundingSource: null,
        fundingMethod: null,
        fundingLabel: null,
        fundingKind: 'unknown',
        firstPayer: null,
        fundedAt: null,
        fundedSol: null,
        activityScore: null,
        programsSeen: [],
        flags: [],
      };

      // First observed receipts are not proof of a wallet's complete funding history.
      prof.fundingHistory = 'first-observed';
      prof.fundingHistoryIncomplete = capped || !ordered.length;
      let oldestInfos = !capped && ordered.length ? ordered.slice(0, 6) : null;
      let fundingRpc = rpc;
      // The free RPC pruned this wallet's beginning → page back on the archive endpoint (up to 2 pages)
      if (truncatedByRpc && sigs.length < 1000 && ctx.archive) {
        try {
          let before = ordered[0].signature;
          let page = null;
          for (let hop = 0; hop < 2; hop++) {
            page = (await ctx.archive.getSignaturesForAddress(wallet, { limit: 1000, before })) || [];
            if (!page.length) break;
            before = page[page.length - 1].signature;
            prof.txCount += page.length;
            if (page.length < 1000) break;
          }
          if (page && page.length && page.length < 1000) {
            const oldest = [...page].reverse();
            oldestInfos = oldest.slice(0, 6);
            fundingRpc = ctx.archive;
            prof.historyTruncated = false;
            prof.txCountCapped = false;
            prof.deepenedViaArchive = true;
            const f0 = oldest[0]?.blockTime ?? null;
            prof.firstTxAt = f0 ? f0 * 1000 : prof.firstTxAt;
            prof.ageHoursAtLaunch = f0 ? (launchT - f0) / 3600 : prof.ageHoursAtLaunch;
            prof.preLaunchTxs += oldest.filter((x) => x.blockTime != null && x.blockTime < launchT).length;
          } else if (page && page.length >= 1000) prof.txCountCapped = true; // 2000+ older txs: heavy wallet
        } catch {
          /* archive unavailable: stay truncated */
        }
      }
      if (oldestInfos) {
        const oldestRaws = await fundingRpc.getTransactions(oldestInfos.map((s) => s.signature));
        let missing = oldestRaws.length !== oldestInfos.length;
        for (let i = 0; i < oldestInfos.length; i++) {
          const rec = parseTx(oldestRaws[i], oldestInfos[i].signature);
          if (!rec) { missing = true; continue; }
          if (rec.err) { if (i === 0) prof.fundingHistoryIncomplete = true; continue; }
          if (i === 0 && (rec.fundingProvenance.preBalances[wallet] == null || rec.fundingProvenance.preBalances[wallet] > 0 ||
            oldestRaws[i].meta.preTokenBalances?.some(b => b.owner === wallet && Number(b.uiTokenAmount?.amount) > 0))) prof.fundingHistoryIncomplete = true;
          if (rec.feePayer && rec.feePayer !== wallet && !prof.firstPayer) prof.firstPayer = rec.feePayer;
          const evidence = fundingForWallet(rec, wallet);
          if (!evidence) continue;
          prof.fundingEvidence = evidence;
          prof.fundingTx = rec.sig;
          prof.fundedAt = rec.blockTime != null ? rec.blockTime * 1000 : null;
          const external = evidence.components.filter(c => ['sol-transfer', 'external-wsol', 'token-transfer'].includes(c.kind) && c.source && c.source !== wallet);
          const sources = [...new Set(external.map(c => c.source))];
          // Only an evidenced external transfer can create a funding-source edge. Sponsors remain
          // explicit receipt components, even when they also paid transaction fees.
          prof.fundingSource = sources.length === 1 ? sources[0] : null;
          const swap = evidence.components.some(c => c.kind === 'swap-proceeds');
          prof.fundingMethod = swap ? 'swap-proceeds' : external.length ?
            (external.some(c => c.kind === 'sol-transfer') ? 'transfer' : external.some(c => c.kind === 'external-wsol') ? 'wsol-close' : 'token-transfer') :
            evidence.components.some(c => c.kind.startsWith('unknown-')) ? 'unknown' :
            evidence.components.some(c => c.kind === 'self-unwrap') ? 'self-unwrap' :
            evidence.components.some(c => c.kind === 'account-rent') ? 'rent-return' : 'unknown';
          prof.fundedSol = external.some(c => c.lamports != null) ? external.reduce((sum, c) => sum + (c.lamports || 0), 0) / LAMPORTS_PER_SOL : null;
          prof.fundingNote = swap ? 'Observed Jupiter swap proceeds; account rent is shown separately. Earlier funding is unknown.' :
            prof.fundingMethod === 'self-unwrap' ? 'Observed own WSOL unwrapped; earlier source and rent depositor may be unknown.' :
            prof.fundingMethod === 'rent-return' ? 'Observed account-rent return; this does not establish the source of trading capital.' :
            external.length ? 'Observed external transfer; earlier history is not established.' :
            'Observed SOL movement has incomplete provenance; fee payer is not assumed to be its source.';
          break;
        }
        if (missing) {
          prof.fundingHistoryIncomplete = true;
          prof.flags.push('one or more early transaction bodies unavailable');
        }
        if (!prof.fundingNote) prof.fundingNote = 'No incoming funding identified in the sampled transactions; earlier funding is unknown.';
      } else if (capped && !truncatedByRpc) prof.fundingNote = '1000+ transactions — beginning not reached';
      else if (truncatedByRpc) prof.fundingNote = ctx.archive ? 'older than the archive RPC keeps' : 'older than this RPC keeps';

      prof.firstObservedAgeHours = prof.ageHoursAtLaunch;
      if (prof.fundingHistoryIncomplete) prof.ageHoursAtLaunch = null;

      // Generated-activity sample: up to 8 pre-launch txs → program diversity & SOL moved
      if (pre.length) {
        const sampleSigs = pre.slice(0, 4).concat(pre.slice(-4)).map((s) => s.signature);
        const uniq = [...new Set(sampleSigs)];
        const raws = await rpc.getTransactions(uniq);
        const programs = new Map();
        let tinyMoves = 0;
        let n = 0;
        for (let i = 0; i < raws.length; i++) {
          const rec = parseTx(raws[i], uniq[i]);
          if (!rec || rec.err) continue;
          n++;
          for (const p of rec.programs) if (![PROGRAMS.SYSTEM, PROGRAMS.ATA, PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022].includes(p)) programs.set(p, (programs.get(p) || 0) + 1);
          const moved = Math.abs(rec.solDelta[wallet] || 0) / LAMPORTS_PER_SOL;
          if (moved < 0.02) tinyMoves++;
        }
        prof.programsSeen = [...programs.keys()];
        const diversity = n ? programs.size / n : 0; // 1 = every tx a different program, ~0 = same program
        const tinyShare = n ? tinyMoves / n : 0;
        const regular = prof.gapCv != null && prof.gapCv < 0.35 ? 1 : prof.gapCv != null && prof.gapCv < 0.7 ? 0.5 : 0;
        // Higher = more likely scripted warm-up activity
        prof.activityScore = Math.min(1, 0.4 * (1 - Math.min(1, diversity * 2)) + 0.3 * tinyShare + 0.3 * regular);
        if (prof.activityScore >= 0.6 && pre.length >= 3) prof.flags.push('generated-looking pre-launch activity');
      }

      if (prof.historyTruncated) prof.flags.push('older than this RPC\'s history — age and funding unknown');
      if (prof.ageHoursAtLaunch != null && prof.ageHoursAtLaunch < 1) prof.flags.push('first observed transaction <1h before launch');
      else if (prof.ageHoursAtLaunch != null && prof.ageHoursAtLaunch >= 24 && prof.ageHoursAtLaunch <= 72 && pre.length <= 12) prof.flags.push('aged 24–72h with light activity (warm-up pattern)');
      if (pre.length === 0 && !capped) prof.flags.push('no pre-launch transactions in the returned history');
      onProgress?.();
      return prof;
    },
    4,
  );

  // Classify funding sources
  const known = ctx.known?.exchanges || {};
  const buyersSet = new Set([...(ctx.buyersSet || []), ctx.creator].filter(Boolean));
  const sources = [...new Set(profiles.map((p) => p?.fundingSource).filter(Boolean))];
  const sourceInfo = new Map();
  await pMap(
    sources,
    async (src) => {
      if (known[src]) return sourceInfo.set(src, { kind: 'exchange', label: known[src] });
      if (buyersSet.has(src)) return sourceInfo.set(src, { kind: 'linked', label: 'another launch wallet' });
      const inWallets = profiles.filter((p) => p?.fundingSource === src).length;
      // Activity probe: ≥1000 txs in <2 days is exchange- or infrastructure-like.
      try {
        const s = await rpc.getSignaturesForAddress(src, { limit: 1000 });
        const span = s.length ? (s[0].blockTime - s[s.length - 1].blockTime) / 3600 : 0;
        const busy = s.length >= 1000 && span < 48;
        // One source feeding several launch wallets is an operator funder, however busy it is.
        if (inWallets >= 2) return sourceInfo.set(src, { kind: 'shared-funder', highVolume: busy, label: `shared funder (${inWallets} wallets)${busy ? ` · 1000+ txs in ${span.toFixed(1)}h — launch-tool funding infrastructure` : ''}` });
        if (busy) return sourceInfo.set(src, { kind: 'high-volume', label: 'high-volume source (exchange-like)' });
        return sourceInfo.set(src, { kind: 'wallet', label: 'ordinary wallet' });
      } catch {
        return sourceInfo.set(src, { kind: inWallets >= 2 ? 'shared-funder' : 'unknown', label: inWallets >= 2 ? `shared funder (${inWallets} wallets)` : 'unknown' });
      }
    },
    4,
  );
  for (const p of profiles) {
    if (!p || p.error) continue;
    const info = p.fundingSource ? sourceInfo.get(p.fundingSource) : null;
    if (info) {
      p.fundingKind = info.kind;
      p.fundingLabel = info.label;
      if (info.kind === 'linked' || info.kind === 'shared-funder') p.flags.push(`funded by ${info.label}`);
    }
    p.kind = classifyKind(p, ctx.launchBuyers?.get(p.wallet));
    if (p.kind === 'sniper') p.flags.unshift('high-volume sniper/bot wallet');
  }

  const good = profiles.filter((p) => p && !p.error);
  return { profiles: good, summary: summarise(good, sourceInfo), sigLists };
}

/**
 * sniper  — high-volume trading wallet/bot that snipes every launch (not operator-controlled)
 * bundle  — low-history / fresh / warmed-up wallet that fits a launch-tool allocation
 * organic — older wallet with a normal history
 */
export function classifyKind(prof, buyer) {
  const heavy = (prof.txCountCapped && !prof.historyTruncated) || prof.preLaunchTxs >= 150;
  if (heavy) return 'sniper';
  if (prof.historyTruncated || prof.fundingHistoryIncomplete) {
    // We can't see its beginning: only call it a bundle wallet on positive evidence.
    const linked = prof.fundingKind === 'linked' || prof.fundingKind === 'shared-funder';
    const warmed = prof.activityScore != null && prof.activityScore >= 0.6;
    return linked || warmed ? 'bundle' : prof.preLaunchTxs >= 60 ? 'sniper' : 'organic';
  }
  const linked = prof.fundingKind === 'linked' || prof.fundingKind === 'shared-funder';
  const young = prof.ageHoursAtLaunch != null && prof.ageHoursAtLaunch < 7 * 24;
  const light = prof.preLaunchTxs <= 40;
  const warmed = prof.activityScore != null && prof.activityScore >= 0.6;
  if (linked || warmed || (young && light) || prof.preLaunchTxs === 0) return 'bundle';
  // Mid-history wallet that used a Jito tip and bought in slot 0 is still bot-like
  if (buyer && buyer.firstSlotOffset === 0 && buyer.tip > 0 && prof.preLaunchTxs >= 60) return 'sniper';
  return 'organic';
}

function summarise(profiles, sourceInfo) {
  const n = profiles.length;
  if (!n) return { walletsProfiled: 0 };
  const kindCounts = {};
  for (const p of profiles) kindCounts[p.kind] = (kindCounts[p.kind] || 0) + 1;
  const kinds = {};
  for (const p of profiles) kinds[p.fundingKind] = (kinds[p.fundingKind] || 0) + 1;
  const fundingMethods = {};
  const rentSponsors = new Map();
  for (const p of profiles) {
    fundingMethods[p.fundingMethod || 'unknown'] = (fundingMethods[p.fundingMethod || 'unknown'] || 0) + 1;
    for (const c of p.fundingEvidence?.components || []) if (c.kind === 'account-rent' && c.source && c.source !== p.wallet) {
      if (!rentSponsors.has(c.source)) rentSponsors.set(c.source, { address: c.source, wallets: [], lamports: 0, operatorLink: false });
      const row = rentSponsors.get(c.source);
      if (!row.wallets.includes(p.wallet)) row.wallets.push(p.wallet);
      row.lamports += c.lamports;
    }
  }
  const exchanges = new Set(profiles.filter((p) => p.fundingKind === 'exchange').map((p) => p.fundingLabel));
  const sharedFunders = [...sourceInfo.entries()].filter(([, i]) => i.kind === 'shared-funder' || i.kind === 'linked').map(([a, i]) => ({ address: a, label: i.label }));
  const payerCounts = new Map();
  for (const p of profiles) if (p.firstPayer) payerCounts.set(p.firstPayer, (payerCounts.get(p.firstPayer) || 0) + 1);
  const sharedPayers = [...payerCounts.entries()].filter(([, n]) => n >= 2).map(([address, count]) => ({ address, count, operatorLink: false })).sort((a, b) => b.count - a.count);
  const wsolFunded = profiles.filter((p) => p.fundingMethod === 'wsol-close').length;

  // Funding-time clustering: largest group funded within the same 60-minute window
  const times = profiles.filter(p => p.fundingSource).map((p) => p.fundedAt).filter(Boolean).sort((a, b) => a - b);
  let bestCluster = 0;
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j < times.length && times[j] - times[i] <= 60 * 60 * 1000) j++;
    bestCluster = Math.max(bestCluster, j - i);
  }
  const ages = profiles.map((p) => p.ageHoursAtLaunch).filter((x) => x != null);
  const agesSorted = [...ages].sort((a, b) => a - b);
  const medianAge = agesSorted.length ? agesSorted[Math.floor(agesSorted.length / 2)] : null;
  const generated = profiles.filter((p) => p.activityScore != null && p.activityScore >= 0.6).length;
  const fresh = profiles.filter((p) => p.preLaunchTxs === 0 && !p.txCountCapped && !p.fundingHistoryIncomplete).length;
  const fundedSol = profiles.filter(p => p.fundingSource).map((p) => p.fundedSol).filter((x) => x != null);
  const roundish = fundedSol.filter((x) => Math.abs(x * 10 - Math.round(x * 10)) < 0.011).length;

  const reasons = [];
  if (kindCounts.sniper) reasons.push(`${kindCounts.sniper} launch buyer(s) are high-volume sniper bots, not operator wallets`);
  if (bestCluster >= 3 && bestCluster / Math.max(1, times.length) >= 0.5) reasons.push(`${bestCluster} of ${times.length} wallets were funded within the same hour`);
  if (exchanges.size >= 2 && kinds.exchange >= 3) reasons.push(`funded from ${exchanges.size} different exchanges (${[...exchanges].join(', ')}) — classic transfer-graph evasion`);
  if (generated >= 3) reasons.push(`${generated} wallets show scripted-looking warm-up activity`);
  if (fresh >= 3) reasons.push(`${fresh} wallets had no history before the launch buy`);
  if (medianAge != null && medianAge >= 24 && medianAge <= 96) reasons.push(`median wallet age ${Math.round(medianAge)}h (aged, not organic-old)`);
  if (sharedFunders.length) reasons.push(`${sharedFunders.length} shared funder(s) link wallets directly`);
  const observations = sharedPayers.length ? [`${sharedPayers[0].count} wallets share an observed fee payer; sponsorship alone does not establish common ownership.`] : [];
  if (wsolFunded) observations.push(`${wsolFunded} wallets received evidenced external WSOL; close authority and rent are recorded separately.`);
  if (roundish >= 3 && roundish / fundedSol.length >= 0.6) reasons.push('wallets funded with round SOL amounts');

  // The sniper reason is informational; links are scored on the remaining reasons.
  const linkReasons = reasons.filter((r) => !r.includes('sniper bots'));
  return {
    walletsProfiled: n,
    kinds: kindCounts,
    fundingKinds: kinds,
    fundingMethods,
    rentSponsors: [...rentSponsors.values()],
    exchangesUsed: [...exchanges],
    sharedFunders,
    sharedPayers,
    wsolFunded,
    observations,
    fundingTimeClusterMax: bestCluster,
    medianAgeHours: medianAge,
    generatedActivityWallets: generated,
    freshWallets: fresh,
    reasons,
    behaviouralLinkScore: Math.min(1, linkReasons.length / 4),
  };
}
