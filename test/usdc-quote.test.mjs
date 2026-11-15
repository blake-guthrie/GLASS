import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';
import { ANCHOR_EVENT_CPI, PROGRAMS, PUMP_EVENTS } from '../src/lib/constants.js';
import { normalisePair } from '../src/lib/market.js';
import { decodeCurve } from '../src/lib/livewatch.js';
import { decodePumpEvent, parseTx } from '../src/lib/txparse.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url), 'utf8'));

const LE = (n, bytes = 8) => {
  const b = new Uint8Array(bytes);
  let v = BigInt(n);
  for (let i = 0; i < bytes; i++) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
};
const cat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const PK = (seed) => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(seed).subarray(0, 32));
  return b;
};

function tradeEvent({ quoteAmountRaw = 2_500_000n, vQuoteRaw = 30_000_000_000n, vTokRaw = 1_000_000_000_000n } = {}) {
  const data = cat(
    Uint8Array.from(ANCHOR_EVENT_CPI),
    Uint8Array.from(PUMP_EVENTS.TradeEvent),
    PK('minttoken'),
    LE(quoteAmountRaw),
    LE(1_000_000_000n),
    Uint8Array.from([1]),
    PK('user'),
    LE(1_700_000_000n),
    LE(vQuoteRaw),
    LE(vTokRaw),
    LE(0n),
    LE(0n),
    PK('feeperc'),
    LE(0n),
    LE(0n),
    PK('creatorxx'),
    LE(0n),
    LE(0n),
  );
  return { data: encodeBase58(data), accounts: [] };
}

function curveAccount({ quoteMint, vQuoteRaw = 30_000_000_000n, vTokRaw = 1_000_000_000_000n, size = 115 } = {}) {
  const bytes = new Uint8Array(size);
  bytes.set(LE(vTokRaw), 8);
  bytes.set(LE(vQuoteRaw), 16);
  bytes.set(LE(900_000_000_000n), 24);
  bytes.set(LE(vQuoteRaw), 32);
  bytes.set(LE(1_000_000_000_000n), 40);
  bytes[48] = 0;
  if (quoteMint && size >= 115) bytes.set(decodeBase58(quoteMint), 83);
  return Buffer.from(bytes).toString('base64');
}

test('normalisePair derives a missing market cap for USDC-quoted pairs', () => {
  const pair = normalisePair({
    baseToken: { address: 'mint', name: 'Token', symbol: 'TOK' },
    quoteToken: { address: USDC, symbol: 'USDC' },
    priceNative: '0.00042',
    liquidity: { usd: 1000 },
  });
  assert.equal(pair.quoteMint, USDC);
  assert.equal(pair.isUsdQuoted, true);
  assert.equal(pair.priceUsd, 0.00042);
  assert.ok(Math.abs(pair.marketCapUsd - 420_000) < 1e-3);
});

test('normalisePair keeps the SOL path unchanged when priceUsd is absent', () => {
  const pair = normalisePair({
    baseToken: { address: 'mint' },
    quoteToken: { address: PROGRAMS.WSOL, symbol: 'SOL' },
    priceNative: '0.00003',
  });
  assert.equal(pair.isUsdQuoted, false);
  assert.equal(pair.priceUsd, null);
  assert.equal(pair.marketCapUsd, null);
});

test('decodeCurve reads the quote mint and scales USDC reserves at 6 decimals', () => {
  const curve = decodeCurve(curveAccount({ quoteMint: USDC }));
  assert.equal(curve.quoteMint, USDC);
  assert.equal(curve.isUsdQuoted, true);
  assert.equal(curve.vSol, 30_000);
  assert.equal(curve.vTok, 1_000_000);
  assert.equal(curve.priceSol, 0.03);
});

test('decodeCurve treats a legacy curve as SOL-quoted', () => {
  const curve = decodeCurve(curveAccount({ size: 81 }));
  assert.equal(curve.quoteMint, null);
  assert.equal(curve.isUsdQuoted, false);
  assert.equal(curve.vSol, 30);
});

test('decodePumpEvent scales a USDC quote amount at 6 decimals', () => {
  const event = decodePumpEvent(tradeEvent(), USDC);
  assert.equal(event.quoteMint, USDC);
  assert.equal(event.quoteAmount, 2.5);
  assert.equal(event.vSol, 30_000);
  assert.equal(event.priceQuote, 0.03);
});

test('decodePumpEvent keeps the SOL default for legacy events', () => {
  const event = decodePumpEvent(tradeEvent());
  assert.equal(event.quoteAmount, 0.0025);
  assert.equal(event.vSol, 30);
  assert.equal(event.priceQuote, 0.00003);
});

test('parseTx inherits the WSOL quote mint for a SOL-quoted trade', () => {
  const buy = parseTx(fx.txs.buy, fx.sigs.buy);
  const event = buy.pumpEvents.find((e) => e.type === 'trade');
  assert.equal(event.quoteMint, PROGRAMS.WSOL);
  assert.ok(event.vSol > 30 && event.vTok < 1_073_000_000);
});
