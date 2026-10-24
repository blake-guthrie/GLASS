// Dev profile: everything a creator wallet has ever launched on pump.fun, from pump.fun's own public
// read API (frontend-api-v3). Free RPCs only remember the last ~14–18 h of a wallet's history, which is
// why a dev farm with 5,000 tokens looked like "7 launches" in GLASS 0.2. The API sees all of them.
//
// Nothing but the wallet address is sent. If the API is unreachable (offline, blocked), everything
// here returns `{ available: false }` and the on-chain sampling in operator.js still runs.
import { fetchJson } from '../http.js';
import { SOURCES } from '../constants.js';
import { fetchLaunchpadHistory } from './launchpads.js';

const PAGE = 70; // the API returns at most ~70 coins per request regardless of `limit`
const MAX_COUNT = 20_000; // stop counting here ("20,000+")
const GRADUATION_MCAP = 69_000;

const memo = new Map();
function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = fn();
  memo.set(key, { v, exp: Date.now() + ttlMs });
  v.catch?.(() => memo.delete(key));
  return v;
}

function q(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** One page of coins created by `creator`, newest first. */
export async function fetchCreatorCoins(creator, { offset = 0, limit = PAGE, order = 'DESC' } = {}) {
  const url = `${SOURCES.pumpfun}/coins?${q({ creator, limit, offset, sort: 'created_timestamp', order, includeNsfw: 'true' })}`;
  const r = await fetchJson(url, { retries: 1, timeoutMs: 12_000 });
  if (!Array.isArray(r)) throw new Error('unexpected pump.fun response');
  return r.filter((c) => c && c.mint && c.creator === creator);
}

/** One coin by mint (ATH, graduation, current mcap) — for launches found on-chain via funders. */
export async function fetchCoin(mint) {
  return cached(`coin:${mint}`, 60_000, async () => {
    try {
      const r = await fetchJson(`${SOURCES.pumpfun}/coins-v2/${mint}`, { retries: 0, timeoutMs: 8000 });
      return r && r.mint ? normaliseCoin(r) : null;
    } catch {
      return null;
    }
  });
}

export function normaliseCoin(c) {
  const created = c.created_timestamp ? Number(c.created_timestamp) : null;
  const athAt = c.ath_market_cap_timestamp ? Number(c.ath_market_cap_timestamp) : null;
  const ath = c.ath_market_cap != null ? Number(c.ath_market_cap) : null;
  const now = c.usd_market_cap != null ? Number(c.usd_market_cap) : null;
  return {
    mint: c.mint,
    name: c.name || null,
    symbol: c.symbol || null,
    createdAt: created,
    athMcapUsd: ath,
    athAt,
    minutesToPeak: created && athAt && athAt >= created ? Math.round((athAt - created) / 600) / 100 : null, // fractional minutes
    nowMcapUsd: now,
    graduated: !!c.complete,
    lastTradeAt: c.last_trade_timestamp ? Number(c.last_trade_timestamp) : null,
    replies: c.reply_count ?? null,
    program: c.program || null,
    url: `https://pump.fun/coin/${c.mint}`,
  };
}

/**
 * Total coins created by a wallet. The first page tells us "≤70"; beyond that we probe offsets
 * (exponential, then bisect) with limit=1. ~12 tiny requests for a 5,000-token farm.
 */
async function countCreated(creator, firstPageLen) {
  if (firstPageLen < PAGE) return { total: firstPageLen, exact: true };
  const has = async (offset) => (await fetchCreatorCoins(creator, { offset, limit: 1 })).length > 0;
  // exponential probe, in parallel
  const probes = [];
  for (let o = PAGE * 2; o <= MAX_COUNT; o *= 2) probes.push(o);
  const hits = await Promise.all(probes.map((o) => has(o).catch(() => null)));
  let lo = PAGE - 1; // highest index known to exist (first page was full)
  let hi = null; // known empty
  for (let i = 0; i < probes.length; i++) {
    if (hits[i] === true) lo = probes[i];
    else if (hits[i] === false) {
      hi = probes[i];
      break;
    } else if (hits[i] === null) break; // request failed — stop, report lower bound
  }
  if (hi == null) return { total: lo, exact: false, atLeast: true };
  // bisect
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    let ok;
    try {
      ok = await has(mid);
    } catch {
      return { total: lo + 1, exact: false, atLeast: true };
    }
    if (ok) lo = mid;
    else hi = mid;
  }
  return { total: lo + 1, exact: true };
}

