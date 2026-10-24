// Dev profile: everything a creator wallet has ever launched on pump.fun, from pump.fun's own public
// read API (frontend-api-v3). Free RPCs only remember the last ~14–18 h of a wallet's history, which is
// why a dev farm with 5,000 tokens looked like "7 launches" in GLASS 0.2. The API sees all of them.
//
// Nothing but the wallet address is sent. If the API is unreachable (offline, blocked), everything
// here returns `{ available: false }` and the on-chain sampling in operator.js still runs.
import { fetchJson } from '../http.js';
import { SOURCES } from '../constants.js';

const PAGE = 70; // the API returns at most ~70 coins per request regardless of `limit`
// pump.fun's API returns [] for any offset above 1000, in either sort direction, so one direction can
// list at most 1,001 coins. Paging from both ends reaches 2,002; past that only a lower bound is knowable.
const API_OFFSET_CAP = 1000;
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
 * (exponential, then bisect) with limit=1, up to the API's offset cap. Wallets with more than 1,001
 * coins are counted from both ends (newest-first and oldest-first): exact up to 2,002, a lower bound above.
 */
async function coinAt(creator, offset, order = 'DESC') {
  return (await fetchCreatorCoins(creator, { offset, limit: 1, order }))[0] || null;
}
async function countCreated(creator, firstPageLen) {
  if (firstPageLen < PAGE) return { total: firstPageLen, exact: true };
  const has = async (offset) => (await coinAt(creator, offset)) != null;
  const probes = [];
  for (let o = PAGE * 2; o < API_OFFSET_CAP; o *= 2) probes.push(o);
  probes.push(API_OFFSET_CAP);
  const hits = await Promise.all(probes.map((o) => has(o).catch(() => null)));
  let lo = PAGE - 1; // highest index known to exist (first page was full)
  let hi = null; // known empty
  for (let i = 0; i < probes.length; i++) {
    if (hits[i] === true) lo = probes[i];
    else if (hits[i] === false) {
      hi = probes[i];
      break;
    } else if (hits[i] === null) return { total: lo + 1, exact: false, atLeast: true }; // request failed
  }
  if (hi == null) return countBeyondCap(creator); // offset 1000 exists: more than one direction can list
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

async function countBeyondCap(creator) {
  const CAP = API_OFFSET_CAP;
  const [edgeNew, edgeOld] = await Promise.all([coinAt(creator, CAP, 'DESC').catch(() => null), coinAt(creator, CAP, 'ASC').catch(() => null)]);
  if (!edgeNew) return { total: CAP + 1, exact: false, atLeast: true };
  const tNew = Number(edgeNew.created_timestamp);
  // the newest 1,001 coins span [tNew, now] — the only honest basis for "how fast are they minting now"
  const recent = { n: CAP + 1, since: tNew };
  if (!edgeOld) return { total: CAP + 1, exact: false, atLeast: true, recent };
  if (Number(edgeOld.created_timestamp) < tNew) {
    // the oldest 1,001 and the newest 1,001 don't meet: more than 2,002 coins, the API can't say how many
    return { total: 2000, exact: false, atLeast: true, capped: true, recent }; // shown as "2,000+"
  }
  // They overlap, so the newest list's last coin sits at oldest-first index (total − 1001) ≤ 1000. Find it.
  let lo = 0, hi = CAP;
  try {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = await coinAt(creator, mid, 'ASC');
      if (c && Number(c.created_timestamp) < tNew) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i <= Math.min(CAP, lo + 4); i++) {
      const c = await coinAt(creator, i, 'ASC');
      if (c?.mint === edgeNew.mint) return { total: i + CAP + 1, exact: true };
    }
  } catch {
    return { total: CAP + 1, exact: false, atLeast: true, recent };
  }
  return { total: lo + CAP + 1, exact: false };
}

/**
 * Profile a creator wallet.
 * @returns {{available:boolean, creator, totalCreated, exact, atLeast, firstCreatedAt, lastCreatedAt, perDay,
 *            last24h, last7d, sample:[], stats, archetype, current}}
 */
export async function creatorProfile(creator, { currentMint, log = () => {}, samplePages = 3 } = {}) {
  if (!creator) return { available: false, reason: 'no creator' };
  return cached(`profile:${creator}:${samplePages}`, 90_000, async () => {
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
    // Above 2,002 coins the total is only a lower bound, so the minting rate comes from the newest 1,001
    const recentPerDay = count.atLeast && count.recent ? count.recent.n / Math.max(1 / 24, (now - count.recent.since) / 86400000) : null;
    const within = (ms) => coins.filter((c) => c.createdAt && now - c.createdAt <= ms).length;
    const pageOldest = coins[coins.length - 1]?.createdAt || null;
    const sampleFull = page.length >= PAGE;
    const last24h = within(86400000);
    const last7d = within(7 * 86400000);
    // A full page that is entirely younger than the window means the true count is higher than the page
    const last24hAtLeast = sampleFull && pageOldest && now - pageOldest <= 86400000;
    const last7dAtLeast = sampleFull && pageOldest && now - pageOldest <= 7 * 86400000;
    const stats = summarise(sample);
    const perDay = recentPerDay ?? (spanDays ? total / spanDays : null);
    const archetype = classifyArchetype({ total, spanDays, perDay, last24h, last24hAtLeast, stats, sampleFull });
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
      perDay,
      perDayRecent: recentPerDay != null,
      countCapped: !!count.capped,
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
export function classifyArchetype({ total, spanDays, perDay: rate, last24h, last24hAtLeast, stats, sampleFull }) {
  if (total <= 1) return { kind: 'first', label: 'First launch from this wallet' };
  const perDay = rate ?? (spanDays ? total / spanDays : 0);
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
    createdSlot: null,
    creator,
    relation: 'created',
    clusterWallets: [creator],
    launchBuyers: [],
    buys: [],
    sells: [],
    viaInfra: false,
    linkedBy: [{ wallet: creator, how: "this token's creator wallet also created it (pump.fun record)" }],
    peakMcapUsd: c.athMcapUsd,
    minutesToPeak: c.minutesToPeak,
    nowMcapUsd: c.nowMcapUsd,
    graduated: c.graduated,
    drawdown: c.athMcapUsd && c.nowMcapUsd != null ? 1 - c.nowMcapUsd / c.athMcapUsd : null,
    outcome: outcomeOf(c),
    clusterExit: null,
    historyAvailable: c.athMcapUsd != null,
    source: 'pump.fun',
    dexId: c.graduated ? 'pumpswap' : 'pumpfun',
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
