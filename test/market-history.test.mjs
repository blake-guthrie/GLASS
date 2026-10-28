import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { priceHistory } from '../src/lib/market.js';
import { analysePriorLaunches } from '../src/lib/scan/operator.js';
import { PROGRAMS, PUMP_TOTAL_SUPPLY, SOURCES } from '../src/lib/constants.js';

// Synthetic USD candles with hand-computable caps, never live market data.
const start = Math.floor(Date.now() / 60000) * 60 - 3600;
const createdAtMs = start * 1000;
const payloads = new Map();
const requests = [];
const unexpected = [];
let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (!payloads.has(url)) {
      unexpected.push(url);
      throw new Error(`Unexpected fixture request: ${url}`);
    }
    return new Response(JSON.stringify(payloads.get(url)), { status: 200 });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.deepEqual(unexpected, [], 'all requests must use local fixture responses');
});

function fixture(mint) {
  const poolsUrl = `${SOURCES.gecko}/networks/solana/tokens/${mint}/pools?page=1`;
  const candlesUrl = `${SOURCES.gecko}/networks/solana/pools/pool-${mint}/ohlcv/minute?aggregate=5&limit=1000&currency=usd`;
  payloads.set(poolsUrl, {
    data: [{
      attributes: { address: `pool-${mint}`, pool_created_at: new Date(createdAtMs).toISOString(), reserve_in_usd: '5000' },
      relationships: { dex: { data: { id: 'pumpfun' } } },
    }],
  });
  // Return newest first, matching the provider's order; production sorts these.
  payloads.set(candlesUrl, { data: { attributes: { ohlcv_list: [
    [start + 720, 0.05, 0.11, 0.04, 0.08, 13],
    [start + 240, 0.025, 0.06, 0.02, 0.05, 11],
    [start, 0.02, 0.03, 0.01, 0.025, 7],
  ] } } });
  return { count: (url) => requests.filter((r) => r === url).length, poolsUrl, candlesUrl };
}

function caps(h) { return [h.firstMcapUsd, h.peakMcapUsd, h.lastMcapUsd, h.checkpoints[5]]; }
function prices(h) { return [h.firstPriceUsd, h.peakPriceUsd, h.lastPriceUsd]; }

test('cold history preserves USD prices, caps, volume and launch-relative timing', async () => {
  fixture('history-cold');
  const h = await priceHistory('history-cold', { supply: 800, createdAtMs });
  assert.equal(h.available, true);
  assert.deepEqual(caps(h), [16, 88, 64, 40]);
  assert.deepEqual(prices(h), [0.02, 0.11, 0.08]);
  assert.equal(h.minutesToPeak, 12);
  assert.equal(h.totalVolumeUsd, 31);
});

test('warm history separates supplied token amounts and reuses pool lookup', async () => {
  const f = fixture('history-supply');
  const small = await priceHistory('history-supply', { supply: 800, createdAtMs });
  const large = await priceHistory('history-supply', { supply: 3200, createdAtMs });
  assert.deepEqual(caps(small), [16, 88, 64, 40]);
  assert.deepEqual(caps(large), [64, 352, 256, 160]);
  assert.deepEqual(prices(large), prices(small));
  assert.equal(large.drawdownFromPeak, small.drawdownFromPeak);
  assert.equal(large.totalVolumeUsd, small.totalVolumeUsd);
  assert.strictEqual(await priceHistory('history-supply', { supply: 800, createdAtMs }), small);
  assert.equal(f.count(f.poolsUrl), 1);
  assert.equal(f.count(f.candlesUrl), 2);
});

test('warm history separates explicit launch times and their checkpoints', async () => {
  fixture('history-time');
  const early = await priceHistory('history-time', { supply: 800, createdAtMs });
  const late = await priceHistory('history-time', { supply: 800, createdAtMs: createdAtMs + 8 * 60000 });
  assert.deepEqual([early.minutesToPeak, early.checkpoints[5]], [12, 40]);
  assert.deepEqual([late.minutesToPeak, late.checkpoints[5]], [4, 64]);
  assert.deepEqual(prices(late), prices(early));
  assert.equal(late.peakMcapUsd, early.peakMcapUsd);
  assert.strictEqual(await priceHistory('history-time', { supply: 800, createdAtMs }), early);
});

