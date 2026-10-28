import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeBase58, decodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS, ANCHOR_EVENT_CPI, PUMP_EVENTS, PUMP_IX } from '../src/lib/constants.js';
import { decodePumpEvent, decodePumpIx, parseTx, classifyForMint } from '../src/lib/txparse.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { analyseLaunch } from '../src/lib/scan/fingerprint.js';
import { runScan } from '../src/lib/scan/pipeline.js';
import { resolveMint } from '../src/lib/scan/resolve.js';
import { devExitOnLaunch, clusterExitOnLaunch, analysePriorLaunches } from '../src/lib/scan/operator.js';
import { decodeCurve, LiveWatcher } from '../src/lib/livewatch.js';
import { normalisePair } from '../src/lib/market.js';
import { marketSolUsd } from '../src/lib/quote.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url)));
const pk = (v) => Buffer.from(decodeBase58(v));
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const str = (v) => {
  const b = Buffer.from(v);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
};
const event = (name, parts) => ({
  programId: PROGRAMS.PUMP,
  data: encodeBase58(Buffer.concat([Buffer.from(ANCHOR_EVENT_CPI), Buffer.from(PUMP_EVENTS[name]), ...parts])),
});

// Independent binary fixtures follow pump-fun/pump-public-docs idl/pump.json.
// Legacy SOL fields deliberately differ from appended quote fields: USDC must use the latter.
function trade(quote = USDC, { buy = true, shareholders = 0, legacy = false } = {}) {
  const parts = [
    pk(fx.mint), u64(0), u64(100e6), Buffer.from([+buy]), pk(fx.creator), u64(1000),
    u64(30e9), u64(500000e6), u64(10e9), u64(400000e6), pk(fx.creator), u64(100), u64(2500000),
    pk(fx.creator), u64(50), u64(1250000),
  ];
  if (!legacy) {
    parts.push(
      Buffer.from([0]), u64(0), u64(0), u64(0), u64(0), str(buy ? 'buy_v3' : 'sell_v3'),
      Buffer.from([0]), u64(0), u64(0), u64(0), u64(0),
      Buffer.from([shareholders, 0, 0, 0]),
      ...Array.from({ length: shareholders }, () => Buffer.concat([pk(fx.creator), Buffer.from([100, 0])])),
      pk(quote), u64(250e6), u64(1000e6), u64(750e6),
    );
  }
  return event('TradeEvent', parts);
}

function create(quote = USDC) {
  return event('CreateEvent', [
    str('Quote test'), str('QT'), str(''), pk(fx.mint), pk(fx.bondingCurve), pk(fx.creator), pk(fx.creator),
    u64(1000), u64(500000e6), u64(30e9), u64(400000e6), u64(1e15), pk(PROGRAMS.TOKEN_2022),
    Buffer.from([0, 0]), pk(quote), u64(1000e6),
  ]);
}

function rawTrade(quote = USDC, opts = {}) {
  const raw = structuredClone(fx.txs.create);
  raw.blockTime = 1060;
  raw.meta.innerInstructions = [{ index: 0, instructions: [create(quote), trade(quote, opts)] }];
  raw.transaction.message.instructions = [{
    programId: PROGRAMS.PUMP,
    accounts: [PROGRAMS.PUMP, fx.mint, quote, ...Array(5).fill(fx.creator), fx.creator],
    data: encodeBase58(Buffer.concat([Buffer.from(PUMP_IX[opts.buy === false ? 'sell_v3' : 'buy_v3']), u64(100e6), u64(250e6)])),
  }];
  return raw;
}

function curve(quote = USDC) {
  return Buffer.concat([
    Buffer.alloc(8), u64(500000e6), u64(1000e6), u64(400000e6), u64(750e6), u64(1e15), Buffer.from([0]),
    pk(fx.creator), Buffer.from([0, 0]), pk(quote),
  ]).toString('base64');
}