/**
 * Profile a creator wallet.
 * @returns {{available:boolean, creator, totalCreated, exact, atLeast, firstCreatedAt, lastCreatedAt, perDay,
 *            last24h, last7d, sample:[], stats, archetype, current}}
 */
async function pumpCreatorProfile(creator, { currentMint, log = () => {}, samplePages = 3 } = {}) {
  if (!creator) return { available: false, reason: 'no creator' };
  return cached(`profile:${creator}:${samplePages}:${currentMint || ''}`, 90_000, async () => {
    let page;
    try {
      page = await fetchCreatorCoins(creator, { offset: 0, limit: PAGE });
    } catch (e) {
      log(`pump.fun dev profile unavailable: ${e.message}`);
      return { available: false, reason: e.status ? `HTTP ${e.status}` : e.message };
    }
    // Serial launchers: pull more pages (newest first) so the outcome stats rest on a real sample
    let all = page;
    if (page.length >= PAGE && samplePages > 1) {
      const more = await Promise.all(Array.from({ length: samplePages - 1 }, (_, i) => fetchCreatorCoins(creator, { offset: PAGE * (i + 1), limit: PAGE }).catch(() => [])));
      for (const m of more) {
        all = all.concat(m);
        if (m.length < PAGE) break;
      }
    }
    const coins = all.map(normaliseCoin);
    const current = coins.find((c) => c.mint === currentMint) || null;
    const sample = coins.filter((c) => c.mint !== currentMint);
    const [count, oldestPage] = await Promise.all([
      countCreated(creator, page.length).catch(() => ({ total: page.length, exact: false, atLeast: true })),
      page.length >= PAGE ? fetchCreatorCoins(creator, { offset: 0, limit: 1, order: 'ASC' }).catch(() => []) : Promise.resolve([]),
    ]);
    const oldest = oldestPage[0] ? normaliseCoin(oldestPage[0]) : coins[coins.length - 1] || null;
    const firstCreatedAt = oldest?.createdAt || null;
    const lastCreatedAt = coins[0]?.createdAt || null;
    const now = Date.now();
    const spanDays = firstCreatedAt ? Math.max(1 / 24, (now - firstCreatedAt) / 86400000) : null;
    const total = count.total;
    const within = (ms) => coins.filter((c) => c.createdAt && now - c.createdAt <= ms).length;
    const pageOldest = coins[coins.length - 1]?.createdAt || null;
    const sampleFull = page.length >= PAGE;
    const last24h = within(86400000);
    const last7d = within(7 * 86400000);
    // A full page that is entirely younger than the window means the true count is higher than the page
    const last24hAtLeast = sampleFull && pageOldest && now - pageOldest <= 86400000;
    const last7dAtLeast = sampleFull && pageOldest && now - pageOldest <= 7 * 86400000;
    const stats = summarise(sample);
    const archetype = classifyArchetype({ total, spanDays, last24h, last24hAtLeast, stats, sampleFull });
    return {
      available: true,
      source: 'pump.fun',
      creator,
      totalCreated: total,
      exact: !!count.exact,
      atLeast: !!count.atLeast,
      firstCreatedAt,
      lastCreatedAt,
      spanDays,
      perDay: spanDays ? total / spanDays : null,
      last24h,
      last24hAtLeast: !!last24hAtLeast,
      last7d,
      last7dAtLeast: !!last7dAtLeast,
      sampleFull,
      sample,
      stats,
      archetype,
      current,
    };
  });
}

