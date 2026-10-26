import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { decodeBase58, encodeBase58, isBase58Address, readU64LE } from '../src/lib/base58.js';
import { isOnCurve, findProgramAddress } from '../src/lib/pda.js';
import { PUMP_IX, PROGRAMS, JITO_TIP_ACCOUNTS, ANCHOR_EVENT_CPI, PUMP_EVENTS, USDC_MINT } from '../src/lib/constants.js';
import { parseTx, txInitialisesMint, classifyForMint, decodePumpIx } from '../src/lib/txparse.js';
import { derivePumpAccounts, extractLaunchEvents } from '../src/lib/scan/launch.js';
import { quoteInfo, quoteUsdPrice, mcapUsdFromQuote } from '../src/lib/quote.js';
import { decodeCurve } from '../src/lib/livewatch.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url), 'utf8'));

test('base58 round-trips and matches known vectors', () => {
  assert.equal(encodeBase58(new Uint8Array(32)), '1'.repeat(32));
  assert.deepEqual([...decodeBase58('11111111111111111111111111111111')], new Array(32).fill(0));
  const pump = decodeBase58(PROGRAMS.PUMP);
  assert.equal(pump.length, 32);
  assert.equal(encodeBase58(pump), PROGRAMS.PUMP);
  for (let i = 0; i < 20; i++) {
    const bytes = new Uint8Array(32).map(() => Math.floor(Math.random() * 256));
    assert.deepEqual([...decodeBase58(encodeBase58(bytes))], [...bytes]);
  }
  assert.ok(isBase58Address(PROGRAMS.TOKEN_2022));
  assert.ok(!isBase58Address('not-an-address'));
  assert.ok(!isBase58Address('0OIl'));
  assert.equal(readU64LE(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), 0), 1n);
  assert.equal(readU64LE(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1), 0), 1n << 56n);
});

test('pump.fun instruction discriminators are the Anchor sighashes', () => {
  for (const [name, bytes] of Object.entries(PUMP_IX)) {
    const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
    assert.deepEqual(bytes, want, name);
  }
});

test('ed25519 on-curve check distinguishes wallets from PDAs', () => {
  assert.equal(isOnCurve(decodeBase58(fx.creator)), true, 'creator wallet is a real keypair');
  assert.equal(isOnCurve(decodeBase58(fx.bondingCurve)), false, 'bonding curve is a PDA');
  // Jito tip accounts are PDAs of the tip-payment program → off-curve
  for (const t of JITO_TIP_ACCOUNTS) assert.equal(isOnCurve(decodeBase58(t)), false, `tip account ${t}`);
});

test('PDA derivation reproduces the bonding curve for the fixture mint', async () => {
  const { bondingCurve } = await derivePumpAccounts(fx.mint);
  assert.equal(bondingCurve, fx.bondingCurve);
  const pda = await findProgramAddress(['bonding-curve', decodeBase58(fx.mint)], PROGRAMS.PUMP);
  assert.equal(pda.address, fx.bondingCurve);
  assert.ok(pda.bump >= 0 && pda.bump <= 255);
});

test('parseTx: create tx initialises the mint and carries the dev buy', () => {
  const raw = fx.txs.create;
  assert.ok(txInitialisesMint(raw, fx.mint));
  const rec = parseTx(raw, fx.sigs.create);
  assert.equal(rec.feePayer, fx.creator);
  assert.equal(rec.slot, fx.slot);
  const create = rec.pumpIxs.find((p) => p.name === 'create' || p.name === 'create_v2');
  assert.ok(create, 'create instruction decoded');
  assert.equal(create.mint, fx.mint);
  assert.ok(create.tokenName && create.symbol, 'metadata strings decoded');
  const devBuy = rec.tokenDeltas.find((d) => d.owner === fx.creator && d.mint === fx.mint);
  assert.ok(devBuy && devBuy.delta > 0, 'creator received tokens in the create tx');
  assert.ok(rec.solDelta[fx.bondingCurve] > 0, 'SOL flowed into the bonding curve');
  assert.ok(rec.cuLimit == null || rec.cuLimit > 0);
});

