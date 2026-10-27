// Stage 5: the operator behind the cluster — their previous launches, how far those ran, when the
// cluster dumped, a bullish/bearish bundle rating, and a historical exit zone for this launch.
import { parseTx } from '../txparse.js';
import { pMap } from '../http.js';
import { dexTokensBulk, priceHistory, solPriceUsd } from '../market.js';
import { derivePumpAccounts } from './launch.js';
import { PUMP_TOTAL_SUPPLY, PROGRAMS } from '../constants.js';

const GRADUATION_MCAP = 69_000;

function pct(a, b) {
  return b ? (a / b) * 100 : null;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = (arr) => quantile([...arr].sort((a, b) => a - b), 0.5);

/**
 * Discover launches this cluster was involved in before (and after) the current one.
 * @param cluster   { creator, wallets: [addresses] }
 * @param sigLists  Map wallet → newest-first signature infos (from the wallet stage; creator may be missing)
 * @param memory    { getWalletLaunches(wallet) → [{mint, createdAt, role}] } optional local DB
 */
export async function discoverPriorLaunches(rpc, mint, cluster, sigLists, { memory, maxWallets = 12, txsPerWallet = 40, maxCandidates = 14, onProgress, log = () => {} } = {}) {
  const wallets = [cluster.creator, ...cluster.wallets.filter((w) => w !== cluster.creator)].slice(0, maxWallets + 1);
  const candidates = new Map(); // mint → {mint, wallets:Set, roles:Set, evidence:[]}
  const fundedBy = new Map(); // funder wallet → Set(wallets it funded) seen in the sample
  const add = (m, wallet, role, extra = {}) => {
    if (!m || m === mint) return;
    const c = candidates.get(m) || { mint: m, wallets: new Set(), roles: new Set(), buys: [], creates: [], fromMemory: false };
    c.wallets.add(wallet);
    c.roles.add(role);
    if (extra.fromMemory) c.fromMemory = true;
    if (role === 'buyer' || role === 'payer' || role === 'funded') c.buys.push({ wallet, ...extra });
    if (role === 'creator') c.creates.push({ wallet, ...extra });
    candidates.set(m, c);
  };

  // Local memory first (free)
  if (memory) {
    for (const w of wallets) {
      const prev = await memory.getWalletLaunches(w).catch(() => []);
      for (const p of prev || []) add(p.mint, w, p.role || 'buyer', { slot: p.slot, t: p.createdAt, fromMemory: true });
    }
  }

  // On-chain: sample each wallet's transactions for pump.fun creates and buys of other mints
  await pMap(
    wallets,
    async (w) => {
      let sigs = sigLists.get(w);
      if (!sigs) {
        sigs = (await rpc.getSignaturesForAddress(w, { limit: 1000 })) || [];
        sigLists.set(w, sigs);
      }
      const ok = sigs.filter((s) => !s.err);
      // newest first; take an even spread so we see both recent and older launches
      const step = Math.max(1, Math.floor(ok.length / txsPerWallet));
      const picked = [];
      for (let i = 0; i < ok.length && picked.length < txsPerWallet; i += step) picked.push(ok[i]);
      const raws = await rpc.getTransactions(picked.map((s) => s.signature));
      raws.forEach((raw, i) => {
        const rec = parseTx(raw, picked[i].signature);
        if (!rec || rec.err) return;
        const t = rec.blockTime ? rec.blockTime * 1000 : null;
        const seenTrade = new Set();
        // Program events are authoritative (cover every buy/sell variant and router-wrapped trades)
        for (const e of rec.pumpEvents || []) {
          if (e.type === 'create' && e.mint) add(e.mint, w, e.creator === w || e.user === w ? 'creator' : 'buyer', { slot: rec.slot, t, sig: rec.sig });
          if (e.type === 'trade' && (e.user === w || rec.feePayer === w)) {
            seenTrade.add(e.mint);
            // A wallet paying fees for someone else's buy is the operator's funder/payer → same cluster
            add(e.mint, w, e.isBuy ? (e.user === w ? 'buyer' : 'payer') : 'seller', { slot: rec.slot, t, sig: rec.sig, tokens: e.tokenAmount, sol: e.quoteAmount, priceQuote: e.priceQuote, forUser: e.user });
          }
        }
        for (const p of rec.pumpIxs) {
          if (p.kind === 'create') add(p.mint, w, 'creator', { slot: rec.slot, t, sig: rec.sig });
          else if ((p.kind === 'buy' || p.kind === 'sell') && p.mint && !seenTrade.has(p.mint)) add(p.mint, w, p.kind === 'buy' ? 'buyer' : 'seller', { slot: rec.slot, t, sig: rec.sig, tokens: p.tokenAmount });
        }
        // Funding activity (system transfers out, WSOL accounts closed into other wallets)
        if (rec.feePayer === w) {
          const set = fundedBy.get(w) || fundedBy.set(w, new Set()).get(w);
          for (const c of rec.closeAccounts || []) if (c.destination && c.destination !== w) set.add(c.destination);
          for (const tr of rec.systemTransfers || []) if (!tr.inner && tr.from === w && tr.to && tr.to !== w && tr.lamports >= 0.05e9) set.add(tr.to);
        }
      });
      onProgress?.();
    },
    3,
  );

  // Funder hop: a linked wallet that only *funds* (no pump trades, many funded destinations) is launch-tool
  // or operator infrastructure. Its history is in the wallets it funded → sample those.
  const funderHops = [];
  for (const [funder, set] of fundedBy) {
    const hasTrades = [...candidates.values()].some((c) => c.wallets.has(funder));
    if (hasTrades || set.size < 4) continue;
    const targets = [...set].filter((x) => !wallets.includes(x)).slice(0, 8);
    funderHops.push({ funder, funded: set.size, sampled: targets.length });
    await pMap(
      targets,
      async (fw) => {
        let sigs = sigLists.get(fw);
        if (!sigs) {
          sigs = (await rpc.getSignaturesForAddress(fw, { limit: 200 })) || [];
          sigLists.set(fw, sigs);
        }
        const ok = sigs.filter((x) => !x.err).slice(0, 15);
        const raws = await rpc.getTransactions(ok.map((x) => x.signature));
        raws.forEach((raw, i) => {
          const rec = parseTx(raw, ok[i].signature);
          if (!rec || rec.err) return;
          const t = rec.blockTime ? rec.blockTime * 1000 : null;
          for (const e of rec.pumpEvents || []) {
            if (e.type === 'trade' && e.user === fw && e.isBuy) add(e.mint, fw, 'funded', { slot: rec.slot, t, sig: rec.sig, tokens: e.tokenAmount, sol: e.quoteAmount, priceQuote: e.priceQuote, via: funder });
            if (e.type === 'create') add(e.mint, fw, 'creator', { slot: rec.slot, t, sig: rec.sig, via: funder });
          }
        });
      },
      3,
    );
  }

  // Rank candidates: created by cluster > paid/funded by the operator's infra > bought by ≥2 cluster
  // wallets > remembered from an earlier scan > bought by the creator alone.
  const ranked = [...candidates.values()]
    .map((c) => ({ ...c, wallets: [...c.wallets], roles: [...c.roles] }))
    .filter((c) => c.roles.includes('creator') || c.roles.includes('payer') || c.roles.includes('funded') || c.fromMemory || c.wallets.length >= 2 || (c.wallets.length === 1 && c.wallets[0] === cluster.creator))
    .sort((a, b) => (b.roles.includes('creator') ? 1 : 0) - (a.roles.includes('creator') ? 1 : 0) || b.wallets.length - a.wallets.length)
    .slice(0, maxCandidates);

  // Verify: creation slot per candidate, then check whether the cluster's buys were in the launch window
  const verified = await pMap(
    ranked,
    async (c) => {
      let createdSlot = null;
      let createdAt = null;
      let creator = null;
      const cr = c.creates[0];
      if (cr) {
        createdSlot = cr.slot;
        createdAt = cr.t;
        creator = cr.wallet;
      } else {
        const found = await creationSlotCheap(rpc, c.mint);
        if (found && !found.truncated) ({ createdSlot, createdAt, creator } = found);
      }
      const launchBuys = c.buys.filter((b) => createdSlot != null && b.slot - createdSlot <= 3);
      const clusterCreated = creator && (creator === cluster.creator || cluster.wallets.includes(creator));
      const viaInfra = c.roles.includes('payer') || c.roles.includes('funded');
      const rel = clusterCreated ? 'created' : launchBuys.length >= 1 ? 'bundled' : viaInfra && c.buys.length ? 'bundled' : c.fromMemory ? 'bundled' : c.wallets.length >= 2 ? 'traded' : 'unrelated';
      log(`candidate ${c.mint.slice(0, 6)}… relation=${rel} buyers=${c.wallets.length}${viaInfra ? ' via-infra' : ''}`);
      // Human-readable evidence: which wallet of *this* cluster connects to that launch, and how.
      const linkedBy = [];
      if (clusterCreated) linkedBy.push({ wallet: creator, how: creator === cluster.creator ? 'this token\'s creator wallet also created it' : 'a wallet from this launch cluster created it' });
      const seen = new Set();
      const roleOf = (w) => (w === cluster.creator ? 'the creator' : (cluster.linkers || []).includes(w) ? 'a funder of the launch buyers' : 'a launch-window buyer');
      // Group identical links so the panel reads "3 funder wallets bought it in its launch window" instead of
      // one sentence per wallet.
      const groups = new Map();
      for (const b of c.buys) {
        if (seen.has(b.wallet)) continue;
        seen.add(b.wallet);
        const off = createdSlot != null && b.slot != null ? b.slot - createdSlot : null;
        const when = off == null ? '' : off <= 3 ? ' in its launch window' : ` ${off} slots after launch`;
        const role = roleOf(b.wallet);
        let key;
        if (b.forUser && b.forUser !== b.wallet) key = `${role} paid the fees for a buy of it${when}`;
        else if (b.via) key = `wallet funded by ${roleOf(b.via)} bought it${when}`;
        else if (b.fromMemory) key = `${role} was a launch-window buyer (earlier GLASS scan)`;
        else key = `${role} bought it${when}`;
        const g = groups.get(key) || { key, wallets: [] };
        g.wallets.push(b.wallet);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const n = g.wallets.length;
        const how = n === 1 ? g.key : g.key.replace(/^(the creator|a funder of the launch buyers|a launch-window buyer|wallet funded by [^ ]+( [^ ]+)*?)(?= (paid|bought|was))/, (m) => (m.startsWith('a funder') ? `${n} funder wallets` : m.startsWith('a launch') ? `${n} launch-window buyers` : m.startsWith('wallet funded') ? `${n} wallets funded by the same funder` : m));
        linkedBy.push({ wallet: g.wallets[0], wallets: g.wallets, how });
      }
      return { mint: c.mint, createdSlot, createdAt, creator, relation: rel, clusterWallets: c.wallets, launchBuyers: [...new Set(launchBuys.map((b) => b.wallet))], buys: c.buys, sells: [], viaInfra, linkedBy };
    },
    3,
  );
  const out = verified.filter((v) => v && !v.error && (v.relation === 'created' || v.relation === 'bundled')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  out.funderHops = funderHops;
  return out;
}

/**
 * Cheap creation lookup for a candidate mint: the bonding curve's oldest signature (one call for
 * anything under 1000 curve txs), falling back to the Metaplex metadata PDA for legacy tokens.
 */
async function creationSlotCheap(rpc, mint) {
  try {
    const { bondingCurve, metadata } = await derivePumpAccounts(mint);
    const floor = typeof rpc.historyStart === 'function' ? await rpc.historyStart() : 0;
    let sigs = await rpc.getSignaturesForAddress(bondingCurve, { limit: 1000 });
    let oldest = null;
    if (sigs?.length && sigs.length < 1000) oldest = sigs[sigs.length - 1];
    else {
      const m = await rpc.getSignaturesForAddress(metadata, { limit: 1000 });
      if (m?.length) oldest = m[m.length - 1];
    }
    if (!oldest) return null;
    if (floor > 0 && oldest.slot <= floor) return { createdSlot: null, createdAt: null, creator: null, truncated: true }; // older than this RPC remembers
    const raw = await rpc.getTransaction(oldest.signature);
    const rec = parseTx(raw, oldest.signature);
    return { createdSlot: oldest.slot, createdAt: oldest.blockTime ? oldest.blockTime * 1000 : null, creator: rec?.feePayer || null };
  } catch {
    return null;
  }
}

/** Pull outcome + cluster exit behaviour for each prior launch. */
export async function analysePriorLaunches(rpc, launches, cluster, sigLists, { supply = PUMP_TOTAL_SUPPLY, maxDeep = 8, onProgress } = {}) {
  if (!launches.length) return [];
  const [dex, solUsd] = await Promise.all([dexTokensBulk(launches.map((l) => l.mint)), solPriceUsd()]);
  const out = await pMap(
    launches,
    async (l, idx) => {
      const d = dex[l.mint];
      if (!l.createdAt && d?.pairCreatedAt) l.createdAt = d.pairCreatedAt; // creation older than the RPC's history → DexScreener's timestamp
      let hist = await priceHistory(l.mint, { supply, createdAtMs: l.createdAt || undefined });
      // Cluster exit on that launch: sample the cluster wallets' sells of that mint
      let exit = null;
      if (idx < maxDeep) exit = await clusterExitOnLaunch(rpc, l, cluster, sigLists, hist, supply, solUsd);
      // No candles yet (coin minutes old, or never indexed) → reconstruct from chain: the bonding curve's
      // reserves give mcap now; the highest post-trade price in the cluster's own trades bounds the peak.
      let onchain = null;
      if (!hist.available) onchain = await onchainOutcome(rpc, l, exit, supply, solUsd);
      const graduated = (d && d.dexId && d.dexId !== 'pumpfun') || (hist.available && hist.peakMcapUsd >= GRADUATION_MCAP * 1.15);
      const peak = hist.available ? hist.peakMcapUsd : onchain?.peakMcapUsd ?? d?.marketCapUsd ?? null;
      const now = d?.marketCapUsd ?? (hist.available ? hist.lastMcapUsd : onchain?.nowMcapUsd ?? null);
      onProgress?.();
      const outcome = classifyOutcome({ peak, now, graduated, hist });
      return {
        ...l,
        name: d?.name || null,
        symbol: d?.symbol || null,
        dexId: d?.dexId || null,
        url: d?.url || `https://dexscreener.com/solana/${l.mint}`,
        peakMcapUsd: peak,
        minutesToPeak: hist.available ? hist.minutesToPeak : null,
        nowMcapUsd: now,
        liquidityUsd: d?.liquidityUsd ?? null,
        graduated: !!graduated,
        drawdown: peak && now != null ? 1 - now / peak : null,
        checkpoints: hist.available ? hist.checkpoints : null,
        launchMcapUsd: hist.available ? hist.firstMcapUsd : null,
        volumeUsd: hist.available ? hist.totalVolumeUsd : d?.volume24h ?? null,
        outcome,
        clusterExit: exit,
        historyAvailable: hist.available,
        source: hist.available ? 'candles' : onchain ? 'on-chain' : d ? 'dexscreener' : 'none',
        tradesSeen: onchain?.trades ?? null,
      };
    },
    3,
  );
  return out.filter((x) => x && !x.error);
}

/**
 * Outcome from chain alone: current mcap from the pump.fun bonding curve's virtual reserves, and the
 * peak as the highest price seen across the trades we read (the cluster's sells + a sample of the
 * curve's recent trades). Lower bound on the real peak, but good enough to rank a serial launcher.
 */
async function onchainOutcome(rpc, launch, exit, supply, solUsd) {
  if (!solUsd) return null;
  try {
    const { bondingCurve } = await derivePumpAccounts(launch.mint);
    const sigs = (await rpc.getSignaturesForAddress(bondingCurve, { limit: 60 })) || [];
    const ok = sigs.filter((s) => !s.err);
    if (!ok.length) return null;
    const pick = [...ok.slice(0, 12), ...ok.slice(-12)];
    const uniq = [...new Map(pick.map((s) => [s.signature, s])).values()];
    const raws = await rpc.getTransactions(uniq.map((s) => s.signature));
    let peakQuote = 0;
    let lastQuote = null;
    let lastT = 0;
    let trades = 0;
    raws.forEach((raw, i) => {
      const rec = parseTx(raw, uniq[i].signature);
      if (!rec || rec.err) return;
      for (const e of rec.pumpEvents || []) {
        if (e.type !== 'trade' || e.mint !== launch.mint || !e.priceQuote) continue;
        trades++;
        if (e.priceQuote > peakQuote) peakQuote = e.priceQuote;
        if ((rec.blockTime || 0) >= lastT) {
          lastT = rec.blockTime || 0;
          lastQuote = e.priceQuote;
        }
      }
    });
    for (const s of exit?.sellsDetail || []) if (s.priceQuote > peakQuote) peakQuote = s.priceQuote;
    if (!peakQuote) return null;
    const rate = launch.isUsdQuoted ? 1 : solUsd;
    return { peakMcapUsd: peakQuote * supply * rate, nowMcapUsd: lastQuote ? lastQuote * supply * rate : null, trades };
  } catch {
    return null;
  }
}

function classifyOutcome({ peak, now, graduated, hist }) {
  if (peak == null) return 'unknown';
  const alive = now != null && peak > 0 && now / peak >= 0.3;
  if (peak >= 1_000_000) return alive ? 'moon-alive' : 'moon';
  if (peak >= 250_000) return alive ? 'runner-alive' : 'runner';
  if (graduated || peak >= GRADUATION_MCAP) return alive ? 'graduated-alive' : 'graduated';
  if (peak >= 25_000) return 'fizzled';
  return 'rug';
}

/**
 * When did the *dev wallet* first sell a prior launch? Read from the dev's token account for that mint
 * (exact, 1–2 requests), so it works for farm wallets with thousands of unrelated transactions.
 */
export async function devExitOnLaunch(rpc, creator, launch, supply, solUsd, { tokenProgram = PROGRAMS.TOKEN } = {}) {
  const createdSec = launch.createdAt ? launch.createdAt / 1000 : null;
  try {
    const ata = await rpc.ataFor(creator, launch.mint, tokenProgram);
    const sigs = ((await rpc.getSignaturesForAddress(ata, { limit: 30 })) || []).filter((s) => !s.err);
    if (!sigs.length) return { sampledTxs: 0, sells: 0, firstSellMin: null, note: 'no token account activity visible (older than this RPC keeps, or never traded)' };
    const ordered = [...sigs].reverse(); // oldest first
    const raws = await rpc.getTransactions(ordered.map((s) => s.signature));
    const sells = [];
    let bought = 0;
    raws.forEach((raw, i) => {
      const rec = parseTx(raw, ordered[i].signature);
      if (!rec || rec.err) return;
      for (const e of rec.pumpEvents || []) {
        if (e.type !== 'trade' || e.mint !== launch.mint || e.user !== creator) continue;
        if (e.isBuy) bought += e.tokenAmount;
        else sells.push({ t: rec.blockTime * 1000, tokens: e.tokenAmount, sol: e.quoteAmount, priceQuote: e.priceQuote, minutes: createdSec ? (rec.blockTime - createdSec) / 60 : null });
      }
      if (!(rec.pumpEvents || []).length) {
        const td = rec.tokenDeltas?.find((d) => d.mint === launch.mint && d.owner === creator && d.delta < 0);
        if (td) sells.push({ t: rec.blockTime * 1000, tokens: -td.delta, sol: Math.max(0, (rec.solDelta[creator] || 0) / 1e9), priceQuote: null, minutes: createdSec ? (rec.blockTime - createdSec) / 60 : null });
      }
    });
    if (!sells.length) return { sampledTxs: ordered.length, sells: 0, firstSellMin: null, soldPct: 0, note: bought ? 'dev still holds (no sell in the token account history)' : 'no dev sell found' };
    sells.sort((a, b) => a.t - b.t);
    const first = sells[0];
    const soldTokens = sells.reduce((a, x) => a + x.tokens, 0);
    const rate = first.quoteIsUsd || launch.isUsdQuoted ? 1 : solUsd;
    const mcapAt = first.priceQuote && rate ? first.priceQuote * supply * rate : null;
    const peakRef = launch.peakMcapUsd || null;
    return {
      sampledTxs: ordered.length,
      sells: sells.length,
      sellsDetail: sells.slice(0, 20).map((x) => ({ t: x.t, priceQuote: x.priceQuote || null, minutes: x.minutes })),
      firstSellMin: first.minutes != null ? Math.round(first.minutes) : null,
      firstSellSec: first.minutes != null ? Math.round(first.minutes * 60) : null,
      soldPct: pct(soldTokens, supply),
      soldShare: bought ? Math.min(1, soldTokens / bought) : null,
      soldWithin10MinPct: pct(sells.filter((x) => x.minutes != null && x.minutes <= 10).reduce((a, x) => a + x.tokens, 0), supply),
      mcapAtFirstSellUsd: mcapAt,
      soldBeforePeak: launch.athAt ? first.t < launch.athAt : null,
      peakShareAtFirstSell: mcapAt && peakRef ? mcapAt / peakRef : null,
      solOut: sells.reduce((a, x) => a + (x.sol || 0), 0),
      who: 'dev',
    };
  } catch (e) {
    return { sampledTxs: 0, sells: 0, firstSellMin: null, note: `lookup failed: ${e.message}` };
  }
}

/** Sample the cluster's sells of a prior launch to see when/at what mcap they exited. */
export async function clusterExitOnLaunch(rpc, launch, cluster, sigLists, hist, supply, solUsd) {
  const wallets = [launch.creator, ...launch.launchBuyers, ...launch.clusterWallets].filter(Boolean);
  const uniq = [...new Set(wallets)].slice(0, 8);
  const createdSec = launch.createdAt ? launch.createdAt / 1000 : null;
  const sells = [];
  let sampled = 0;
  for (const w of uniq) {
    let sigs = sigLists.get(w);
    if (!sigs) {
      try {
        sigs = (await rpc.getSignaturesForAddress(w, { limit: 1000 })) || [];
        sigLists.set(w, sigs);
      } catch {
        continue;
      }
    }
    // txs in the 6 hours after that launch (where the sell usually is)
    const win = sigs.filter((s) => !s.err && createdSec && s.blockTime >= createdSec && s.blockTime <= createdSec + 6 * 3600).slice(-25);
    if (!win.length) continue;
    const raws = await rpc.getTransactions(win.map((s) => s.signature));
    raws.forEach((raw, i) => {
      const rec = parseTx(raw, win[i].signature);
      if (!rec || rec.err) return;
      sampled++;
      const ev = (rec.pumpEvents || []).find((e) => e.type === 'trade' && e.mint === launch.mint && e.user === w && !e.isBuy);
      if (ev) {
        sells.push({ wallet: w, t: rec.blockTime * 1000, tokens: ev.tokenAmount, sol: ev.quoteAmount, priceQuote: ev.priceQuote, minutes: (rec.blockTime - createdSec) / 60 });
        return;
      }
      const td = rec.tokenDeltas.find((d) => d.mint === launch.mint && d.owner === w && d.delta < 0);
      if (td) sells.push({ wallet: w, t: rec.blockTime * 1000, tokens: -td.delta, sol: Math.max(0, (rec.solDelta[w] || 0) / 1e9), priceQuote: null, minutes: (rec.blockTime - createdSec) / 60 });
    });
  }
  if (!sells.length) return { sampledTxs: sampled, sells: 0, firstSellMin: null, soldPctAtFirstSell: null, mcapAtFirstSellUsd: null, soldBeforePeak: null };
  sells.sort((a, b) => a.t - b.t);
  const first = sells[0];
  const soldTokens = sells.reduce((s, x) => s + x.tokens, 0);
  // mcap at first sell: exact from the trade's post-trade price when we have it, else from candles
  let mcapAt = null;
  const rate = first.quoteIsUsd || launch.isUsdQuoted ? 1 : solUsd;
  if (first.priceQuote && rate) mcapAt = first.priceQuote * supply * rate;
  else if (hist?.available) mcapAt = mcapAtTime(hist, first.t);
  // Peak reference: candles when we have them, else the launch's known ATH (pump.fun record)
  const peakRef = hist?.available ? hist.peakMcapUsd : launch.peakMcapUsd || null;
  const peakAtRef = hist?.available ? hist.peakAt : launch.athAt || null;
  const soldBeforePeak = peakAtRef ? first.t < peakAtRef : null;
  const within10 = sells.filter((s) => s.minutes <= 10).reduce((s, x) => s + x.tokens, 0);
  return {
    sampledTxs: sampled,
    sells: sells.length,
    sellsDetail: sells.slice(0, 20).map((x) => ({ t: x.t, priceQuote: x.priceQuote || null, minutes: x.minutes })),
    firstSellMin: Math.round(first.minutes),
    soldPct: pct(soldTokens, supply),
    soldWithin10MinPct: pct(within10, supply),
    mcapAtFirstSellUsd: mcapAt,
    soldBeforePeak,
    peakShareAtFirstSell: mcapAt && peakRef ? mcapAt / peakRef : null,
  };
}

function mcapAtTime(hist, tMs) {
  // use checkpoints as a coarse curve
  const cps = hist.checkpoints || {};
  const mins = Math.max(0, (tMs - (hist.peakAt - hist.minutesToPeak * 60000)) / 60000);
  const keys = Object.keys(cps).map(Number).sort((a, b) => a - b);
  let best = hist.firstMcapUsd;
  for (const k of keys) if (k <= mins) best = cps[k];
  return best;
}

/**
 * Rate the operator (bullish vs bearish bundle) and derive an exit zone for the current launch.
 */
export function rateOperator(launches, current = {}) {
  const usable = launches.filter((l) => l.peakMcapUsd != null);
  const n = usable.length;
  const profile = current.profile?.available ? current.profile : null;
  const result = { launches: launches.length, rated: n, score: null, label: 'Unrated', reasons: [], exit: null, stats: null, profile: profile ? profileSummary(profile) : null };
  if (n === 0) {
    if (profile?.archetype?.kind === 'first') result.reasons.push('First token from this creator wallet (pump.fun record). No history to judge — treat as unknown.');
    else if (profile) result.reasons.push(`pump.fun lists ${profile.totalCreated} token(s) from this wallet but none has a recorded peak yet.`);
    else result.reasons.push('No prior launches found for this cluster (first launch, wallets rotated per launch, or pump.fun history unavailable).');
    return result;
  }
  const peaks = usable.map((l) => l.peakMcapUsd);
  const sortedPeaks = [...peaks].sort((a, b) => a - b);
  const medPeak = quantile(sortedPeaks, 0.5);
  const gradRate = usable.filter((l) => l.graduated || l.peakMcapUsd >= GRADUATION_MCAP).length / n;
  // "alive" needs a real run first: pump.fun's floor (~$3k at 30 virtual SOL) would otherwise count every rug as alive
  const alive = usable.filter((l) => l.nowMcapUsd != null && l.peakMcapUsd >= 15_000 && l.nowMcapUsd / l.peakMcapUsd >= 0.2).length / n;
  const ttp = usable.map((l) => l.minutesToPeak).filter((x) => x != null);
  const medTtp = ttp.length ? median(ttp) : null;
  const withExit = usable.filter((l) => l.clusterExit && l.clusterExit.sells > 0);
  const exits = withExit.map((l) => l.clusterExit);
  const medFirstSell = exits.length ? median(exits.map((e) => e.firstSellMin)) : null;
  const medPeakShareAtSell = exits.length ? median(exits.map((e) => e.peakShareAtFirstSell).filter((x) => x != null)) : null;
  // A "quick dump" = cluster sold within 10 minutes AND either sold well before the run (<50% of peak)
  // or the launch never ran at all (peak below $25k — their sale *was* the top).
  const quickDumps = withExit.filter((l) => {
    const e = l.clusterExit;
    return e.firstSellMin != null && e.firstSellMin <= 10 && (e.peakShareAtFirstSell == null || e.peakShareAtFirstSell < 0.5 || l.peakMcapUsd < 25_000);
  }).length;
  const big = usable.filter((l) => l.peakMcapUsd >= 50_000).length / n;

  let score = 0;
  // 1) how far launches typically run (log scale: $6k launch floor → $500k = 0 → 40)
  const peakPts = Math.max(0, Math.min(40, (40 * (Math.log10(Math.max(medPeak, 1)) - Math.log10(6000))) / (Math.log10(500_000) - Math.log10(6000))));
  score += peakPts;
  // 2) graduation rate (0 → 20)
  score += 20 * gradRate;
  // 3) survival (0 → 15)
  score += 15 * alive;
  // 4) sustained vs instant (0 → 10). pump.fun runs that last an hour are rare; 20 min is already a real run.
  if (medTtp != null) score += medTtp >= 60 ? 10 : medTtp >= 20 ? 8 : medTtp >= 8 ? 5 : medTtp >= 3 ? 2 : 0;
  else score += 4;
  // 5) consistency (0 → 10)
  score += 10 * big;
  // 6) cluster exit behaviour (−15 → +15)
  if (exits.length) {
    if (quickDumps / exits.length >= 0.5) score -= 15;
    else if (medFirstSell != null && medFirstSell >= 30) score += 10;
    if (medPeakShareAtSell != null && medPeakShareAtSell >= 0.7) score += 5;
  }
  score = Math.round(Math.max(0, Math.min(100, score)));

  const farm = profile?.archetype?.kind === 'farm';
  if (farm) score = Math.min(score, 12); // a mint-and-dump farm is bearish whatever one lucky launch did
  let label = n < 2 ? (score >= 65 ? 'Leaning bullish (1 launch)' : score >= 40 ? 'Mixed (1 launch)' : 'Leaning bearish (1 launch)') : score >= 65 ? 'Bullish bundle' : score >= 40 ? 'Mixed' : 'Bearish bundle';
  if (farm) label = 'Token farm';

  const r = result.reasons;
  const infra = usable.filter((l) => l.viaInfra && l.relation !== 'created').length;
  if (profile) {
    const p = profile;
    const cnt = `${p.totalCreated.toLocaleString()}${p.atLeast ? '+' : ''}`;
    const since = p.firstCreatedAt ? ` since ${new Date(p.firstCreatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: p.spanDays > 300 ? 'numeric' : undefined })}` : '';
    const rate = p.perDay != null && p.totalCreated >= 5 ? (p.perDay >= 1 ? ` (≈${Math.round(p.perDay)} per day${p.perDayRecent ? ' lately' : ''})` : p.perDay * 7 >= 1 ? ` (≈${Math.round(p.perDay * 7)} per week${p.perDayRecent ? ' lately' : ''})` : '') : '';
    r.push(`This creator wallet has launched ${cnt} token${p.totalCreated === 1 ? '' : 's'} on pump.fun${since}${rate}${p.last24hAtLeast ? `, ${p.last24h}+ in the last 24 h` : p.last24h >= 3 ? `, ${p.last24h} in the last 24 h` : ''}`);
    const st = p.stats || {};
    if (farm) r.push(`Token farm: ${Math.round((st.deadRate || 0) * 100)}% of their tokens never traded above $10k (the dev buy was the top), ${Math.round((st.ranRate || 0) * 100)}% ever ran past $30k. The pattern is mint → sell the dev bag into whoever buys → next token.`);
    else if (st.n) r.push(`Of their launches: ${Math.round((st.deadRate || 0) * 100)}% never traded above $10k · ${Math.round((st.popRate || 0) * 100)}% popped to $10–30k · ${Math.round((st.ranRate || 0) * 100)}% ran past $30k · ${Math.round((st.graduationRate || 0) * 100)}% graduated`);
    if (p.sampleFull) r.push(`Outcomes are from the ${p.sample.length} most recent launches (pump.fun record); the dev's own sells were checked on the last ${Math.min(10, p.sample.length)}`);
    if (st.peakedAtLaunchRate != null && st.peakedAtLaunchRate >= 0.5) r.push(`${Math.round(st.peakedAtLaunchRate * 100)}% of their launches peaked in the launch block itself — the dev/bundle buy was the all-time high and it only went down from there`);
  }
  r.push(`${n} prior launch${n > 1 ? 'es' : ''} with price history; median peak ${fmtUsd(medPeak)}${profile?.stats?.best ? ` · best ever ${fmtUsd(profile.stats.best.athMcapUsd)} (${profile.stats.best.symbol || 'token'})` : ''}`);
  if (infra) r.push(`${infra} of them linked through the same funding/payer wallet — a launch tool's shared funder can serve several operators, so treat as "same infrastructure", not proof of the same person`);
  if (!profile) r.push(`${Math.round(gradRate * 100)}% reached graduation mcap (~$69k)`);
  if (medTtp != null) r.push(medTtp <= 0.1 ? 'typical time to peak: the launch block (the top was the first few seconds)' : `typical time to peak ${fmtMin(medTtp)}`);
  r.push(`${Math.round(alive * 100)}% are still alive now (ran past $15k and hold ≥20% of that peak today)`);
  if (exits.length) {
    const who = exits.some((e) => e.who === 'dev') ? 'dev' : 'cluster';
    r.push(`${who} first sold at median +${fmtMin(medFirstSell)}${medPeakShareAtSell != null ? ` (~${Math.round(medPeakShareAtSell * 100)}% of that launch's peak)` : ''} on ${exits.length} checked launch${exits.length === 1 ? '' : 'es'}`);
    if (quickDumps) r.push(`${quickDumps}/${exits.length} checked launches: sold within 10 min, before any run`);
  } else r.push('no dev/cluster sells found on the checked launches (still holding, or sold via other wallets)');

  // Exit zone for the current launch, from the distribution of prior peaks
  const p25 = quantile(sortedPeaks, 0.25);
  const p50 = medPeak;
  const p75 = quantile(sortedPeaks, 0.75);
  const dumpMcap = exits.length ? median(exits.map((e) => e.mcapAtFirstSellUsd).filter((x) => x != null)) : null;
  const curMcap = current.marketCapUsd || null;
  const supply = current.supply || PUMP_TOTAL_SUPPLY;
  const maxPeak = sortedPeaks[sortedPeaks.length - 1];
  const target = (m) => ({ mcapUsd: m, priceUsd: m / supply, multiple: curMcap ? m / curMcap : null, reached: curMcap ? curMcap >= m : null });
  result.thin = n < 3; // too few launches to call it a pattern
  result.thinKnownTotal = profile ? profile.totalCreated : null; // what the dev has actually launched, even if we rated fewer
  result.historyExceeded = curMcap != null && curMcap > maxPeak * 1.2; // this launch already ran past everything they did before
  result.exit = {
    launches: n,
    single: n === 1,
    conservative: target(p25),
    base: target(p50),
    stretch: target(p75),
    highest: target(maxPeak),
    operatorDump: dumpMcap ? { ...target(dumpMcap), minutes: medFirstSell } : null,
    basis: n === 1 ? 'the one prior launch we found' : `the ${n} prior launches we found: a quarter peaked below the low number, half below the middle, three quarters below the high`,
    note: 'Historical pattern, not a prediction. Operators change behaviour; size accordingly.',
  };
  result.score = score;
  result.label = label;
  result.stats = { medianPeakUsd: medPeak, graduationRate: gradRate, aliveRate: alive, medianMinutesToPeak: medTtp, medianFirstSellMin: medFirstSell, medianPeakShareAtSell: medPeakShareAtSell, quickDumps, exitsSampled: exits.length, bigRunRate: big, viaInfra: infra };
  return result;
}

/** Compact, serialisable summary of a creator profile for the report (the full sample is kept separately). */
export function profileSummary(p) {
  return {
    source: p.source,
    creator: p.creator,
    totalCreated: p.totalCreated,
    exact: p.exact,
    atLeast: p.atLeast,
    firstCreatedAt: p.firstCreatedAt,
    lastCreatedAt: p.lastCreatedAt,
    spanDays: p.spanDays,
    perDay: p.perDay,
    perDayRecent: p.perDayRecent,
    countCapped: p.countCapped,
    last24h: p.last24h,
    last24hAtLeast: p.last24hAtLeast,
    last7d: p.last7d,
    last7dAtLeast: p.last7dAtLeast,
    sampleFull: p.sampleFull,
    sampleSize: p.sample?.length || 0,
    archetype: p.archetype,
    stats: p.stats,
    current: p.current ? { athMcapUsd: p.current.athMcapUsd, athAt: p.current.athAt, nowMcapUsd: p.current.nowMcapUsd, graduated: p.current.graduated } : null,
  };
}

export function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
  return `$${v.toFixed(v < 1 ? 6 : 0)}`;
}
export function fmtMin(m) {
  if (m == null) return '—';
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}
