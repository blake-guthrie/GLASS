import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { decodeBase58, encodeBase58, isBase58Address, readU64LE } from '../src/lib/base58.js';
import { isOnCurve, findProgramAddress } from '../src/lib/pda.js';
import { PUMP_IX, PROGRAMS, JITO_TIP_ACCOUNTS } from '../src/lib/constants.js';
import { parseTx, txInitialisesMint, classifyForMint, decodePumpIx } from '../src/lib/txparse.js';
import { derivePumpAccounts, extractLaunchEvents } from '../src/lib/scan/launch.js';
import { quoteToUsdMultiplier } from '../src/lib/market.js';

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

test('extractLaunchEvents uses USDC decimals and preserves the USD quote', () => {
  const rec = {
    err: null,
    sig: 'usdc-trade',
    slot: 10,
    blockTime: 100,
    order: 1,
    feePayer: fx.creator,
    systemTransfers: [],
    pumpIxs: [{ user: fx.creator, quoteMint: PROGRAMS.USDC, name: 'buy_v3' }],
    pumpEvents: [
      {
        type: 'trade',
        mint: fx.mint,
        user: fx.creator,
        isBuy: true,
        quoteAmountRaw: 1_500_000n,
        tokenAmountRaw: 60_000_000n,
        virtualQuoteReservesRaw: 12_500_000_000n,
        virtualTokenReservesRaw: 500_000_000_000n,
      },
    ],
  };
  const creation = { record: { ...rec, sig: 'create' }, bondingCurve: fx.bondingCurve };
  const [event] = extractLaunchEvents([rec], fx.mint, creation);
  assert.equal(event.quoteMint, PROGRAMS.USDC);
  assert.equal(event.quoteSymbol, 'USDC');
  assert.equal(event.quoteAmount, 1.5);
  assert.equal(event.tokens, 60);
  assert.equal(event.priceQuote, 0.025);
  assert.equal(quoteToUsdMultiplier(event.quoteMint, 250), 1);
});

test('quoteToUsdMultiplier prices SOL quotes and rejects unknown quote assets', () => {
  assert.equal(quoteToUsdMultiplier(PROGRAMS.WSOL, 250), 250);
  assert.equal(quoteToUsdMultiplier(null, 250), 250);
  assert.equal(quoteToUsdMultiplier('unknown', 250), null);
});