function scanRpc(raw) {
  return {
    getAccountInfo: async () => ({ value: { data: { parsed: { type: 'mint' } } } }),
    getMintInfo: async () => ({ supply: 1e9 }),
    getSignaturesForAddress: async () => [{ signature: 'create' }],
    getTransaction: async () => raw,
    getBlockAccounts: async () => null,
    pageSignatures: async () => ({ sigs: [], exhausted: true }),
  };
}

async function scan(raw, rpc = scanRpc(raw)) {
  const signal = { aborted: false };
  return runScan(rpc, fx.mint, {
    hintIsMint: true,
    settings: { slotWindow: 0, operatorHistory: false, jitoLookup: false },
    signal,
    emit: (stage, r) => {
      if (stage === 'launch' && r.stages.launch.status === 'done') signal.aborted = true;
    },
  });
}

test('USDC TradeEvent uses appended six-decimal quote amounts, reserves and fees', () => {
  const e = decodePumpEvent(trade(USDC, { shareholders: 2 }));
  assert.equal(e.quoteAmount, 250);
  assert.equal(e.vQuote, 1000);
  assert.equal(e.rQuote, 750);
  assert.equal(e.priceQuote, 0.002);
  assert.equal(e.fee, 2.5);
  assert.equal(e.creatorFee, 1.25);
  assert.equal(e.quoteMint, USDC);
  assert.equal(e.quoteDecimals, 6);
  assert.equal(e.vSol, null);
});

test('CreateEvent uses appended USDC reserve, while zero pubkey remains native SOL', () => {
  const e = decodePumpEvent(create());
  assert.equal(e.vQuote, 1000);
  assert.equal(e.priceQuote, 0.002);
  assert.equal(e.quoteMint, USDC);
  const sol = decodePumpEvent(create(PROGRAMS.SYSTEM));
  assert.equal(sol.quoteMint, PROGRAMS.WSOL);
  assert.equal(sol.quoteDecimals, 9);
});

test('quote-aware instruction limits preserve SOL aliases only for SOL', () => {
  for (const name of ['buy_v2', 'buy_v3', 'buy_exact_quote_in_v2', 'buy_exact_quote_in_v3', 'sell_v2', 'sell_v3']) {
    const accounts = [PROGRAMS.PUMP, fx.mint, USDC, ...Array(15).fill(fx.creator)];
    const data = encodeBase58(Buffer.concat([Buffer.from(PUMP_IX[name]), u64(250e6), u64(5e6)]));
    const e = decodePumpIx({ accounts, data }, [fx.creator]);
    assert.equal(name.includes('exact') ? e.quoteIn : e.quoteLimit, name.includes('exact') ? 250 : 5, name);
    assert.equal(e.solIn ?? e.solLimit ?? null, null, name);
  }
});

test('legacy buy_exact_quote_in keeps the SOL path instead of reading accounts[2] as the quote mint', () => {
  const accounts = [PROGRAMS.PUMP, fx.mint, fx.mint, ...Array(15).fill(fx.creator)];
  const data = encodeBase58(Buffer.concat([Buffer.from(PUMP_IX.buy_exact_quote_in), u64(2e9), u64(5e6)]));
  const e = decodePumpIx({ accounts, data }, [fx.creator]);
  assert.equal(e.quoteMint, PROGRAMS.WSOL);
  assert.equal(e.quoteIn, 2);
  assert.equal(e.solIn, 2);
});

test('recorded v2/v3 instructions keep the signer as user and a bonding curve distinct from it', () => {
  const buy = parseTx(fx.txs.buy, fx.sigs.buy);
  const b = buy.pumpIxs.find((p) => p.kind === 'buy');
  assert.equal(b.user, buy.feePayer);
  assert.notEqual(b.bondingCurve, b.user);
  const sell = parseTx(fx.txs.sell, fx.sigs.sell);
  const s = sell.pumpIxs.find((p) => p.kind === 'sell');
  assert.equal(s.user, sell.feePayer);
  assert.notEqual(s.bondingCurve, s.user);
  const dev = parseTx(fx.txs.create, fx.sigs.create).pumpIxs.find((p) => p.kind === 'buy');
  assert.equal(dev.user, fx.creator);
  assert.notEqual(dev.bondingCurve, dev.user);
});

