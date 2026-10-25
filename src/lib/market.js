// Market data: DexScreener (pairs, price, mcap), GeckoTerminal (OHLCV → peaks), Jito bundles, pump.fun API (optional).
import { fetchJson } from './http.js';
import { SOURCES, PROGRAMS, PUMP_TOTAL_SUPPLY, USD_STABLE_MINTS } from './constants.js';

const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  memo.set(key, { v, exp: Date.now() + ttlMs });
  return v;
}

function pickBestPair(pairs, mint) {
  const list = (pairs || []).filter((p) => p.chainId === 'solana' && (!mint || p.baseToken?.address === mint));
  if (!list.length) return null;
  // Prefer the pair with the most liquidity, but pump.fun bonding curves have no "liquidity" field → use volume/fdv.
  list.sort((a, b) => (b.liquidity?.usd || b.volume?.h24 || 0) - (a.liquidity?.usd || a.volume?.h24 || 0));
  return list[0];
}

export function normalisePair(p) {
  if (!p) return null;
  const quoteSym = p.quoteToken?.symbol?.toUpperCase() || '';
  const isUsdQuote = quoteSym.includes('USD') || (p.quoteToken?.address && USD_STABLE_MINTS.has(p.quoteToken.address));
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    mint: p.baseToken?.address,
    name: p.baseToken?.name,
    symbol: p.baseToken?.symbol,
    quoteMint: p.quoteToken?.address,
    quoteSymbol: p.quoteToken?.symbol,
    isUsdQuote,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : isUsdQuote && p.priceNative ? Number(p.priceNative) : null,
    priceNative: p.priceNative ? Number(p.priceNative) : null,
    marketCapUsd: p.marketCap != null ? Number(p.marketCap) : p.fdv != null ? Number(p.fdv) : null,
    fdvUsd: p.fdv != null ? Number(p.fdv) : null,
    liquidityUsd: p.liquidity?.usd ?? null,
    volume24h: p.volume?.h24 ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
    txns: p.txns || null,
    priceChange: p.priceChange || null,
    socials: p.info?.socials || [],
    websites: p.info?.websites || [],
    imageUrl: p.info?.imageUrl || null,
    boosts: p.boosts?.active || 0,
  };
}

export async function dexTokenInfo(mint) {
  return cached(`dex:tok:${mint}`, 20_000, async () => {
    try {
      const r = await fetchJson(`${SOURCES.dexscreener}/latest/dex/tokens/${mint}`, { retries: 1 });
      const all = (r?.pairs || []).filter((p) => p.chainId === 'solana');
      const best = normalisePair(pickBestPair(all, mint));
      const earliest = all.map((p) => p.pairCreatedAt).filter(Boolean).sort((a, b) => a - b)[0] || null;
      if (best) best.earliestPairCreatedAt = earliest; // the first pool anywhere = tight upper bound on creation time
      return { best, pairs: all.map(normalisePair) };
    } catch (e) {
      return { best: null, pairs: [], error: e.message };
    }
  });
}

export async function dexTokensBulk(mints) {
  // DexScreener accepts up to 30 comma-separated addresses.
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const group = mints.slice(i, i + 30);
    try {
      const r = await fetchJson(`${SOURCES.dexscreener}/latest/dex/tokens/${group.join(',')}`, { retries: 1 });
      const byMint = {};
      for (const p of r?.pairs || []) {
        if (p.chainId !== 'solana') continue;
        const m = p.baseToken?.address;
        (byMint[m] ||= []).push(p);
      }
      for (const m of group) out[m] = normalisePair(pickBestPair(byMint[m] || [], m));
    } catch (e) {
      for (const m of group) out[m] = null;
    }
  }
  return out;
}

export async function dexPairInfo(pairAddress) {
  return cached(`dex:pair:${pairAddress}`, 60_000, async () => {
    try {
      const r = await fetchJson(`${SOURCES.dexscreener}/latest/dex/pairs/solana/${pairAddress}`, { retries: 1 });
      return normalisePair((r?.pairs || r?.pair ? r.pairs || [r.pair] : [])[0]);
    } catch {
      return null;
    }
  });
}

export async function solPriceUsd() {
  return cached('solusd', 60_000, async () => {
    try {
      const r = await fetchJson(`${SOURCES.dexscreener}/latest/dex/tokens/${PROGRAMS.WSOL}`, { retries: 1 });
      const p = pickBestPair((r?.pairs || []).filter((x) => x.quoteToken?.symbol?.startsWith('USD')), PROGRAMS.WSOL);
      return p?.priceUsd ? Number(p.priceUsd) : null;
    } catch {
      return null;
    }
  });
}

// ---- GeckoTerminal (free tier: ~30 requests/minute → serialise with spacing) ----
const gh = { accept: 'application/json;version=20230302' };
let geckoChain = Promise.resolve();
let geckoLast = 0;
const GECKO_SPACING_MS = 1300;
function geckoFetch(url) {
  const run = async () => {
    const wait = geckoLast + GECKO_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geckoLast = Date.now();
    return fetchJson(url, { headers: gh, retries: 2 });
  };
  const p = geckoChain.then(run, run);
  geckoChain = p.catch(() => {});
  return p;
}

