import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS, PUMP_IX, ANCHOR_EVENT_CPI, PUMP_EVENTS } from '../src/lib/constants.js';
import { decodePumpEvent, decodePumpIx, parseTx, classifyForMint } from '../src/lib/txparse.js';
import { decodeCurve } from '../src/lib/livewatch.js';
import { normalisePair } from '../src/lib/market.js';
import { fallbackValuation, quotePriceUsd } from '../src/lib/quote.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { devExitOnLaunch, clusterExitOnLaunch, analysePriorLaunches } from '../src/lib/scan/operator.js';
import { runScan } from '../src/lib/scan/pipeline.js';

// Synthetic Borsh fixtures follow pump-fun/pump-public-docs/idl/pump.json,
// retrieved 2026-10-31. These are protocol-layout tests, not captured mainnet txs.
// The existing pump-txs.json fixture supplies independent legacy SOL coverage.
const MINT = encodeBase58(new Uint8Array(32).fill(4));
const USER = encodeBase58(new Uint8Array(32).fill(5));
const UNKNOWN = encodeBase58(new Uint8Array(32).fill(6));
const T0 = 1_792_386_160;
const SUPPLY = 1_000_000_000;
const pk = (s) => Buffer.from(decodeBase58(s));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const flag = (v = false) => Buffer.from([v ? 1 : 0]);
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };
const header = (name) => Buffer.from([...ANCHOR_EVENT_CPI, ...PUMP_EVENTS[name]]);
const ix = (bytes) => ({ programId: PROGRAMS.PUMP, data: encodeBase58(bytes), accounts: [] });

function tradeBytes({ quote = PROGRAMS.USDC, legacy = false, shareholders = 0, name = 'sell_v3', buy = false, virtual = 2_000_000_000n, legacyVirtual = 0n } = {}) {
  const prefix = [
    header('TradeEvent'), pk(MINT), u64(2_000_000_000n), u64(50_000_000n), flag(buy), pk(USER), u64(T0 + 120),
    u64(legacyVirtual), u64(1_000_000_000_000n), u64(1_000_000_000n), u64(500_000_000_000n),
    pk(USER), u64(100), u64(1_500_000n), pk(USER), u64(50), u64(750_000n),
  ];
  if (legacy) return Buffer.concat(prefix);
  return Buffer.concat([
    ...prefix, flag(), u64(0), u64(0), u64(0), u64(T0), str(name), flag(),
    u64(0), u64(0), u64(0), u64(0), u32(shareholders),
    ...Array.from({ length: shareholders }, () => Buffer.concat([pk(USER), Buffer.from([0x10, 0x27])])),
    pk(quote), u64(150_250_000n), u64(virtual), u64(1_000_000_000n),
  ]);
}

function createBytes({ quote = PROGRAMS.USDC, legacy = false } = {}) {
  const prefix = [header('CreateEvent'), str('A variable-length coin 🪙'), str('USDC'), str('https://example.test/metadata'),
    pk(MINT), pk(USER), pk(USER), pk(USER), u64(T0), u64(1_000_000_000_000n), u64(30_000_000_000n),
    u64(500_000_000_000n), u64(1_000_000_000_000_000n)];
  return Buffer.concat(legacy ? prefix : [...prefix, pk(PROGRAMS.TOKEN_2022), flag(), flag(), pk(quote), u64(2_000_000_000n)]);
}

function curveBytes({ quote = PROGRAMS.USDC, legacy = false, virtual = 2_000_000_000n, tokens = 1_000_000_000_000n } = {}) {
  return Buffer.concat([Buffer.alloc(8), u64(tokens), u64(virtual), u64(500_000_000_000n),
    u64(1_000_000_000n), u64(1_000_000_000_000_000n), flag(),
    ...(legacy ? [] : [pk(USER), flag(), flag(), pk(quote)])]);
}

