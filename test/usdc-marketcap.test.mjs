import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { impliedSupply, quoteToUsdMultiplier, normalisePair } from '../src/lib/market.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { runScan } from '../src/lib/scan/pipeline.js';

let index = 120;
async function marketStage(t, pair, supply) {
  const bytes = new Uint8Array(32).fill(++index);
  const mint = encodeBase58(bytes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith(`/latest/dex/tokens/${mint}`)) {
      return new Response(
        JSON.stringify({
          pairs: [{ chainId: 'solana', pairAddress: `pair-${mint}`, baseToken: { address: mint }, ...pair }],
        }),
      );
    }
    if (String(url).endsWith(`/latest/dex/tokens/${PROGRAMS.WSOL}`)) {
      return new Response(
        JSON.stringify({
          pairs: [{ chainId: 'solana', baseToken: { address: PROGRAMS.WSOL }, quoteToken: { symbol: 'USDC' }, priceUsd: '180' }],
        }),
      );
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const signal = { aborted: false };
  const rpc = {
    totalCalls: 0,
    getMintInfo: async (value) => {
      assert.equal(value, mint);
      if (supply instanceof Error) throw supply;
      return { supply, tokenProgram: PROGRAMS.TOKEN };
    },
  };
  const report = await runScan(rpc, mint, {
    signal,
    emit(stage, current) {
      if (stage === 'resolve' && current.stages.resolve.status === 'done') signal.aborted = true;
    },
  });
  assert.equal(report.stages.resolve.status, 'done');
  assert.deepEqual(report.errors, []);
  return report;
}

test('normalisePair preserves quoteMint and quoteSymbol for USDC-quoted pairs', () => {
  const p = normalisePair({
    pairAddress: 'pair1',
    dexId: 'raydium',
    baseToken: { address: 'mint1', name: 'Test', symbol: 'TST' },
    quoteToken: { address: PROGRAMS.USDC, symbol: 'USDC' },
    priceUsd: '0.025',
    priceNative: '0.025',
    marketCap: 25_000_000,
  });
  assert.equal(p.quoteMint, PROGRAMS.USDC);
  assert.equal(p.quoteSymbol, 'USDC');
  assert.equal(p.marketCapUsd, 25_000_000);
});

test('impliedSupply derives non-1B supply for USDC-quoted pairs from marketCap or FDV', () => {
  assert.equal(impliedSupply({ marketCapUsd: 1_050_000, priceUsd: 0.05 }), 21_000_000);
  assert.equal(impliedSupply({ fdvUsd: 500_000, priceUsd: 0.01 }), 50_000_000);
  assert.equal(impliedSupply({ marketCapUsd: 100, fdvUsd: 999, priceUsd: 1 }), 100);
  assert.equal(impliedSupply({ marketCapUsd: 100, priceUsd: 0 }), null);
  assert.equal(impliedSupply({}), null);
});

test('quoteToUsdMultiplier returns 1 for USDC/USDT and solPrice for WSOL', () => {
  assert.equal(quoteToUsdMultiplier(PROGRAMS.USDC, 220), 1);
  assert.equal(quoteToUsdMultiplier(PROGRAMS.USDT, 220), 1);
  assert.equal(quoteToUsdMultiplier(null, 220, 'USDC'), 1);
  assert.equal(quoteToUsdMultiplier(PROGRAMS.WSOL, 220), 220);
  assert.equal(quoteToUsdMultiplier(null, 220), 220);
  assert.equal(quoteToUsdMultiplier('unknown-mint', 220, 'BONK'), null);
});

test('extractLaunchEvents uses USDC decimals (1e6) and preserves USD quote', () => {
  const creator = encodeBase58(new Uint8Array(32).fill(7));
  const mint = encodeBase58(new Uint8Array(32).fill(8));
  const curve = encodeBase58(new Uint8Array(32).fill(9));
  const rec = {
    err: null,
    sig: 'usdc-trade-sig',
    slot: 100,
    blockTime: 1000,
    order: 1,
    feePayer: creator,
    systemTransfers: [],
    tokenDeltas: [],
    solDelta: {},
    pumpIxs: [{ user: creator, quoteMint: PROGRAMS.USDC, name: 'buy_v3', kind: 'buy' }],
    pumpEvents: [
      {
        type: 'trade',
        mint,
        user: creator,
        isBuy: true,
        quoteAmountRaw: 1_500_000,
        tokenAmountRaw: 60_000_000,
        virtualQuoteReservesRaw: 12_500_000_000,
        virtualTokenReservesRaw: 500_000_000_000,
      },
    ],
  };
  const creation = { record: { ...rec, sig: 'create' }, bondingCurve: curve };
  const [event] = extractLaunchEvents([rec], mint, creation);
  assert.equal(event.quoteMint, PROGRAMS.USDC);
  assert.equal(event.quoteSymbol, 'USDC');
  assert.equal(event.quoteAmount, 1.5);
  assert.equal(event.tokens, 60);
  assert.equal(event.priceQuote, 0.025);
});

test('USDC pair: missing cap derives from USD price and confirmed supply without SOL multiplier', async (t) => {
  const report = await marketStage(
    t,
    {
      quoteToken: { symbol: 'USDC', address: PROGRAMS.USDC },
      priceUsd: '0.002',
      priceNative: '0.002',
      marketCap: null,
      fdv: null,
    },
    200_000_000,
  );
  assert.equal(report.market.marketCapUsd, 400_000);
  assert.match(report.market.mcapSource, /USD price/);
  assert.equal(report.market.priceUsd, 0.002);
});

test('reported market cap is preserved when DexScreener provides it', async (t) => {
  const report = await marketStage(t, { priceUsd: '0.002', marketCap: 123_456, fdv: 400_000 }, 200_000_000);
  assert.equal(report.market.marketCapUsd, 123_456);
  assert.equal(report.market.mcapSource, undefined);
});
