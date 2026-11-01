import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { decodeBase58, encodeBase58, isBase58Address, readU64LE } from '../src/lib/base58.js';
import { isOnCurve, findProgramAddress } from '../src/lib/pda.js';
import { PUMP_IX, PROGRAMS, JITO_TIP_ACCOUNTS } from '../src/lib/constants.js';
import { parseTx, txInitialisesMint, classifyForMint, decodePumpIx } from '../src/lib/txparse.js';
import { derivePumpAccounts, extractLaunchEvents } from '../src/lib/scan/launch.js';
import { normalisePair, isUsdQuotedPair } from '../src/lib/market.js';

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

test('USDC-quoted pairs: normalisePair preserves quote metadata and derives USD price/marketCap without SOL inflation', () => {
  const usdcPair = {
    chainId: 'solana',
    pairAddress: 'PoolUSDC1111111111111111111111111111111111',
    dexId: 'raydium',
    baseToken: { address: fx.mint, name: 'TestCoin', symbol: 'TEST' },
    quoteToken: { address: PROGRAMS.USDC, symbol: 'USDC' },
    priceNative: '0.0042',
    liquidity: { usd: 50000 },
  };
  assert.equal(isUsdQuotedPair(usdcPair), true);
  const norm = normalisePair(usdcPair, 1_000_000_000);
  assert.equal(norm.isUsdQuoted, true);
  assert.equal(norm.quoteMint, PROGRAMS.USDC);
  assert.equal(norm.quoteSymbol, 'USDC');
  assert.equal(norm.priceUsd, 0.0042);
  assert.equal(norm.marketCapUsd, 4_200_000);
  assert.equal(norm.fdvUsd, 4_200_000);
});

test('USDC-quoted pairs: decodePumpIx and parseTx rescale 6-decimal USDC quote amounts and TradeEvent priceQuote', () => {
  const buyClone = structuredClone(fx.txs.buy);
  // Replace quoteMint (accounts[2] on buy_exact_quote_in_v3) with SPL USDC
  const pumpIxRaw = buyClone.transaction.message.instructions.find((ix) => ix.programId === PROGRAMS.PUMP);
  pumpIxRaw.accounts[2] = PROGRAMS.USDC;
  const parsed = parseTx(buyClone, 'sig-usdc-buy');
  const b = parsed.pumpIxs.find((p) => p.kind === 'buy');
  assert.equal(b.quoteMint, PROGRAMS.USDC);
  assert.equal(b.quoteIsUsd, true);
  // Raw quote amount scaled by 1e6 (USDC) instead of 1e9 (SOL) -> 1000x larger numeric unit value
  const solParsed = parseTx(fx.txs.buy, fx.sigs.buy);
  const bSol = solParsed.pumpIxs.find((p) => p.kind === 'buy');
  assert.ok(Math.abs(b.solIn / bSol.solIn - 1000) < 1e-6);

  const tev = parsed.pumpEvents.find((e) => e.type === 'trade');
  const tevSol = solParsed.pumpEvents.find((e) => e.type === 'trade');
  assert.equal(tev.quoteMint, PROGRAMS.USDC);
  assert.equal(tev.quoteIsUsd, true);
  assert.ok(Math.abs(tev.priceQuote / tevSol.priceQuote - 1000) < 1e-6);

  const events = extractLaunchEvents([parsed], fx.mint, { record: parsed, bondingCurve: fx.bondingCurve });
  const tradeEv = events.find((e) => e.side === 'buy');
  assert.equal(tradeEv.quoteIsUsd, true);
  assert.equal(tradeEv.quoteMint, PROGRAMS.USDC);
});