function rawTx(events, { create = false } = {}) {
  return {
    slot: 100, blockTime: create ? T0 : T0 + 120,
    transaction: { signatures: [create ? 'create' : 'sell'], message: {
      accountKeys: [{ pubkey: USER, signer: true }, { pubkey: MINT, signer: false }],
      instructions: [ix(Buffer.alloc(8))],
    } },
    meta: { err: null, fee: 5000, preBalances: [100000, 0], postBalances: [95000, 0],
      preTokenBalances: [], postTokenBalances: [], innerInstructions: [{ index: 0, instructions: events.map(ix) }] },
  };
}

for (const shareholders of [0, 2]) {
  test(`USDC TradeEvent uses appended six-decimal fields after ${shareholders} shareholders`, () => {
    const e = decodePumpEvent(ix(tradeBytes({ shareholders, name: 'variable_ix_name', legacyVirtual: 99_000_000_000n })));
    assert.equal(e.partial, undefined);
    assert.equal(e.quoteMint, PROGRAMS.USDC);
    assert.equal(e.quoteAmount, 150.25);
    assert.equal(e.tokenAmount, 50);
    assert.equal(e.vQuote, 2000);
    assert.equal(e.rQuote, 1000);
    assert.equal(e.priceQuote, 0.002);
    assert.equal(e.fee, 1.5);
    assert.equal(e.creatorFee, 0.75);
    assert.equal(e.vSol, 99, 'legacy reserve is preserved but not used for USDC pricing');
  });
}

test('old and extended SOL events retain legacy SOL amounts, including the zero-mint sentinel', () => {
  for (const opts of [{ legacy: true }, { quote: PROGRAMS.WSOL }, { quote: PROGRAMS.SYSTEM }]) {
    const e = decodePumpEvent(ix(tradeBytes({ ...opts, legacyVirtual: 30_000_000_000n })));
    assert.equal(e.quoteMint, PROGRAMS.WSOL);
    assert.equal(e.quoteAmount, 2);
    assert.equal(e.vQuote, 30);
    assert.equal(e.priceQuote, 0.00003);
    assert.equal(e.fee, 0.0015);
  }
});

test('CreateEvent reads the quote after variable-length metadata and keeps legacy SOL support', () => {
  const usdc = decodePumpEvent(ix(createBytes()));
  assert.equal(usdc.tokenName, 'A variable-length coin 🪙');
  assert.equal(usdc.quoteMint, PROGRAMS.USDC);
  assert.equal(usdc.priceQuote, 0.002);
  assert.equal(usdc.supply, SUPPLY);
  const sol = decodePumpEvent(ix(createBytes({ legacy: true })));
  assert.equal(sol.quoteMint, PROGRAMS.WSOL);
  assert.equal(sol.priceQuote, 0.00003);
});

test('unknown quote mints are not priced as SOL or trusted by token symbol', () => {
  const t = decodePumpEvent(ix(tradeBytes({ quote: UNKNOWN })));
  const c = decodePumpEvent(ix(createBytes({ quote: UNKNOWN })));
  assert.equal(t.quoteMint, UNKNOWN);
  assert.equal(t.quoteAmount, null);
  assert.equal(t.priceQuote, null);
  assert.equal(c.symbol, 'USDC');
  assert.equal(c.priceQuote, null);
  assert.equal(quotePriceUsd(c, 180), null);
});

test('truncated Borsh fields are partial events, not fabricated zero values', () => {
  for (const bytes of [tradeBytes({ shareholders: 2 }), createBytes()]) {
    for (const cut of [1, 7, 17, 35]) {
      const e = decodePumpEvent(ix(bytes.subarray(0, bytes.length - cut)));
      assert.equal(e.partial, true, `truncated by ${cut} bytes`);
      assert.equal(e.priceQuote, undefined);
    }
  }
  const shortKey = Buffer.concat([header('TradeEvent'), Buffer.alloc(2)]);
  assert.equal(decodePumpEvent(ix(shortKey)).partial, true);
});

