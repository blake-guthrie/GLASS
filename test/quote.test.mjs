import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS, PUMP_EVENTS, ANCHOR_EVENT_CPI } from '../src/lib/constants.js';
import { decodePumpEvent, parseTx } from '../src/lib/txparse.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { decodeCurve, LiveWatcher } from '../src/lib/livewatch.js';
import { quotePriceUsd } from '../src/lib/quote.js';
import { devExitOnLaunch, clusterExitOnLaunch, analysePriorLaunches } from '../src/lib/scan/operator.js';
import { runScan } from '../src/lib/scan/pipeline.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fx = JSON.parse(readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url)));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pk = (s) => Buffer.from(decodeBase58(s));
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

// Synthetic encodings of the published pump.fun IDL, including its variable-length
// ix_name and Shareholder vector. The deprecated SOL fields deliberately contain zero.
function tradeIx(quoteMint = USDC, { isBuy = true, shareholders = 2 } = {}) {
  const scale = quoteMint === PROGRAMS.WSOL ? 1e9 : 1e6;
  return { programId: PROGRAMS.PUMP, data: encodeBase58(Buffer.concat([
    Buffer.from(ANCHOR_EVENT_CPI), Buffer.from(PUMP_EVENTS.TradeEvent),
    pk(fx.mint), u64(0), u64(100e6), Buffer.from([+isBuy]), pk(fx.creator),
    u64(1700000000), u64(0), u64(1000e6), u64(0), u64(500e6),
    pk(PROGRAMS.SYSTEM), u64(100), u64(0), pk(fx.creator), u64(50), u64(0),
    Buffer.from([0]), u64(0), u64(0), u64(0), u64(0),
    str(isBuy ? 'buy_exact_quote_in_v3' : 'sell_v3'), Buffer.from([0]),
    u64(0), u64(0), u64(0), u64(0), u32(shareholders),
    ...Array.from({ length: shareholders }, () => Buffer.concat([pk(fx.creator), Buffer.from([0x88, 0x13])])),
    pk(quoteMint), u64(2 * scale), u64(20 * scale), u64(10 * scale),
  ])) };
}

function createIx(quoteMint = USDC) {
  return { programId: PROGRAMS.PUMP, data: encodeBase58(Buffer.concat([
    Buffer.from(ANCHOR_EVENT_CPI), Buffer.from(PUMP_EVENTS.CreateEvent),
    str('Synthetic'), str('TEST'), str('https://example.invalid/token'),
    pk(fx.mint), pk(fx.bondingCurve), pk(fx.creator), pk(fx.creator),
    u64(1700000000), u64(1000e6), u64(0), u64(500e6), u64(1e15),
    pk(PROGRAMS.TOKEN_2022), Buffer.from([0, 0]), pk(quoteMint), u64(20e6),
  ])) };
}

test('USDC trade reads appended quote amounts after variable-length shareholders', () => {
  const ev = decodePumpEvent(tradeIx());
  assert.equal(ev.quoteMint, USDC);
  assert.equal(ev.quoteAmount, 2);
  assert.equal(ev.vQuote, 20);
  assert.equal(ev.priceQuote, 0.02);
  assert.equal(ev.solAmount, 0);
});

test('modern WSOL trade uses nine decimals and the appended reserves', () => {
  const ev = decodePumpEvent(tradeIx(PROGRAMS.WSOL, { shareholders: 0 }));
  assert.equal(ev.quoteAmount, 2);
  assert.equal(ev.priceQuote, 0.02);
});

test('USDC create event uses virtual_quote_reserves, not deprecated SOL reserves', () => {
  const ev = decodePumpEvent(createIx());
  assert.equal(ev.quoteMint, USDC);
  assert.equal(ev.vQuote, 20);
  assert.equal(ev.priceQuote, 0.02);
});

test('unknown quote mints do not produce a price from an assumed decimal scale', () => {
  const ev = decodePumpEvent(tradeIx(PROGRAMS.TOKEN));
  assert.equal(ev.priceQuote, null);
  assert.equal(ev.quoteAmount, null);
});