/** Without rpc, retain the pump.fun API contract. The scan pipeline supplies its
 * selected history RpcClient to add bounded, explicitly partial non-pump history.
 */
export async function creatorProfile(creator, options = {}) {
  const pumpPromise = pumpCreatorProfile(creator, options);
  if (!options.rpc) return pumpPromise;
  const [pump, history] = await Promise.all([pumpPromise, fetchLaunchpadHistory(options.rpc, creator, options.launchpadHistory)]);
  const coverage = {
    'pump.fun': { status: pump.available ? pump.exact && !pump.sampleFull ? 'complete' : 'partial' : 'unavailable', countExact: !!pump.exact, totalCreated: pump.totalCreated ?? null, reason: pump.reason || 'pump.fun creator record; outcomes may be sampled.' },
    ...history.coverage,
  };
  const known = new Map([...(pump.sample || []), ...(pump.current ? [pump.current] : [])].map((c) => [c.mint, c]));
  let added = 0;
  for (const c of history.coins) if (!known.has(c.mint)) { known.set(c.mint, c); added++; }
  if (!added && pump.available) return { ...pump, coverage };
  if (!pump.available && !history.coverage.bonk.pages) return { ...pump, coverage };
  const coins = [...known.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.mint.localeCompare(b.mint));
  // A sampled pump record cannot prove non-overlap with every older pump row.
  const total = pump.available && pump.exact && !pump.sampleFull ? pump.totalCreated + added : Math.max(pump.totalCreated || 0, coins.length);
  return {
    available: true, source: 'creator-history', creator,
    totalCreated: total, exact: false, atLeast: true,
    firstCreatedAt: null, lastCreatedAt: null, spanDays: null, perDay: null,
    last24h: null, last7d: null, last24hAtLeast: false, last7dAtLeast: false,
    sampleFull: true, sample: coins.filter((c) => c.mint !== options.currentMint),
    current: known.get(options.currentMint) || null,
    stats: { n: 0 }, archetype: { kind: 'partial', label: 'Partial creator history' },
    pumpProfile: pump.available ? pump : null, coverage,
  };
}

function quantile(sorted, qq) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * qq;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarise(sample) {
  const withAth = sample.filter((c) => c.athMcapUsd != null && c.athMcapUsd > 0);
  const n = withAth.length;
  if (!n) return { n: 0 };
  const aths = withAth.map((c) => c.athMcapUsd).sort((a, b) => a - b);
  const ttp = withAth.map((c) => c.minutesToPeak).filter((x) => x != null).sort((a, b) => a - b);
  const graduated = withAth.filter((c) => c.graduated).length;
  // One set of buckets, used everywhere in the panel:
  //   never ran  : peak < $10k — the launch floor (dev buy + bots) was the top
  //   small pop  : $10k–$30k
  //   ran        : ≥ $30k (a real run on pump.fun; graduation is ~$69k)
  const dead = withAth.filter((c) => c.athMcapUsd < 10_000).length;
  const pop = withAth.filter((c) => c.athMcapUsd >= 10_000 && c.athMcapUsd < 30_000).length;
  const ran = withAth.filter((c) => c.athMcapUsd >= 30_000).length;
  const alive = withAth.filter((c) => c.nowMcapUsd != null && c.athMcapUsd >= 15_000 && c.nowMcapUsd / c.athMcapUsd >= 0.2).length;
  const big = withAth.filter((c) => c.athMcapUsd >= 250_000).length;
  const peakedAtLaunch = withAth.filter((c) => c.minutesToPeak != null && c.minutesToPeak <= 0.1).length; // within ~6 s of creation
  const best = withAth.reduce((a, c) => (c.athMcapUsd > (a?.athMcapUsd || 0) ? c : a), null);
  return {
    n,
    medianAthUsd: quantile(aths, 0.5),
    p25AthUsd: quantile(aths, 0.25),
    p75AthUsd: quantile(aths, 0.75),
    maxAthUsd: aths[aths.length - 1],
    best: best ? { mint: best.mint, symbol: best.symbol, athMcapUsd: best.athMcapUsd, createdAt: best.createdAt } : null,
    graduationRate: graduated / n,
    graduated,
    deadRate: dead / n,
    popRate: pop / n,
    ranRate: ran / n,
    ran,
    aliveRate: alive / n,
    alive,
    bigRunRate: big / n,
    medianMinutesToPeak: ttp.length ? quantile(ttp, 0.5) : null,
    peakedAtLaunchRate: ttp.length ? peakedAtLaunch / ttp.length : null,
    quickPeakRate: ttp.length ? ttp.filter((m) => m <= 5).length / ttp.length : null,
  };
}