test('a newly discovered launch time does not reuse the pool-time summary', async () => {
  fixture('history-discovered-time');
  const fallback = await priceHistory('history-discovered-time', { supply: 800 });
  const discovered = await priceHistory('history-discovered-time', { supply: 800, createdAtMs: createdAtMs + 8 * 60000 });
  assert.deepEqual([fallback.minutesToPeak, fallback.checkpoints[5]], [12, 40]);
  assert.deepEqual([discovered.minutesToPeak, discovered.checkpoints[5]], [4, 64]);
});

test('default supply and absent or falsey launch time share the existing fallback cache', async () => {
  const f = fixture('history-defaults');
  const first = await priceHistory('history-defaults');
  assert.equal(first.peakMcapUsd, 0.11 * PUMP_TOTAL_SUPPLY);
  for (const options of [{}, { supply: undefined }, { supply: PUMP_TOTAL_SUPPLY },
    { supply: PUMP_TOTAL_SUPPLY, createdAtMs: undefined },
    { supply: PUMP_TOTAL_SUPPLY, createdAtMs: null },
    { supply: PUMP_TOTAL_SUPPLY, createdAtMs: 0 }]) {
    assert.strictEqual(await priceHistory('history-defaults', options), first);
  }
  assert.equal(f.count(f.poolsUrl), 1);
  assert.equal(f.count(f.candlesUrl), 1);
});

test('different mints have independent cached histories', async () => {
  fixture('history-mint-a');
  fixture('history-mint-b');
  const a = await priceHistory('history-mint-a', { supply: 800, createdAtMs });
  const b = await priceHistory('history-mint-b', { supply: 3200, createdAtMs });
  assert.deepEqual(caps(a), [16, 88, 64, 40]);
  assert.deepEqual(caps(b), [64, 352, 256, 160]);
  assert.notEqual(a.top.address, b.top.address);
});

test('prior-launch report reflects changed supply and discovered time after warming history', async () => {
  const mint = 'history-report';
  fixture(mint);
  for (const id of [mint, PROGRAMS.WSOL]) payloads.set(`${SOURCES.dexscreener}/latest/dex/tokens/${id}`, { pairs: [] });
  const accesses = [];
  const rpc = new Proxy({}, { get(_target, key) {
    accesses.push(String(key));
    throw new Error('This candle-history test must not call RPC');
  } });
  const analyse = (supply, time) => analysePriorLaunches(rpc, [{ mint, createdAt: time }], [], new Map(), { supply, maxDeep: 0 });
  const [first] = await analyse(800, undefined);
  assert.deepEqual([first.launchMcapUsd, first.peakMcapUsd, first.nowMcapUsd, first.minutesToPeak], [16, 88, 64, 12]);
  const [changed] = await analyse(3200, createdAtMs + 8 * 60000);
  assert.equal(changed.source, 'candles');
  assert.equal(changed.historyAvailable, true);
  assert.deepEqual([changed.launchMcapUsd, changed.peakMcapUsd, changed.nowMcapUsd, changed.minutesToPeak], [64, 352, 256, 4]);
  assert.equal(changed.checkpoints[5], 256);
  assert.deepEqual(accesses, []);
});

test('history remains cached before the existing two-minute expiry and refreshes at expiry', async (t) => {
  const f = fixture('history-expiry');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const options = { supply: 800, createdAtMs };
  const first = await priceHistory('history-expiry', options);
  now += 119999;
  assert.strictEqual(await priceHistory('history-expiry', options), first);
  assert.equal(f.count(f.candlesUrl), 1);
  payloads.get(f.candlesUrl).data.attributes.ohlcv_list[0][2] = 0.12;
  now += 1;
  const refreshed = await priceHistory('history-expiry', options);
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.peakMcapUsd, 96);
  assert.equal(f.count(f.poolsUrl), 2);
  assert.equal(f.count(f.candlesUrl), 2);
});