test('USDC launch events preserve the quote mint and keep quote spend out of SOL', () => {
  const raw = structuredClone(fx.txs.create);
  raw.meta.innerInstructions = [{ index: 0, instructions: [tradeIx()] }];
  const rec = parseTx(raw);
  const [ev] = extractLaunchEvents([rec], fx.mint, { record: rec, bondingCurve: fx.bondingCurve });
  assert.equal(ev.quoteMint, USDC);
  assert.equal(ev.priceQuote, 0.02);
  assert.equal(ev.quoteAmount, 2);
  assert.equal(ev.sol, 0);
});

test('USDC bonding curve exposes a quote price and no SOL price', () => {
  const b = Buffer.alloc(115);
  b.writeBigUInt64LE(1000_000000n, 8);
  b.writeBigUInt64LE(20_000000n, 16);
  b.writeBigUInt64LE(500_000000n, 24);
  b.writeBigUInt64LE(10_000000n, 32);
  b.writeBigUInt64LE(1000_000000n, 40);
  pk(USDC).copy(b, 83);
  const c = decodeCurve(b.toString('base64'));
  assert.equal(c.quoteMint, USDC);
  assert.equal(c.priceQuote, 0.02);
  assert.equal(c.priceSol, null);
});

test('legacy 49-byte SOL bonding curves keep their original price', () => {
  const b = Buffer.alloc(49);
  b.writeBigUInt64LE(1000_000000n, 8);
  b.writeBigUInt64LE(20_000000000n, 16);
  const c = decodeCurve(b.toString('base64'));
  assert.equal(c.priceSol, 0.02);
});

test('quote valuation uses mint identity and handles missing SOL exchange rates', () => {
  assert.equal(quotePriceUsd(0.02, USDC, 200), 0.02);
  assert.equal(quotePriceUsd(0.02, USDC, null), 0.02);
  assert.equal(quotePriceUsd(0.02, PROGRAMS.WSOL, 200), 4);
  assert.equal(quotePriceUsd(0.02, PROGRAMS.SYSTEM, 200), 4);
  assert.equal(quotePriceUsd(0.02, PROGRAMS.WSOL, null), null);
  assert.equal(quotePriceUsd(0.02, PROGRAMS.TOKEN, 200), null);
  assert.equal(quotePriceUsd(Infinity, USDC, 200), null);
});

test('truncated quote extension is partial and supplies no guessed price', () => {
  const ix = tradeIx();
  ix.data = encodeBase58(decodeBase58(ix.data).subarray(0, -1));
  const ev = decodePumpEvent(ix);
  assert.equal(ev.partial, true);
  assert.equal(ev.priceQuote, undefined);
});

test('live USDC updates emit USD market cap without the SOL multiplier', () => {
  const b = Buffer.alloc(115);
  b.writeBigUInt64LE(1000_000000n, 8);
  b.writeBigUInt64LE(20_000000n, 16);
  pk(USDC).copy(b, 83);
  const events = [];
  const w = new LiveWatcher({ supply: 1000, solUsd: 200, onEvent: (ev) => events.push(ev) });
  w.subs.set(1, { kind: 'curve' });
  w.onMessage({ data: JSON.stringify({ method: 'accountNotification', params: { subscription: 1,
    result: { context: { slot: 1 }, value: { data: [b.toString('base64'), 'base64'] } } } }) });
  assert.equal(events[0].mcapUsd, 20);
});

function rawTrade(quoteMint = USDC) {
  const raw = structuredClone(fx.txs.sell);
  raw.meta.innerInstructions = [{ index: 0, instructions: [tradeIx(quoteMint, { isBuy: false })] }];
  return raw;
}

test('dev and cluster sell valuations use USDC prices even without SOL FX', async () => {
  const raw = rawTrade();
  const rpc = {
    ataFor: async () => 'synthetic-ata',
    getSignaturesForAddress: async () => [{ signature: 'synthetic-sell', blockTime: raw.blockTime }],
    getTransactions: async () => [raw],
  };
  const launch = { mint: fx.mint, createdAt: (raw.blockTime - 60) * 1000, creator: fx.creator, launchBuyers: [], clusterWallets: [] };
  const dev = await devExitOnLaunch(rpc, fx.creator, launch, 1000, null);
  assert.equal(dev.mcapAtFirstSellUsd, 20);
  assert.equal(dev.solOut, 0);
  const cluster = await clusterExitOnLaunch(rpc, launch, [], new Map(), null, 1000, 200);
  assert.equal(cluster.mcapAtFirstSellUsd, 20);
  assert.equal(cluster.sellsDetail[0].quoteMint, USDC);
});

