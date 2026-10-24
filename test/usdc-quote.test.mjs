import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsdQuoted, normalisePair, USD_STABLE_MINTS } from '../src/lib/market.js';

test('isUsdQuoted detects USDC/USDT mints and symbols correctly', () => {
  assert.equal(isUsdQuoted('USDC'), true);
  assert.equal(isUsdQuoted('usdt'), true);
  assert.equal(isUsdQuoted('USDH'), true);
  assert.equal(isUsdQuoted('SOL'), false);
  assert.equal(isUsdQuoted(null, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true);
  assert.equal(isUsdQuoted(null, 'So11111111111111111111111111111111111111112'), false);
});

test('normalisePair correctly flags USD quote and populates priceUsd from priceNative when needed', () => {
  const rawPair = {
    pairAddress: 'PairAddress123',
    dexId: 'raydium',
    baseToken: { address: 'MintToken123', name: 'Token', symbol: 'TOK' },
    quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    priceNative: '0.045',
    priceUsd: '0.045',
    marketCap: 45000,
  };
  const norm = normalisePair(rawPair);
  assert.equal(norm.isUsdQuoted, true);
  assert.equal(norm.quoteSymbol, 'USDC');
  assert.equal(norm.marketCapUsd, 45000);
  assert.equal(norm.priceUsd, 0.045);
});