test('live curve decoding uses quote decimals and has no SOL price for USDC', () => {
  const usdc = decodeCurve(curveBytes().toString('base64'));
  assert.equal(usdc.quoteMint, PROGRAMS.USDC);
  assert.equal(usdc.priceQuote, 0.002);
  assert.equal(usdc.priceUsd, 0.002);
  assert.equal(usdc.priceSol, null);
  assert.equal(usdc.vSol, null);
  for (const opts of [{ legacy: true }, { quote: PROGRAMS.WSOL }, { quote: PROGRAMS.SYSTEM }]) {
    const sol = decodeCurve(curveBytes({ ...opts, virtual: 30_000_000_000n }).toString('base64'));
    assert.equal(sol.priceSol, 0.00003);
    assert.equal(sol.priceUsd, null);
  }
  assert.equal(decodeCurve(curveBytes({ quote: UNKNOWN }).toString('base64')).priceUsd, null);
  assert.equal(decodeCurve(curveBytes({ tokens: 0n }).toString('base64')).priceUsd, null);
  assert.equal(decodeCurve(curveBytes().subarray(0, 100).toString('base64')), null);
  assert.equal(decodeCurve(Buffer.alloc(48).toString('base64')), null);
});

test('quote-aware instruction limits do not become SOL slippage values', () => {
  const accounts = [USER, MINT, PROGRAMS.USDC];
  const exact = decodePumpIx({ accounts, data: encodeBase58(Buffer.concat([
    Buffer.from(PUMP_IX.buy_exact_quote_in_v3), u64(150_250_000n), u64(50_000_000n),
  ])) });
  assert.equal(exact.quoteIn, 150.25);
  assert.equal(exact.solIn, null);
  const sell = decodePumpIx({ accounts, data: encodeBase58(Buffer.concat([
    Buffer.from(PUMP_IX.sell_v3), u64(50_000_000n), u64(150_250_000n),
  ])) });
  assert.equal(sell.quoteLimit, 150.25);
  assert.equal(sell.solLimit, null);
});

test('transaction classification and launch events preserve quote identity', () => {
  const rec = parseTx(rawTx([tradeBytes({ buy: true })]));
  const classified = classifyForMint(rec, MINT, USER);
  const [launch] = extractLaunchEvents([rec], MINT, { record: rec, bondingCurve: 'curve' });
  for (const e of [classified, launch]) {
    assert.equal(e.quoteMint, PROGRAMS.USDC);
    assert.equal(e.quoteAmount, 150.25);
    assert.equal(e.sol, null);
    assert.equal(e.priceQuote, 0.002);
  }
});

test('USD valuation converts SOL once, USDC once, and preserves already-USD prices', () => {
  const usdc = { quoteMint: PROGRAMS.USDC, priceQuote: 0.002 };
  const sol = { quoteMint: PROGRAMS.WSOL, priceQuote: 0.00003 };
  for (const solUsd of [null, 1, 180, 300]) {
    assert.equal(fallbackValuation({}, SUPPLY, usdc, solUsd).marketCapUsd, 2_000_000);
    assert.equal(fallbackValuation({ priceUsd: 0.004 }, SUPPLY, sol, solUsd).marketCapUsd, 4_000_000);
  }
  assert.equal(fallbackValuation({}, SUPPLY, sol, 180).marketCapUsd, 5_400_000);
  assert.equal(fallbackValuation({}, SUPPLY, sol, null), null);
  assert.equal(fallbackValuation({}, SUPPLY, { quoteMint: UNKNOWN, priceQuote: 1 }, 180), null);
  assert.equal(fallbackValuation({}, SUPPLY, { ...usdc, priceQuote: 0 }, 180).marketCapUsd, 0);
  for (const invalid of [NaN, Infinity, -1]) {
    assert.equal(fallbackValuation({}, SUPPLY, { ...usdc, priceQuote: invalid }, 180), null);
    assert.equal(fallbackValuation({}, invalid, usdc, 180), null);
  }
  assert.equal(fallbackValuation({}, Number.MAX_VALUE, { ...usdc, priceQuote: 2 }, 180), null);
});

