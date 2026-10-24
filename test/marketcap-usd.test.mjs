import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { runScan } from '../src/lib/scan/pipeline.js';

// Exercise the real resolve/market stage with synthetic HTTP and mint fixtures.
// Abort immediately after resolve: no historical scan, chain access or trading.
let index = 120;
async function marketStage(t, pair, supply) {
  const bytes = new Uint8Array(32).fill(++index);
  const mint = encodeBase58(bytes);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith(`/latest/dex/tokens/${mint}`)) {
      return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', pairAddress: `pair-${mint}`, baseToken: { address: mint }, ...pair }] }));
    }
    if (String(url).endsWith(`/latest/dex/tokens/${PROGRAMS.WSOL}`)) {
      return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', baseToken: { address: PROGRAMS.WSOL }, quoteToken: { symbol: 'USDC' }, priceUsd: '180' }] }));
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const signal = { aborted: false };
  const rpc = { totalCalls: 0, getMintInfo: async (value) => {
    assert.equal(value, mint);
    if (supply instanceof Error) throw supply;
    return { supply, tokenProgram: PROGRAMS.TOKEN };
  } };
  const report = await runScan(rpc, mint, { signal, emit(stage, current) {
    if (stage === 'resolve' && current.stages.resolve.status === 'done') signal.aborted = true;
  } });
  assert.equal(report.stages.resolve.status, 'done');
  assert.deepEqual(report.errors, []);
  assert.ok(calls.some((url) => url.endsWith(mint)));
  return report;
}

test('USDC pair: missing cap derives from USD price and actual supply, without SOL multiplier', async (t) => {
  const report = await marketStage(t, { quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: '0.002', priceNative: '0.002', marketCap: null, fdv: null }, 200_000_000);
  assert.equal(report.market.marketCapUsd, 400_000);
  assert.match(report.market.mcapSource, /USD price/);
  assert.equal(report.market.priceUsd, 0.002);
});

test('SOL pair: USD price is not converted from SOL a second time', async (t) => {
  const report = await marketStage(t, { quoteToken: { symbol: 'SOL', address: PROGRAMS.WSOL }, priceUsd: '0.018', priceNative: '0.0001' }, 100_000_000);
  assert.ok(Math.abs(report.market.marketCapUsd - 1_800_000) < 1e-6);
});

test('reported market cap is preserved even when price times supply differs', async (t) => {
  const report = await marketStage(t, { priceUsd: '0.002', marketCap: 123_456, fdv: 400_000 }, 200_000_000);
  assert.equal(report.market.marketCapUsd, 123_456);
  assert.equal(report.market.mcapSource, undefined);
});

test('existing FDV fallback remains intact', async (t) => {
  const report = await marketStage(t, { priceUsd: '0.002', marketCap: null, fdv: 345_678 }, 200_000_000);
  assert.equal(report.market.marketCapUsd, 345_678);
});

test('a native-only quote is not assumed to be USD', async (t) => {
  const report = await marketStage(t, { priceNative: '0.002', quoteToken: { symbol: 'USDC' } }, 200_000_000);
  assert.equal(report.market.marketCapUsd, null);
});

test('nonfinite price cannot create a displayed USD market cap', async (t) => {
  const report = await marketStage(t, { priceUsd: 'Infinity' }, 200_000_000);
  assert.equal(report.market.marketCapUsd, null);
});

test('overflowing product cannot create a displayed USD market cap', async (t) => {
  const report = await marketStage(t, { priceUsd: '1e308' }, 2);
  assert.equal(report.market.marketCapUsd, null);
});

for (const supply of [undefined, null, 0, -1, Infinity, NaN, '200000000', new Error('mint unavailable')]) {
  test(`unconfirmed or invalid supply cannot produce a new USD cap: ${String(supply)}`, async (t) => {
    const report = await marketStage(t, { priceUsd: '0.002', marketCap: null, fdv: null }, supply);
    assert.equal(report.market.marketCapUsd, null);
    assert.equal(report.market.mcapSource, undefined);
  });
}