/**
 * How does this dev operate?
 *  farm      – mass-mints tokens (tens per day), practically none run: automated spam / extractor
 *  serial    – many launches, launches regularly; judged by outcomes
 *  repeat    – a handful of launches
 *  first     – this is their first token
 */
export function classifyArchetype({ total, spanDays, last24h, last24hAtLeast, stats, sampleFull }) {
  if (total <= 1) return { kind: 'first', label: 'First launch from this wallet' };
  const perDay = spanDays ? total / spanDays : 0;
  const rapid = perDay >= 10 || last24hAtLeast || last24h >= 20;
  const farm = total >= 50 && rapid && (stats.n ? stats.ranRate <= 0.15 : true);
  if (farm) return { kind: 'farm', label: 'Token farm' };
  if (total >= 200 && sampleFull && (stats.n ? stats.ranRate <= 0.15 : true)) return { kind: 'farm', label: 'Token farm' };
  if (total >= 10) return { kind: 'serial', label: 'Serial launcher' };
  return { kind: 'repeat', label: `${total} launches from this wallet` };
}

/** Convert API coins to the shape operator.js's rateOperator() consumes. */
export function toPriorLaunches(profile, creator) {
  if (!profile?.available) return [];
  return profile.sample.map((c) => ({
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    url: c.url,
    createdAt: c.createdAt,
    createdSlot: c.createdSlot ?? null,
    creator,
    relation: 'created',
    clusterWallets: [creator],
    launchBuyers: [],
    buys: [],
    sells: [],
    viaInfra: false,
    linkedBy: [{ wallet: creator, how: c.source ? `designated creator in ${c.source} initialization (${c.signature || 'transaction unavailable'})` : "this token's creator wallet also created it (pump.fun record)" }],
    peakMcapUsd: c.athMcapUsd,
    minutesToPeak: c.minutesToPeak,
    nowMcapUsd: c.nowMcapUsd,
    graduated: c.graduated,
    drawdown: c.athMcapUsd && c.nowMcapUsd != null ? 1 - c.nowMcapUsd / c.athMcapUsd : null,
    outcome: outcomeOf(c),
    clusterExit: null,
    historyAvailable: c.athMcapUsd != null,
    source: c.source || 'pump.fun',
    dexId: c.source ? null : c.graduated ? 'pumpswap' : 'pumpfun',
    program: c.program,
    platform: c.platform ?? null,
    platformName: c.platformName ?? null,
    creationSignature: c.signature ?? null,
    quoteMint: c.quoteMint ?? null,
  }));
}

function outcomeOf(c) {
  const peak = c.athMcapUsd;
  if (peak == null) return 'unknown';
  const alive = c.nowMcapUsd != null && peak > 0 && c.nowMcapUsd / peak >= 0.3;
  if (peak >= 1_000_000) return alive ? 'moon-alive' : 'moon';
  if (peak >= 250_000) return alive ? 'runner-alive' : 'runner';
  if (c.graduated || peak >= GRADUATION_MCAP) return alive ? 'graduated-alive' : 'graduated';
  if (peak >= 25_000) return 'fizzled';
  return 'rug';
}
