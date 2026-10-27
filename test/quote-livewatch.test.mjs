import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeCurve } from '../src/lib/livewatch.js';
import { decodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS } from '../src/lib/constants.js';

function curve(mint, quoteReserves, size = 166) {
  const b = Buffer.alloc(size);
  b.set([23, 183, 248, 55, 96, 216, 172, 96]);
  b.writeBigUInt64LE(60n * 1000000n, 8);
  b.writeBigUInt64LE(BigInt(quoteReserves), 16);
  b.writeBigUInt64LE(1000000000n * 1000000n, 40);
  if (mint && size >= 115) b.set(decodeBase58(mint), 83);
  return b;
}

test('live curve uses six-decimal USDC reserves and never reports them as SOL', () => {
  const c = decodeCurve(curve(PROGRAMS.USDC, 1500000).toString('base64'));
  assert.equal(c.quoteSymbol, 'USDC');
  assert.equal(c.priceQuote, 0.025);
  assert.equal(c.priceSol, null);
});

test('legacy, native-SOL default and wrapped-SOL curves retain SOL units', () => {
  for (const b of [curve(null, 1500000000, 49), curve(null, 1500000000), curve(PROGRAMS.WSOL, 1500000000)]) {
    const c = decodeCurve(b.toString('base64'));
    assert.equal(c.quoteSymbol, 'SOL');
    assert.equal(c.priceQuote, 0.025);
    assert.equal(c.priceSol, 0.025);
  }
});

test('unknown and incomplete live quote fields do not create a SOL price', () => {
  assert.equal(decodeCurve(curve(PROGRAMS.TOKEN, 1500000).toString('base64')).priceQuote, null);
  const b = curve(PROGRAMS.USDC, 1500000);
  for (let size = 84; size < 115; size++) assert.equal(decodeCurve(b.subarray(0, size).toString('base64')), null);
});


test('captured SOL curve uses native quote default without losing its price', () => {
  const f = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-mainnet-sol.json', import.meta.url)));
  const c = decodeCurve(f.curve.account.data[0]);
  assert.equal(c.quoteSymbol, 'SOL');
  assert.equal(c.quoteMint, PROGRAMS.WSOL);
  assert.ok(c.priceSol > 0);
  assert.equal(c.priceQuote, c.priceSol);
});


test('captured USDC curve keeps its native quote and matches the sell event reserves', () => {
  const f = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-mainnet-usdc.json', import.meta.url)));
  const c = decodeCurve(f.curve.account.data[0]);
  assert.equal(c.quoteMint, PROGRAMS.USDC);
  assert.equal(c.quoteSymbol, 'USDC');
  assert.equal(c.vQuote, 3.810622);
  assert.equal(c.priceQuote, 3.810622 / 1577840216.899361);
  assert.equal(c.priceSol, null);
});
