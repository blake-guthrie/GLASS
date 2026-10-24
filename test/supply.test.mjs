import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impliedSupply } from '../src/lib/market.js';

test('impliedSupply: market cap / price (USDC-quoted pair with a non-pump supply)', () => {
  // A token quoted in USDC with 21,000,000 supply at $0.05 should imply 21M tokens,
  // not pump.fun's 1B.
  assert.equal(impliedSupply({ marketCapUsd: 1_050_000, priceUsd: 0.05 }), 21_000_000);
});

test('impliedSupply: falls back to FDV when marketCap is missing', () => {
  assert.equal(impliedSupply({ fdvUsd: 500_000, priceUsd: 0.01 }), 50_000_000);
});

test('impliedSupply: prefers market cap over FDV', () => {
  assert.equal(impliedSupply({ marketCapUsd: 100, fdvUsd: 999, priceUsd: 1 }), 100);
});

test('impliedSupply: null when there is no usable price', () => {
  assert.equal(impliedSupply({ marketCapUsd: 100, priceUsd: 0 }), null);
  assert.equal(impliedSupply({}), null);
  assert.equal(impliedSupply({ marketCapUsd: 100, priceUsd: NaN }), null);
});
