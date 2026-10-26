import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS, ROUTER_LABELS } from '../src/lib/constants.js';
import { routeLabel } from '../src/lib/scan/fingerprint.js';
import known from '../src/data/known.js';

test('Meteora DAMM v2: program ID and router label classification', () => {
  const dammV2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
  assert.equal(PROGRAMS.METEORA_DAMM_V2, dammV2);
  assert.equal(ROUTER_LABELS[dammV2], 'Meteora DAMM v2');
  assert.equal(known.programs[dammV2], 'Meteora DAMM v2');
  assert.equal(routeLabel(dammV2), 'Meteora DAMM v2');
});

test('Meteora DAMM v2: preserves existing router labels', () => {
  assert.equal(routeLabel(PROGRAMS.METEORA_DLMM), 'Meteora');
  assert.equal(routeLabel('BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW'), 'Photon');
  assert.equal(routeLabel(PROGRAMS.PUMP), 'pump.fun direct');
  assert.equal(routeLabel(PROGRAMS.PUMPSWAP), 'PumpSwap');
  assert.equal(routeLabel(PROGRAMS.JUPITER_V6), 'Jupiter');
  assert.equal(routeLabel(PROGRAMS.RAYDIUM_AMM), 'Raydium');
  assert.equal(routeLabel(PROGRAMS.RAYDIUM_CPMM), 'Raydium CPMM');
});

test('Meteora DAMM v2: unknown-address controls truncate gracefully', () => {
  // Unknown router programs must format as 4-character truncated string, not throw or misclassify
  const unknownProg = '11111111111111111111111111111111';
  assert.equal(known.programs[unknownProg], undefined);
  assert.equal(routeLabel(unknownProg), '1111\u20261111');
  assert.equal(routeLabel(null), 'unknown');
  assert.equal(routeLabel(undefined), 'unknown');
});