test('parseTx: buy/sell variants decode, and TradeEvents give exact amounts + price', () => {
  const buy = parseTx(fx.txs.buy, fx.sigs.buy);
  const b = buy.pumpIxs.find((p) => p.kind === 'buy');
  assert.ok(b, 'buy ix decoded');
  assert.equal(b.name, 'buy_exact_quote_in_v3');
  assert.equal(b.mint, fx.mint);
  assert.equal(b.user, buy.feePayer);
  assert.ok(b.solIn > 0);
  const tev = buy.pumpEvents.find((e) => e.type === 'trade');
  assert.ok(tev, 'TradeEvent decoded');
  assert.equal(tev.mint, fx.mint);
  assert.equal(tev.user, buy.feePayer);
  assert.equal(tev.isBuy, true);
  assert.ok(tev.tokenAmount > 0 && tev.quoteAmount > 0 && tev.priceQuote > 0);
  assert.equal(tev.creator, fx.creator);
  assert.ok(tev.vSol > 30 && tev.vTok < 1_073_000_000, 'virtual reserves move the right way after a buy');
  const c = classifyForMint(buy, fx.mint, buy.feePayer);
  assert.equal(c.side, 'buy');
  assert.ok(c.fromEvent);
  assert.equal(c.tokens, tev.tokenAmount);

  const sell = parseTx(fx.txs.sell, fx.sigs.sell);
  const s = sell.pumpIxs.find((p) => p.kind === 'sell');
  assert.ok(s, 'sell ix decoded');
  assert.equal(s.name, 'sell_v3');
  assert.ok(s.tokenAmount > 0);
  const cs = classifyForMint(sell, fx.mint, sell.feePayer);
  assert.equal(cs.side, 'sell');
  assert.ok(cs.sol > 0, 'seller received SOL');

  const create = parseTx(fx.txs.create, fx.sigs.create);
  const cev = create.pumpEvents.find((e) => e.type === 'create');
  assert.ok(cev, 'CreateEvent decoded');
  assert.equal(cev.mint, fx.mint);
  assert.equal(cev.bondingCurve, fx.bondingCurve);
  assert.equal(cev.creator, fx.creator);
  assert.equal(cev.supply, 1_000_000_000);
  assert.equal(cev.vSol, 30);
  const devTrade = create.pumpEvents.find((e) => e.type === 'trade');
  assert.ok(devTrade && devTrade.isBuy && devTrade.user === fx.creator, 'dev buy logged in the create tx');
  const devIx = create.pumpIxs.find((p) => p.kind === 'buy');
  assert.equal(devIx?.name, 'buy_v2');
  // SOL-quoted curve: the quote-aware instructions name WSOL, amounts stay in SOL
  assert.equal(b.quoteMint, PROGRAMS.WSOL);
  assert.equal(tev.quoteMint, PROGRAMS.WSOL);
  assert.equal(tev.quoteUsd, false);
  assert.equal(c.quoteUsd, false);
});

test('parseTx: Jito tip detection on a tipped launch buy', () => {
  if (!fx.txs.tippedBuy) return;
  const rec = parseTx(fx.txs.tippedBuy, fx.sigs.tippedBuy);
  assert.ok(rec.jitoTip > 0, 'tip lamports');
  assert.ok(JITO_TIP_ACCOUNTS.has(rec.tipAccount));
});

test('decodePumpIx ignores non-pump data', () => {
  assert.equal(decodePumpIx({ data: '3pGnfNpzNwDy', accounts: [] }), null);
});

test('extractLaunchEvents: dev buy in the create tx is flagged as creator', () => {
  const rec = parseTx(fx.txs.create, fx.sigs.create);
  rec.order = rec.slot * 1_000_000;
  const creation = { record: rec, bondingCurve: fx.bondingCurve };
  const ev = extractLaunchEvents([rec], fx.mint, creation);
  const dev = ev.find((e) => e.wallet === fx.creator);
  assert.ok(dev && dev.isCreator && dev.inCreateTx && dev.side === 'buy');
  assert.ok(dev.sol > 0);
  assert.equal(dev.slotOffset, 0);
});

