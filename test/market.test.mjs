import { test } from 'node:test';
import assert from 'node:assert/strict';

const MINT = 'fixture-target-mint';
const OTHER = 'fixture-counterpart-mint';
const NOW = Date.parse('2026-10-25T00:00:00Z');
let fixtureId = 0;

function pool(address, { targetSide = 'quote', dex = 'raydium', ageDays = 1, reserve = 1000 } = {}) {
  return {
    attributes: {
      address,
      name: targetSide === 'base' ? 'TARGET / USDC' : 'USDC / TARGET',
      pool_created_at: new Date(NOW - ageDays * 86400e3).toISOString(),
      reserve_in_usd: String(reserve),
      base_token_price_usd: targetSide === 'base' ? '0.02' : '1',
      quote_token_price_usd: targetSide === 'quote' ? '0.02' : '1',
    },
    relationships: {
      dex: { data: { id: dex } },
      base_token: { data: { id: `solana_${targetSide === 'base' ? MINT : OTHER}` } },
      quote_token: { data: { id: `solana_${targetSide === 'quote' ? MINT : OTHER}` } },
    },
  };
}

async function marketFixture(t, pools, candlesFor) {
  // Advance the clock between requests so the production rate limiter never sleeps.
  let clock = NOW;
  t.mock.method(Date, 'now', () => (clock += 2000));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith(`/tokens/${MINT}/pools`)) {
      return Response.json({ data: pools });
    }
    const match = url.pathname.match(/\/pools\/([^/]+)\/ohlcv\/(minute|hour|day)$/);
    if (!match) return Response.json({ error: 'Unexpected fixture URL' }, { status: 404 });
    const [, address, timeframe] = match;
    const p = pools.find((entry) => entry.attributes.address === address);
    const token = url.searchParams.get('token') || 'base';
    const targetSide = p?.relationships.base_token.data.id === `solana_${MINT}` ? 'base' : 'quote';
    // Model the API contract: currency=usd does not select the target token.
    const isTarget = token === MINT || token === targetSide;
    const candles = candlesFor({ address, timeframe, isTarget, url });
    if (candles === null) return Response.json({ error: 'Token candles unavailable' }, { status: 404 });
    return Response.json({ data: { attributes: { ohlcv_list: candles } } });
  });
  const market = await import(`../src/lib/market.js?fixture=${++fixtureId}`);
  return { ...market, requests };
}

test('priceHistory values the requested quote token, not the USDC pool base', async (t) => {
  const start = NOW / 1000 - 86400;
  const market = await marketFixture(t, [pool('usdc-base')], ({ isTarget }) => (
    isTarget ? [[start, 0.02, 0.05, 0.01, 0.03, 100]] : [[start, 1, 1.01, 0.99, 1, 100]]
  ));
  const history = await market.priceHistory(MINT, { supply: 1000 });
  assert.equal(history.available, true);
  assert.equal(history.firstMcapUsd, 20);
  assert.equal(history.peakMcapUsd, 50);
  assert.equal(history.lastMcapUsd, 30);
  assert.equal(history.drawdownFromPeak, 0.4);
  assert.equal(history.checkpoints[5], 30);
});

for (const curveDex of ['pump-fun', 'pumpfun']) {
  test(`priceHistory keeps the same mint across minute/hour/day and a reversed ${curveDex} pool`, async (t) => {
    const start = NOW / 1000 - 45 * 86400;
    const candles = {
      'main:day': [[start, 0.01, 0.04, 0.005, 0.02, 10]],
      'main:hour': [[start + 86400, 0.02, 0.08, 0.01, 0.04, 20]],
      'main:minute': [[start + 2 * 86400, 0.04, 0.06, 0.03, 0.05, 30]],
      'curve:minute': [[start - 300, 0.005, 0.02, 0.001, 0.01, 40]],
    };
    const market = await marketFixture(t, [
      pool('main', { targetSide: 'base', ageDays: 45, reserve: 1000 }),
      pool('curve', { targetSide: 'quote', dex: curveDex, ageDays: 45, reserve: 100 }),
    ], ({ address, timeframe, isTarget }) => (
      isTarget ? candles[`${address}:${timeframe}`] : [[start - 300, 1, 1.01, 0.99, 1, 40]]
    ));
    const history = await market.priceHistory(MINT, { supply: 1000 });
    assert.equal(history.candles, 4);
    assert.equal(history.firstMcapUsd, 5);
    assert.equal(history.peakMcapUsd, 80);
    assert.equal(history.lastMcapUsd, 50);
    assert.equal(history.totalVolumeUsd, 100);
    assert.deepEqual(market.requests.filter((url) => url.pathname.includes('/ohlcv/')).map((url) => url.searchParams.get('token')), [MINT, MINT, MINT, MINT]);
  });
}

test('geckoOhlcv preserves base defaults and pagination while accepting an explicit quote selector', async (t) => {
  const base = [[1000, 1, 1.01, 0.99, 1, 10]];
  const quote = [[1000, 0.02, 0.05, 0.01, 0.03, 10]];
  const market = await marketFixture(t, [pool('direct')], ({ isTarget }) => isTarget ? quote : base);
  assert.deepEqual(await market.geckoOhlcv('direct'), [{ t: 1000, o: 1, h: 1.01, l: 0.99, c: 1, v: 10 }]);
  assert.deepEqual(await market.geckoOhlcv('direct', 'hour', 1, 2, 1234, 'quote'), [{ t: 1000, o: 0.02, h: 0.05, l: 0.01, c: 0.03, v: 10 }]);
  const request = market.requests.at(-1);
  assert.equal(request.searchParams.get('before_timestamp'), '1234');
  assert.equal(request.searchParams.get('aggregate'), '1');
  assert.equal(request.searchParams.get('limit'), '2');
  assert.equal(request.searchParams.get('currency'), 'usd');
});

test('priceHistory reports unavailable when target candles are missing instead of using counterpart prices', async (t) => {
  const market = await marketFixture(t, [pool('missing')], ({ isTarget }) => (
    isTarget ? null : [[1000, 1, 1.01, 0.99, 1, 10]]
  ));
  const history = await market.priceHistory(MINT, { supply: 1000 });
  assert.equal(history.available, false);
  assert.deepEqual(history.pools, ['missing']);
});
