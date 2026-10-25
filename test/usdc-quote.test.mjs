// USDC-quoted pairs: every quote-denominated field must scale by the quote asset's decimals
// (6 for USD stables, 9 for SOL) and must NOT be multiplied by the SOL price when the quote is
// already dollars. Regression tests for the quote-aware decode + USD conversion paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteDecimals, quoteToUsd, USDC_MINT, USDT_MINT, PROGRAMS, PUMP_EVENTS, ANCHOR_EVENT_CPI, PUMP_IX, PUMP_TOTAL_SUPPLY } from '../src/lib/constants.js';
import { decodePumpEvent, parseTx, classifyForMint } from '../src/lib/txparse.js';
import { decodeCurve } from '../src/lib/livewatch.js';
import { encodeBase58, decodeBase58 } from '../src/lib/base58.js';

// ---------- byte helpers ----------
const LE = (n, bytes = 8) => {
  const b = new Uint8Array(bytes);
  let v = BigInt(n);
  for (let i = 0; i < bytes; i++) { b[i] = Number(v & 255n); v >>= 8n; }
  return b;
};
const cat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const PK = (seed) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(seed).subarray(0, 32)); return b; };
const USDC_BYTES = decodeBase58(USDC_MINT);

// A pump.fun TradeEvent exactly as the program emits it (Anchor event CPI).
function tradeEventIx({ quoteAmountRaw = 2_500_000n, vQuoteRaw = 30_000_000_000n, vTokRaw = 1_000_000_000_000n, user = PK('user') } = {}) {
  const data = cat(
    Uint8Array.from(ANCHOR_EVENT_CPI),
    Uint8Array.from(PUMP_EVENTS.TradeEvent),
    PK('minttoken'),
    LE(quoteAmountRaw),
    LE(1_000_000_000n), // tokenAmount raw (6 decimals)
    Uint8Array.from([1]), // isBuy
    user,
    LE(1_700_000_000n), // timestamp
    LE(vQuoteRaw), // post-trade virtual quote reserves
    LE(vTokRaw), // post-trade virtual token reserves
    LE(0n), LE(0n),
    PK('feeperc'),
    LE(0n),
    LE(0n), // fee
    PK('creatorxx'),
    LE(0n),
    LE(0n), // creator fee
  );
  return { data: encodeBase58(data), accounts: [] };
}

// ---------- decimals + USD conversion ----------

test('quoteDecimals: USD stables are 6 decimals, SOL and unknown/legacy are 9', () => {
  assert.equal(quoteDecimals(USDC_MINT), 6);
  assert.equal(quoteDecimals(USDT_MINT), 6);
  assert.equal(quoteDecimals(PROGRAMS.WSOL), 9);
  assert.equal(quoteDecimals(null), 9);
  assert.equal(quoteDecimals('unknownmint'), 9);
});

test('quoteToUsd: USD stables convert 1:1, SOL and unknown use the SOL price', () => {
  assert.equal(quoteToUsd(USDC_MINT, 200), 1);
  assert.equal(quoteToUsd(USDT_MINT, 200), 1);
  assert.equal(quoteToUsd(PROGRAMS.WSOL, 200), 200);
  assert.equal(quoteToUsd(null, 200), 200);
});

// ---------- TradeEvent decode ----------

test('decodePumpEvent: USDC quote scales quote fields by 6 decimals (not lamports)', () => {
  const ev = decodePumpEvent(tradeEventIx(), { quoteMint: USDC_MINT });
  assert.equal(ev.quoteMint, USDC_MINT);
  assert.equal(ev.quoteDecimals, 6);
  assert.equal(ev.quoteAmount, 2.5); // 2,500,000 raw USDC
  assert.equal(ev.vSol, 30_000); // 30,000 USDC in the curve
  assert.equal(ev.priceQuote, 30_000 / 1_000_000); // quote per token
});

test('decodePumpEvent: SOL (default) decode is unchanged', () => {
  const ev = decodePumpEvent(tradeEventIx());
  assert.equal(ev.quoteAmount, 2_500_000 / 1e9);
  assert.equal(ev.vSol, 30);
  assert.equal(ev.quoteDecimals, 9);
});

test('decodePumpEvent: a USDC trade decodes 1000x larger than the lamport assumption', () => {
  const usdc = decodePumpEvent(tradeEventIx(), { quoteMint: USDC_MINT });
  const legacy = decodePumpEvent(tradeEventIx());
  assert.equal(usdc.quoteAmount / legacy.quoteAmount, 1000);
});