// ---- USDC-quoted curves: synthetic buys built with the real discriminators and TradeEvent field layout ----
const key = (n) => encodeBase58(new Uint8Array(32).fill(n));
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(v)), true);
  return b;
};
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${a} ≈ ${b}`);
const Q = { mint: key(11), curve: key(12), global: key(13), feeRecipient: key(14), eventAuthority: key(15), userQuoteAta: key(16), curveQuoteAta: key(17), curveTokenAta: key(18), userTokenAta: key(19) };
const TOKEN_RAW = 1_000_000e6; // 1M tokens bought
const VTOK_RAW = 800_000_000e6; // 800M tokens of virtual reserves after the buy

function quoteBuyTx(quoteMint, { quoteRaw, vQuoteRaw, quoteUi, withEvent = true }) {
  const user = fx.creator; // a real on-curve wallet, so the balance-delta fallback counts it as a buyer
  const pubkeys = [user, Q.userQuoteAta, Q.curveQuoteAta, Q.curveTokenAta, Q.userTokenAta, Q.curve, PROGRAMS.PUMP, Q.mint, quoteMint];
  const event = cat(ANCHOR_EVENT_CPI, PUMP_EVENTS.TradeEvent, decodeBase58(Q.mint), u64le(quoteRaw), u64le(TOKEN_RAW), [1], decodeBase58(user), u64le(1_800_000_000), u64le(vQuoteRaw), u64le(VTOK_RAW), u64le(vQuoteRaw / 4), u64le(VTOK_RAW - 280_000_000e6), decodeBase58(Q.feeRecipient), u64le(95), u64le(quoteRaw * 0.0095), decodeBase58(fx.creator), u64le(30), u64le(quoteRaw * 0.003));
  const ix = { programId: PROGRAMS.PUMP, accounts: [Q.global, Q.mint, quoteMint, PROGRAMS.TOKEN_2022, PROGRAMS.TOKEN, Q.curve, Q.curveTokenAta, Q.curveQuoteAta, user, Q.userTokenAta, Q.userQuoteAta], data: encodeBase58(cat(PUMP_IX.buy_exact_quote_in_v2, u64le(quoteRaw), u64le(TOKEN_RAW * 0.9))) };
  const bal = (accountIndex, mint, owner, uiAmount) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmount } });
  const lamports = pubkeys.map(() => 2_000_000);
  return {
    slot: 500,
    blockTime: 1_800_000_000,
    version: 0,
    meta: {
      err: null,
      fee: 5000,
      preBalances: lamports,
      postBalances: lamports.map((l, i) => (i === 0 ? l - 5000 : l)),
      preTokenBalances: [bal(1, quoteMint, user, 100), bal(2, quoteMint, Q.curve, 1000), bal(3, Q.mint, Q.curve, 900_000_000)],
      postTokenBalances: [bal(1, quoteMint, user, 100 - quoteUi), bal(2, quoteMint, Q.curve, 1000 + quoteUi), bal(3, Q.mint, Q.curve, 899_000_000), bal(4, Q.mint, user, 1_000_000)],
      innerInstructions: withEvent ? [{ index: 0, instructions: [{ programId: PROGRAMS.PUMP, accounts: [Q.eventAuthority], data: encodeBase58(event) }] }] : [],
    },
    transaction: { signatures: ['synthetic'], message: { accountKeys: pubkeys.map((pubkey, i) => ({ pubkey, signer: i === 0 })), instructions: [ix] } },
  };
}

test('quote assets: USDC is a 6-decimal USD quote, anything else is SOL', () => {
  assert.deepEqual(quoteInfo(USDC_MINT), { mint: USDC_MINT, symbol: 'USDC', decimals: 6, usd: true });
  assert.equal(quoteInfo(PROGRAMS.WSOL).decimals, 9);
  assert.equal(quoteInfo(undefined).mint, PROGRAMS.WSOL, 'legacy instructions carry no quote mint → SOL');
  assert.equal(quoteUsdPrice(USDC_MINT, 150), 1);
  assert.equal(quoteUsdPrice(PROGRAMS.WSOL, 150), 150);
  assert.equal(mcapUsdFromQuote(5e-6, 1e9, USDC_MINT, null), 5000, 'USDC price needs no SOL price');
  assert.equal(mcapUsdFromQuote(4e-8, 1e9, PROGRAMS.WSOL, null), null, 'SOL price unknown → no mcap');
  near(mcapUsdFromQuote(4e-8, 1e9, PROGRAMS.WSOL, 150), 6000);
});

test('parseTx: USDC-quoted buy decodes amounts and price in USDC, and its mcap is not multiplied by SOL/USD', () => {
  const rec = parseTx(quoteBuyTx(USDC_MINT, { quoteRaw: 25e6, vQuoteRaw: 4000e6, quoteUi: 25 }));
  const b = rec.pumpIxs.find((p) => p.kind === 'buy');
  assert.equal(b.name, 'buy_exact_quote_in_v2');
  assert.equal(b.quoteMint, USDC_MINT);
  assert.equal(b.solIn, 25, 'quote amount in the instruction is USDC (6 decimals)');
  const tev = rec.pumpEvents.find((e) => e.type === 'trade');
  assert.equal(tev.mint, Q.mint);
  assert.equal(tev.quoteMint, USDC_MINT);
  assert.equal(tev.quoteUsd, true);
  assert.equal(tev.quoteAmount, 25);
  assert.equal(tev.tokenAmount, 1_000_000);
  assert.equal(tev.vSol, 4000);
  near(tev.fee, 0.2375);
  near(tev.priceQuote, 5e-6);
  const c = classifyForMint(rec, Q.mint, fx.creator);
  assert.equal(c.side, 'buy');
  assert.equal(c.sol, 25);
  assert.equal(c.quoteUsd, true);

  rec.order = rec.slot * 1_000_000;
  const [ev] = extractLaunchEvents([rec], Q.mint, { record: rec, bondingCurve: Q.curve });
  assert.equal(ev.sol, 25);
  assert.equal(ev.quoteMint, USDC_MINT);
  assert.equal(ev.quoteUsd, true);
  // 5e-6 USDC per token × 1B supply = $5,000, whatever SOL trades at
  near(mcapUsdFromQuote(ev.priceQuote, 1e9, ev.quoteMint, 150), 5000);
  near(mcapUsdFromQuote(ev.priceQuote, 1e9, ev.quoteMint, 250), 5000);
});

test('parseTx: SOL-quoted buy through the same instruction keeps SOL amounts and the SOL/USD conversion', () => {
  const rec = parseTx(quoteBuyTx(PROGRAMS.WSOL, { quoteRaw: 0.5e9, vQuoteRaw: 32e9, quoteUi: 0.5 }));
  assert.equal(rec.pumpIxs[0].solIn, 0.5);
  const tev = rec.pumpEvents.find((e) => e.type === 'trade');
  assert.equal(tev.quoteMint, PROGRAMS.WSOL);
  assert.equal(tev.quoteUsd, false);
  assert.equal(tev.quoteAmount, 0.5);
  assert.equal(tev.vSol, 32);
  near(tev.priceQuote, 4e-8);
  near(mcapUsdFromQuote(tev.priceQuote, 1e9, tev.quoteMint, 150), 6000);
});

test('extractLaunchEvents: USDC-quoted buy without a TradeEvent reads the USDC flowing into the curve', () => {
  const rec = parseTx(quoteBuyTx(USDC_MINT, { quoteRaw: 25e6, vQuoteRaw: 4000e6, quoteUi: 25, withEvent: false }));
  assert.equal(rec.pumpEvents.length, 0);
  rec.order = rec.slot * 1_000_000;
  const ev = extractLaunchEvents([rec], Q.mint, { record: rec, bondingCurve: Q.curve });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].wallet, fx.creator);
  assert.equal(ev[0].side, 'buy');
  assert.equal(ev[0].tokens, 1_000_000);
  assert.equal(ev[0].sol, 25, 'USDC paid into the curve, not the lamport fee');
  assert.equal(ev[0].quoteUsd, true);
  const c = classifyForMint(rec, Q.mint, fx.creator);
  assert.equal(c.side, 'buy');
  assert.equal(c.sol, 25);
});

test('decodeCurve: USDC-quoted bonding curve reserves are scaled by 6 decimals', () => {
  const bytes = cat(new Uint8Array(8), u64le(VTOK_RAW), u64le(4000e6), u64le(VTOK_RAW - 280_000_000e6), u64le(1000e6), u64le(1_000_000_000e6), [0]);
  const b64 = Buffer.from(bytes).toString('base64');
  const usdc = decodeCurve(b64, quoteInfo(USDC_MINT).decimals);
  assert.equal(usdc.vSol, 4000);
  near(usdc.priceSol, 5e-6);
  near(mcapUsdFromQuote(usdc.priceSol, usdc.supply, USDC_MINT, 150), 5000);
  const sol = decodeCurve(b64); // SOL default unchanged
  assert.equal(sol.vSol, 4);
  near(sol.priceSol, 5e-9);
});