test('pair metadata permits a matching quote exchange rate but never reuses a USDC ratio as SOL/USD', () => {
  const market = normalisePair({ baseToken: { address: MINT }, quoteToken: { address: PROGRAMS.USDC, symbol: 'USDC' }, priceUsd: '0.00196', priceNative: '0.002' });
  assert.equal(market.quoteMint, PROGRAMS.USDC);
  assert.equal(quotePriceUsd({ quoteMint: PROGRAMS.USDC, priceQuote: 0.002 }, null, market), 0.00196);
  assert.equal(quotePriceUsd({ quoteMint: PROGRAMS.WSOL, priceQuote: 0.002 }, null, market), null);
});

function exitRpc() {
  const raw = rawTx([tradeBytes()]);
  return {
    ataFor: async () => 'ata',
    getSignaturesForAddress: async () => [{ signature: 'sell', blockTime: raw.blockTime, slot: raw.slot, err: null }],
    getTransactions: async (sigs) => sigs.map(() => raw),
  };
}
const launch = { mint: MINT, createdAt: T0 * 1000, creator: USER, launchBuyers: [], clusterWallets: [] };

test('dev and cluster exit market caps are USDC-valued even without SOL/USD', async () => {
  for (const solUsd of [null, 180]) {
    const rpc = exitRpc();
    const dev = await devExitOnLaunch(rpc, USER, launch, SUPPLY, solUsd);
    const cluster = await clusterExitOnLaunch(rpc, launch, {}, new Map(), null, SUPPLY, solUsd);
    for (const result of [dev, cluster]) {
      assert.equal(result.sells, 1);
      assert.equal(result.mcapAtFirstSellUsd, 2_000_000);
      assert.equal(result.sellsDetail[0].quoteMint, PROGRAMS.USDC);
      assert.equal(result.firstSellMin, 2);
    }
    assert.equal(dev.solOut, 0, 'USDC proceeds must not be counted as SOL');
  }
});

test('on-chain prior-launch outcome works when market and SOL quotes are unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ pairs: [], data: [] }), { status: 200 }));
  const [result] = await analysePriorLaunches(exitRpc(), [{ ...launch }], {}, new Map(), { supply: SUPPLY });
  assert.equal(result.source, 'on-chain');
  assert.equal(result.peakMcapUsd, 2_000_000);
  assert.equal(result.nowMcapUsd, 2_000_000);
  assert.equal(result.tradesSeen, 1);
});

test('scan pipeline derives a fresh USDC launch cap without a SOL price', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ pairs: [], data: [] }), { status: 200 }));
  const raw = rawTx([createBytes(), tradeBytes({ buy: true })], { create: true });
  const sig = { signature: 'create', blockTime: T0, slot: 100, err: null };
  const rpc = {
    getAccountInfo: async () => ({ value: { data: { parsed: { type: 'mint' } } } }),
    getMintInfo: async () => ({ supply: SUPPLY, tokenProgram: PROGRAMS.TOKEN_2022 }),
    getSignaturesForAddress: async () => [sig], getTransaction: async () => raw,
    getBlockAccounts: async () => ({ transactions: [] }),
    pageSignatures: async () => ({ sigs: [sig], exhausted: true }),
  };
  const signal = { aborted: false };
  const report = await runScan(rpc, MINT, {
    signal, settings: { operatorHistory: false, jitoLookup: false, slotWindow: 0, earlyWindowSec: 0 },
    emit: (stage, r) => { if (stage === 'launch' && r.stages.launch.status !== 'running') signal.aborted = true; },
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.stages.launch.status, 'done');
  assert.equal(report.market.priceUsd, 0.002);
  assert.equal(report.market.marketCapUsd, 2_000_000);
});