test('launch and wallet classification retain quote identity without labelling USDC as SOL', () => {
  const rec = parseTx(rawTrade());
  const e = extractLaunchEvents([rec], fx.mint, { record: rec, bondingCurve: fx.bondingCurve })[0];
  assert.equal(e.quoteMint, USDC);
  assert.equal(e.quoteAmount, 250);
  assert.equal(e.sol, null);
  assert.equal(e.priceQuote, 0.002);
  const c = classifyForMint(rec, fx.mint, fx.creator);
  assert.equal(c.quoteMint, USDC);
  assert.equal(c.sol, null);
});

test('unsupported quotes and truncated quote suffix never acquire a SOL price', () => {
  const e = decodePumpEvent(trade(PROGRAMS.TOKEN));
  assert.equal(e.priceQuote, null);
  assert.equal(e.quoteAmount, null);
  const ix = trade();
  ix.data = encodeBase58(decodeBase58(ix.data).slice(0, -1));
  assert.ok(decodePumpEvent(ix)?.priceQuote == null);
  assert.equal(decodeCurve(curve(PROGRAMS.TOKEN))?.priceSol, null);
});

test('live curve prices use quote decimals and preserve legacy SOL decoding', () => {
  const e = decodeCurve(curve());
  assert.equal(e.quoteMint, USDC);
  assert.equal(e.priceQuote, 0.002);
  assert.equal(e.priceSol, null);
  const legacy = Buffer.from(curve(), 'base64').subarray(0, 49);
  legacy.writeBigUInt64LE(30_000_000_000n, 16);
  assert.equal(decodeCurve(legacy.toString('base64')).priceSol, 30 / 500000);
});

test('live notification converts USDC to USD without a SOL price feed', () => {
  let result;
  const w = new LiveWatcher({ onEvent: (e) => (result = e), solUsd: null });
  w.subs.set(1, { kind: 'curve' });
  w.onMessage({ data: JSON.stringify({ method: 'accountNotification', params: { subscription: 1, result: { context: { slot: 1 }, value: { data: [curve(), 'base64'] } } } }) });
  assert.equal(result.priceUsd, 0.002);
  assert.equal(result.quoteMint, USDC);
});