const clockBase = Date.now();
let clockRun = 0;
async function scanFixture(t, { priceUsd, marketCap, quoteMint = USDC, solUsd = 200, createOnly = false } = {}) {
  const now = clockBase + ++clockRun * 61000;
  t.mock.method(Date, 'now', () => now); // expire the market module's per-mint cache
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    let pair;
    if (value.includes(PROGRAMS.WSOL)) {
      pair = solUsd ? { chainId: 'solana', baseToken: { address: PROGRAMS.WSOL }, quoteToken: { symbol: 'USDC' }, priceUsd: String(solUsd) } : null;
    } else if (value.includes(fx.mint)) {
      pair = { chainId: 'solana', baseToken: { address: fx.mint }, quoteToken: { address: quoteMint }, priceUsd, marketCap };
    } else throw new Error(`Unexpected offline request: ${url}`);
    return new Response(JSON.stringify({ pairs: pair ? [pair] : [] }), { status: 200 });
  });
  const raw = structuredClone(fx.txs.create);
  raw.meta.innerInstructions = [{ index: 0, instructions: [createOnly ? createIx() : tradeIx(quoteMint)] }];
  const rpc = {
    getMintInfo: async () => ({ supply: 1000 }),
    getSignaturesForAddress: async () => [{ signature: 'create', slot: raw.slot }],
    getTransaction: async () => raw,
    getBlockAccounts: async () => null,
    pageSignatures: async () => ({ sigs: [], exhausted: true }),
  };
  const signal = { aborted: false };
  const report = await runScan(rpc, fx.mint, {
    signal, settings: { operatorHistory: false, jitoLookup: false },
    emit: (stage, r) => { if (stage === 'launch' && r.stages.launch?.status === 'done') signal.aborted = true; },
  });
  assert.equal(report.stages.launch.status, 'done', JSON.stringify(report.errors));
  return report;
}

test('scan falls back to decoded USDC reserves when indexed USD price is absent', async (t) => {
  const report = await scanFixture(t);
  assert.equal(report.market.marketCapUsd, 20);
  assert.equal(report.market.priceUsd, 0.02);
});

test('scan prefers an indexed USD price to a launch-window reserve price', async (t) => {
  const report = await scanFixture(t, { priceUsd: '0.05' });
  assert.equal(report.market.marketCapUsd, 50);
});

test('scan does not overwrite the provider market cap', async (t) => {
  const report = await scanFixture(t, { marketCap: 75 });
  assert.equal(report.market.marketCapUsd, 75);
});

test('scan values USDC when the SOL price service has no result', async (t) => {
  const report = await scanFixture(t, { solUsd: null });
  assert.equal(report.market.marketCapUsd, 20);
});

test('scan retains SOL conversion for modern WSOL trades', async (t) => {
  const report = await scanFixture(t, { quoteMint: PROGRAMS.WSOL });
  assert.equal(report.market.marketCapUsd, 4000);
});

test('scan can value initial USDC reserves before the first trade', async (t) => {
  const report = await scanFixture(t, { createOnly: true });
  assert.equal(report.market.marketCapUsd, 20);
});

test('scan leaves unrecognised quote prices unavailable', async (t) => {
  const report = await scanFixture(t, { quoteMint: PROGRAMS.TOKEN });
  assert.equal(report.market.marketCapUsd, null);
});

test('historical on-chain USDC outcome works without candles or SOL FX', async (t) => {
  const now = clockBase + ++clockRun * 61000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ pairs: [], data: [] }), { status: 200 }));
  const raw = rawTrade();
  const rpc = {
    getSignaturesForAddress: async () => [{ signature: 'historical-sell', blockTime: raw.blockTime }],
    getTransactions: async () => [raw],
  };
  const [outcome] = await analysePriorLaunches(rpc, [{ mint: fx.mint, createdAt: raw.blockTime * 1000 }], [], new Map(), { supply: 1000, maxDeep: 0 });
  assert.equal(outcome.source, 'on-chain');
  assert.equal(outcome.peakMcapUsd, 20);
  assert.equal(outcome.nowMcapUsd, 20);
});