export async function geckoTopPool(mint) {
  return cached(`gecko:pools:${mint}`, 120_000, async () => {
    try {
      const r = await geckoFetch(`${SOURCES.gecko}/networks/solana/tokens/${mint}/pools?page=1`);
      const pools = (r?.data || []).map((d) => ({
        address: d.attributes?.address,
        name: d.attributes?.name,
        dex: d.relationships?.dex?.data?.id,
        createdAt: d.attributes?.pool_created_at ? Date.parse(d.attributes.pool_created_at) : null,
        fdvUsd: d.attributes?.fdv_usd ? Number(d.attributes.fdv_usd) : null,
        priceUsd: d.attributes?.base_token_price_usd ? Number(d.attributes.base_token_price_usd) : null,
        reserveUsd: d.attributes?.reserve_in_usd ? Number(d.attributes.reserve_in_usd) : null,
        volume24h: d.attributes?.volume_usd?.h24 ? Number(d.attributes.volume_usd.h24) : null,
      }));
      pools.sort((a, b) => (b.reserveUsd || b.volume24h || 0) - (a.reserveUsd || a.volume24h || 0));
      return { pools, top: pools[0] || null };
    } catch (e) {
      return { pools: [], top: null, error: e.message };
    }
  });
}

export async function geckoOhlcv(pool, timeframe = 'minute', aggregate = 5, limit = 1000, beforeTs) {
  const q = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit), currency: 'usd' });
  if (beforeTs) q.set('before_timestamp', String(beforeTs));
  try {
    const r = await geckoFetch(`${SOURCES.gecko}/networks/solana/pools/${pool}/ohlcv/${timeframe}?${q}`);
    return (r?.data?.attributes?.ohlcv_list || []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  } catch {
    return [];
  }
}

/**
 * Price history summary for a mint: peak price/mcap, time to peak, first candle, current.
 * Uses GeckoTerminal; supply defaults to pump.fun's 1B.
 */
export async function priceHistory(mint, { supply = PUMP_TOTAL_SUPPLY, createdAtMs } = {}) {
  return cached(`hist:${mint}`, 120_000, async () => {
    const { top, pools } = await geckoTopPool(mint);
    if (!top) return { available: false, pools: [] };
    const ageMs = Date.now() - (top.createdAt || createdAtMs || Date.now());
    const candles = [];
    // Fine candles for the first ~3.5 days, hourly beyond, daily beyond ~40 days.
    candles.push(...(await geckoOhlcv(top.address, 'minute', 5, 1000)));
    if (ageMs > 3.3 * 86400e3) candles.push(...(await geckoOhlcv(top.address, 'hour', 1, 1000)));
    if (ageMs > 40 * 86400e3) candles.push(...(await geckoOhlcv(top.address, 'day', 1, 1000)));
    // For graduated tokens also pull the bonding-curve pool (pre-graduation price path), if listed.
    const curvePool = pools.find((p) => p !== top && p.dex === 'pumpfun');
    if (curvePool) candles.push(...(await geckoOhlcv(curvePool.address, 'minute', 5, 1000)));
    if (!candles.length) return { available: false, pools: pools.map((p) => p.address), top };
    candles.sort((a, b) => a.t - b.t);
    let peak = candles[0];
    for (const c of candles) if (c.h > peak.h) peak = c;
    const first = candles[0];
    const last = candles[candles.length - 1];
    const startMs = createdAtMs || top.createdAt || first.t * 1000;
    const peakMcap = peak.h * supply;
    const result = {
      available: true,
      top,
      pools: pools.map((p) => p.address),
      candles: candles.length,
      firstPriceUsd: first.o,
      firstMcapUsd: first.o * supply,
      peakPriceUsd: peak.h,
      peakMcapUsd: peakMcap,
      peakAt: peak.t * 1000,
      minutesToPeak: Math.max(0, Math.round((peak.t * 1000 - startMs) / 60000)),
      lastPriceUsd: last.c,
      lastMcapUsd: last.c * supply,
      drawdownFromPeak: peakMcap > 0 ? 1 - (last.c * supply) / peakMcap : null,
      totalVolumeUsd: candles.reduce((s, c) => s + (c.v || 0), 0),
      // mcap path at a few checkpoints after launch (for "where did it go" charts)
      checkpoints: checkpoints(candles, startMs, supply),
    };
    return result;
  });
}

function checkpoints(candles, startMs, supply) {
  const marks = [5, 15, 30, 60, 180, 720, 1440];
  const out = {};
  for (const m of marks) {
    const target = startMs + m * 60000;
    let best = null;
    for (const c of candles) {
      if (c.t * 1000 <= target) best = c;
      else break;
    }
    if (best) out[m] = best.c * supply;
  }
  return out;
}

// ---- Jito ----
export async function jitoBundleId(sig) {
  try {
    const r = await fetchJson(`${SOURCES.jito}/bundles/transaction/${sig}`, { retries: 0, timeoutMs: 8000 });
    if (Array.isArray(r) && r[0]?.bundle_id) return r[0].bundle_id;
    if (r?.bundle_id) return r.bundle_id;
    return null;
  } catch {
    return null;
  }
}