// Runs before any other scan test: market.js memoises the SOL/USD lookup for a minute.
test('scan market cap uses the last priced event when a later event comes from token deltas', async () => {
  const prior = globalThis.fetch;
  const solUsdPair = { chainId: 'solana', baseToken: { address: PROGRAMS.WSOL }, quoteToken: { address: USDC, symbol: 'USDC' }, priceUsd: '100', liquidity: { usd: 1e9 } };
  globalThis.fetch = async (url) => new Response(JSON.stringify({ pairs: String(url).includes(PROGRAMS.WSOL) ? [solUsdPair] : [] }), { status: 200 });
  try {
    for (const quote of [USDC, PROGRAMS.WSOL]) {
      const raw = rawTrade(quote);
      const later = structuredClone(raw);
      later.slot = raw.slot + 1;
      later.transaction.signatures = ['later'];
      later.meta.innerInstructions = [];
      later.transaction.message.instructions = [];
      later.meta.preTokenBalances = [];
      later.meta.postTokenBalances = [{ accountIndex: 1, owner: fx.creator, mint: fx.mint, uiTokenAmount: { uiAmount: 5 } }];
      const records = [parseTx(raw), parseTx(later)];
      records.forEach((r, i) => (r.order = i));
      const events = extractLaunchEvents(records, fx.mint, { record: records[0], bondingCurve: fx.bondingCurve });
      assert.equal(events.at(-1).priceQuote, null, 'last event comes from token deltas');
      const rpc = {
        ...scanRpc(raw),
        pageSignatures: async () => ({ sigs: [{ signature: 'later', slot: later.slot, blockTime: later.blockTime, err: null }], exhausted: true }),
        getTransactions: async () => [later],
      };
      const report = await scan(raw, rpc);
      assert.equal(report.stages.launch.status, 'done', JSON.stringify(report.errors));
      assert.ok(Math.abs(report.market.marketCapUsd / (quote === USDC ? 2_000_000 : 200_000) - 1) < 1e-9);
      assert.equal(report.market.mcapSource, 'last launch-window trade');
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('actual scan launch fallback displays USDC USD market cap, and fails closed for unknown quote', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200 });
  try {
    for (const quote of [USDC, PROGRAMS.TOKEN]) {
      const report = await scan(rawTrade(quote));
      assert.equal(report.stages.launch.status, 'done', JSON.stringify(report.errors));
      assert.equal(report.market.marketCapUsd ?? null, quote === USDC ? 2_000_000 : null);
      assert.equal(report.market.priceUsd ?? null, quote === USDC ? 0.002 : null);
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('dev and cluster sell market caps retain USDC quote identity without SOL USD', async () => {
  const raw = rawTrade(USDC, { buy: false });
  const rpc = { ataFor: async () => fx.creator, getSignaturesForAddress: async () => [{ signature: 's', blockTime: 1060 }], getTransactions: async () => [raw] };
  const launch = { mint: fx.mint, creator: fx.creator, createdAt: 1_000_000, launchBuyers: [], clusterWallets: [] };
  const dev = await devExitOnLaunch(rpc, fx.creator, launch, 1e9, null);
  const cluster = await clusterExitOnLaunch(rpc, launch, [], new Map(), null, 1e9, null);
  for (const e of [dev, cluster]) {
    assert.equal(e.mcapAtFirstSellUsd, 2_000_000);
    assert.equal(e.sellsDetail[0].quoteMint, USDC);
  }
  assert.equal(dev.solOut, null);
});

test('legacy event paired with non-SOL instruction cannot fall back to legacy SOL reserves', () => {
  const rec = parseTx(rawTrade(USDC, { legacy: true }));
  const e = rec.pumpEvents.find((x) => x.type === 'trade');
  assert.equal(e.quoteMint, USDC);
  assert.equal(e.priceQuote, null);
  assert.equal(e.quoteAmount, null);
});

test('instruction-only USDC fallback uses quote token deltas, never transaction SOL fees', () => {
  const raw = rawTrade();
  raw.meta.innerInstructions = [];
  raw.meta.preTokenBalances = [
    { accountIndex: 1, owner: fx.creator, mint: fx.mint, uiTokenAmount: { uiAmount: 0 } },
    { accountIndex: 2, owner: fx.creator, mint: USDC, uiTokenAmount: { uiAmount: 250 } },
  ];
  raw.meta.postTokenBalances = [
    { accountIndex: 1, owner: fx.creator, mint: fx.mint, uiTokenAmount: { uiAmount: 100 } },
    { accountIndex: 2, owner: fx.creator, mint: USDC, uiTokenAmount: { uiAmount: 0 } },
  ];
  const rec = parseTx(raw);
  const c = classifyForMint(rec, fx.mint, fx.creator);
  assert.equal(c.quoteAmount, 250);
  assert.equal(c.sol, null);
  const e = extractLaunchEvents([rec], fx.mint, { record: rec, bondingCurve: fx.bondingCurve })[0];
  assert.equal(e.quoteAmount, 250);
  assert.equal(e.sol, null);
  assert.equal(e.priceQuote, null);
});

test('USDC historical on-chain peak/current price is computed without SOL price', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ pairs: [], data: [] }), { status: 200 });
  try {
    const raw = rawTrade(USDC, { buy: false });
    const rpc = { getSignaturesForAddress: async () => [{ signature: 's', blockTime: 1060 }], getTransactions: async () => [raw] };
    const launch = { mint: fx.mint, creator: fx.creator, createdAt: 1000000, launchBuyers: [], clusterWallets: [] };
    const [r] = await analysePriorLaunches(rpc, [launch], [], new Map(), { supply: 1e9 });
    assert.equal(r.source, 'on-chain');
    assert.equal(r.peakMcapUsd, 2000000);
    assert.equal(r.nowMcapUsd, 2000000);
  } finally {
    globalThis.fetch = prior;
  }
});

test('SOL live quote applies SOL/USD once, unknown quote remains unpriced', () => {
  for (const quote of [PROGRAMS.WSOL, PROGRAMS.SYSTEM, PROGRAMS.TOKEN]) {
    let result;
    const w = new LiveWatcher({ solUsd: 100, onEvent: (e) => (result = e) });
    w.subs.set(1, { kind: 'curve' });
    w.onMessage({ data: JSON.stringify({ method: 'accountNotification', params: { subscription: 1, result: { value: { data: [curve(quote), 'base64'] } } } }) });
    if (quote === PROGRAMS.TOKEN) assert.equal(result.priceUsd, null);
    else assert.ok(Math.abs(result.priceUsd - 0.0002) < 1e-15);
  }
});

test('launch summaries preserve unavailable SOL amounts instead of reporting USDC as SOL', () => {
  const rec = parseTx(rawTrade());
  const events = extractLaunchEvents([rec], fx.mint, { record: rec, bondingCurve: fx.bondingCurve });
  const dev = analyseLaunch(events);
  assert.equal(dev.creatorDevBuy.sol, null);
  const other = analyseLaunch(events.map((e) => ({ ...e, isCreator: false })));
  assert.equal(other.window.sol, null);
  assert.equal(other.buyers[0].sol, null);
});

test('standalone legacy trade keeps SOL9, and current USDC fields survive multiple quote events', () => {
  const legacy = decodePumpEvent(trade(PROGRAMS.WSOL, { legacy: true }));
  assert.equal(legacy.quoteMint, PROGRAMS.WSOL);
  assert.equal(legacy.vSol, 30);
  assert.equal(legacy.priceQuote, 30 / 500000);
  const raw = rawTrade();
  raw.meta.innerInstructions[0].instructions.push(trade(PROGRAMS.TOKEN));
  const trades = parseTx(raw).pumpEvents.filter((e) => e.type === 'trade');
  assert.equal(trades[0].quoteMint, USDC);
  assert.equal(trades[0].priceQuote, 0.002);
  assert.equal(trades[1].quoteMint, PROGRAMS.TOKEN);
  assert.equal(trades[1].priceQuote, null);
});

test('create-only scan uses initial USDC reserves; an unsupported quote stays unpriced', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200 });
  try {
    for (const quote of [USDC, PROGRAMS.TOKEN]) {
      const raw = rawTrade(quote);
      raw.meta.innerInstructions[0].instructions = [create(quote)];
      raw.meta.preTokenBalances = [];
      raw.meta.postTokenBalances = [];
      const r = await scan(raw);
      assert.equal(r.stages.launch?.status, 'done', JSON.stringify(r.errors));
      assert.equal(r.market.marketCapUsd ?? null, quote === USDC ? 2000000 : null);
      if (quote === USDC) assert.equal(r.market.mcapSource, 'initial bonding-curve price (no trades yet)');
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('pool resolution excludes the USDC quote vault in both account and transaction fallbacks', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200 });
  try {
    for (const viaAccounts of [true, false]) {
      const rpc = {
        getAccountInfo: async () => ({ value: { owner: PROGRAMS.PUMP } }),
        getOwnerTokenMints: async () => (viaAccounts ? [{ mint: USDC, amount: 1000000 }, { mint: fx.mint, amount: 100 }] : []),
        getSignaturesForAddress: async () => [{ signature: 's' }],
        getTransaction: async () => ({ meta: { postTokenBalances: [{ mint: USDC }, { mint: fx.mint }] } }),
      };
      const r = await resolveMint(rpc, fx.bondingCurve);
      assert.equal(r.mint, fx.mint);
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('market pair retains its quote identity for a safe SOL/USD fallback', () => {
  for (const mint of [PROGRAMS.WSOL, USDC, PROGRAMS.TOKEN]) {
    const pair = normalisePair({ baseToken: { address: fx.mint }, quoteToken: { address: mint }, priceUsd: '0.2', priceNative: '0.002' });
    assert.equal(pair.quoteMint, mint);
    assert.equal(marketSolUsd(pair), mint === PROGRAMS.WSOL ? 100 : null);
    assert.equal(marketSolUsd({ ...pair, priceNative: 0 }), null);
  }
});
