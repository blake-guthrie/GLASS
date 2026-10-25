import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS } from '../src/lib/constants.js';
import {
  quoteDecimals,
  scaleQuoteRaw,
  quoteToUsdMultiplier,
  tradeQuoteAmounts,
  quoteMintFromIxs,
  quoteScale,
} from '../src/lib/quote.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { normalisePair } from '../src/lib/market.js';

const USDC = PROGRAMS.USDC;
const WSOL = PROGRAMS.WSOL;
const mint = 'TokenMint111111111111111111111111111111111';
const creator = 'Creator11111111111111111111111111111111111';
const curve = 'Curve1111111111111111111111111111111111111';

test('quoteDecimals / scaleQuoteRaw: SOL 9 dp, USDC 6 dp', () => {
  assert.equal(quoteDecimals(WSOL), 9);
  assert.equal(quoteDecimals(null), 9);
  assert.equal(quoteDecimals(USDC), 6);
  assert.equal(scaleQuoteRaw(1_500_000_000, WSOL), 1.5);
  assert.equal(scaleQuoteRaw(1_500_000, USDC), 1.5);
  assert.equal(quoteScale(USDC), 1e6);
  assert.equal(quoteScale(WSOL), 1e9);
});

test('quoteToUsdMultiplier: USDC is 1×, SOL uses solPrice, unknown is null', () => {
  assert.equal(quoteToUsdMultiplier(USDC, 250), 1);
  assert.equal(quoteToUsdMultiplier(WSOL, 250), 250);
  assert.equal(quoteToUsdMultiplier(null, 250), 250);
  assert.equal(quoteToUsdMultiplier('SomeOtherMint111111111111111111111111111', 250), null);
});

test('tradeQuoteAmounts rescales USDC TradeEvent raws (not stuck at 1e9)', () => {
  const trade = {
    quoteAmountRaw: 1_500_000, // 1.5 USDC
    tokenAmountRaw: 60_000_000, // 60 tokens
    virtualQuoteReservesRaw: 12_500_000_000, // 12_500 USDC
    virtualTokenReservesRaw: 500_000_000_000, // 500_000 tokens
    // wrongly pre-scaled-as-SOL fields (what decodePumpEvent still emits by default)
    quoteAmount: 1_500_000 / 1e9,
    tokenAmount: 60,
    vSol: 12_500_000_000 / 1e9,
    vTok: 500_000,
  };
  const q = tradeQuoteAmounts(trade, USDC);
  assert.equal(q.quoteAmount, 1.5);
  assert.equal(q.tokenAmount, 60);
  assert.equal(q.priceQuote, 0.025); // 12500 / 500000
  assert.equal(q.quoteSymbol, 'USDC');

  // SOL path stays correct when raws are lamports
  // 30 SOL virtual / 1_000_000 tokens → priceQuote 0.00003 SOL/token
  const solTrade = {
    quoteAmountRaw: 1_500_000_000,
    tokenAmountRaw: 60_000_000,
    virtualQuoteReservesRaw: 30_000_000_000,
    virtualTokenReservesRaw: 1_000_000_000_000,
  };
  const s = tradeQuoteAmounts(solTrade, WSOL);
  assert.equal(s.quoteAmount, 1.5);
  assert.equal(s.vQuote, 30);
  assert.equal(s.vTok, 1_000_000);
  assert.equal(s.priceQuote, 0.00003);
  assert.equal(s.quoteSymbol, 'SOL');
});

test('extractLaunchEvents: USDC pair uses 1e6 and does not inflate priceQuote', () => {
  const rec = {
    err: null,
    sig: 'usdc-trade-sig',
    slot: 100,
    blockTime: 1000,
    order: 1,
    feePayer: creator,
    systemTransfers: [],
    tokenDeltas: [],
    solDelta: {},
    pumpIxs: [{ user: creator, quoteMint: USDC, name: 'buy_v3', kind: 'buy', solLimit: 2 }],
    pumpEvents: [
      {
        type: 'trade',
        mint,
        user: creator,
        isBuy: true,
        quoteAmountRaw: 1_500_000,
        tokenAmountRaw: 60_000_000,
        virtualQuoteReservesRaw: 12_500_000_000,
        virtualTokenReservesRaw: 500_000_000_000,
        // poison SOL-scaled defaults — extractLaunchEvents must ignore these when raws exist
        quoteAmount: 0.0015,
        tokenAmount: 60,
        vSol: 12.5,
        vTok: 500_000,
        priceQuote: 12.5 / 500_000,
      },
    ],
  };
  const creation = { record: { ...rec, sig: 'create', slot: 100, blockTime: 1000, feePayer: creator }, bondingCurve: curve };
  const [event] = extractLaunchEvents([rec], mint, creation);
  assert.equal(event.quoteMint, USDC);
  assert.equal(event.quoteSymbol, 'USDC');
  assert.equal(event.quoteAmount, 1.5);
  assert.equal(event.sol, 1.5);
  assert.equal(event.tokens, 60);
  assert.equal(event.priceQuote, 0.025);

  // USD market cap from reserves: priceQuote * supply * 1 (not * solPrice)
  const supply = 1_000_000_000;
  const solFx = 185;
  const bugged = event.priceQuote * supply * solFx;
  const fixed = event.priceQuote * supply * quoteToUsdMultiplier(event.quoteMint, solFx);
  assert.equal(fixed, 25_000_000);
  assert.ok(bugged > fixed * 100, 'bug would inflate mcap by ~SOL price');
});

test('quoteMintFromIxs prefers the trader matching ix', () => {
  const ixs = [
    { user: 'A', quoteMint: WSOL },
    { user: 'B', quoteMint: USDC },
  ];
  assert.equal(quoteMintFromIxs(ixs, 'B'), USDC);
  assert.equal(quoteMintFromIxs(ixs, 'Z'), WSOL); // first with quoteMint
  assert.equal(quoteMintFromIxs([], null), WSOL);
});

test('normalisePair keeps DexScreener quote mint/symbol', () => {
  const n = normalisePair({
    pairAddress: 'pair',
    dexId: 'raydium',
    baseToken: { address: mint, name: 'T', symbol: 'T' },
    quoteToken: { address: USDC, symbol: 'USDC' },
    priceUsd: '0.01',
    marketCap: 10_000,
  });
  assert.equal(n.quoteMint, USDC);
  assert.equal(n.quoteSymbol, 'USDC');
  assert.equal(n.marketCapUsd, 10_000);
});