// ---------- bonding curve ----------

const curveB64 = (extra = null) => {
  const base = cat(
    new Uint8Array(8), // discriminator
    LE(1_500_000_000_000n), // vTok
    LE(45_000_000_000n), // vQuote (45,000 USDC would be nonsense for SOL, fine for USDC)
    LE(0n), LE(0n),
    LE(BigInt(PUMP_TOTAL_SUPPLY) * 1_000_000n),
    Uint8Array.from([0]), // complete flag
  );
  const bytes = extra ? cat(base, extra) : base;
  return Buffer.from(bytes).toString('base64');
};

test('decodeCurve: a v2 curve with the appended quote mint decodes USDC quantities', () => {
  const c = decodeCurve(curveB64(USDC_BYTES));
  assert.equal(c.quoteMint, USDC_MINT);
  assert.equal(c.quoteDecimals, 6);
  assert.equal(c.vSol, 45_000); // 45,000 USDC, not 45 SOL
  assert.equal(c.supply, PUMP_TOTAL_SUPPLY);
});

test('decodeCurve: legacy 49-byte SOL curve is unchanged', () => {
  const c = decodeCurve(curveB64());
  assert.equal(c.quoteMint, null);
  assert.equal(c.quoteDecimals, 9);
  assert.equal(c.vSol, 45);
});

// ---------- parseTx plumbing: inner TradeEvent inherits the outer ix quote ----------

test('parseTx: inner TradeEvent inherits the quote mint from the outer pump ix', () => {
  const userKey = encodeBase58(PK('buyerwallet'));
  const mint = encodeBase58(PK('minttoken'));
  const buy = {
    programId: PROGRAMS.PUMP,
    accounts: ['FEEACCT', mint, USDC_MINT, 'acct3', 'acct4', 'acct5', 'acct6', 'acct7', userKey],
    data: encodeBase58(cat(Uint8Array.from(PUMP_IX.buy_v2), LE(1000n), LE(2000n))),
  };
  const keys = [userKey, 'FEEACCT', mint, USDC_MINT].map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true }));
  const tx = {
    transaction: { message: { accountKeys: keys, instructions: [buy] } },
    meta: {
      innerInstructions: [{ index: 0, instructions: [{ programId: PROGRAMS.PUMP, accounts: [], data: tradeEventIx({ user: decodeBase58(userKey) }).data }] }],
      preBalances: [1e9, 1e9, 0, 0],
      postBalances: [1e9, 1e9, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      fee: 5000,
      err: null,
      logMessages: [],
    },
  };
  const rec = parseTx(tx, 'SIG');
  assert.ok(rec);
  assert.equal(rec.pumpEvents.length, 1);
  assert.equal(rec.pumpEvents[0].quoteMint, USDC_MINT);
  assert.equal(rec.pumpEvents[0].quoteAmount, 2.5); // scaled by 6, not 9
  const c = classifyForMint(rec, mint, userKey);
  assert.equal(c.fromEvent, true);
  assert.equal(c.quoteMint, USDC_MINT);
});

// ---------- SOL pairs keep working end to end ----------

test('parseTx: a SOL-quoted (legacy) outer ix leaves the event on 9-decimals', () => {
  const userKey = encodeBase58(PK('buyerwallet'));
  const mint = encodeBase58(PK('minttoken'));
  const buy = {
    programId: PROGRAMS.PUMP,
    accounts: ['FEEACCT', mint, 'other', 'acct3', 'acct4', 'acct5', 'acct6', 'acct7', userKey],
    data: encodeBase58(cat(Uint8Array.from(PUMP_IX.buy_v2), LE(1000n), LE(2000n))),
  };
  const keys = [userKey, 'FEEACCT', mint, 'other'].map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true }));
  const tx = {
    transaction: { message: { accountKeys: keys, instructions: [buy] } },
    meta: {
      innerInstructions: [{ index: 0, instructions: [{ programId: PROGRAMS.PUMP, accounts: [], data: tradeEventIx({ user: decodeBase58(userKey) }).data }] }],
      preBalances: [1e9, 1e9, 0, 0],
      postBalances: [1e9, 1e9, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      fee: 5000,
      err: null,
      logMessages: [],
    },
  };
  const rec = parseTx(tx, 'SIG2');
  assert.ok(rec);
  assert.equal(rec.pumpEvents.length, 1);
  assert.equal(rec.pumpEvents[0].quoteMint, 'other');
  assert.equal(rec.pumpEvents[0].quoteAmount, 2_500_000 / 1e9);
});
