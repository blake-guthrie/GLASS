import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalisePair } from '../src/lib/market.js';
import { decodePumpIx } from '../src/lib/txparse.js';
import { encodeBase58 } from '../src/lib/base58.js';
import { PROGRAMS, USD_STABLE_MINTS } from '../src/lib/constants.js';

test('normalisePair: USDC-quoted pair sets isUsdQuote and keeps USD price without SOL conversion', () => {
  const mockPair = {
    pairAddress: 'pair123',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/pair123',
    baseToken: { address: 'TokenMint1111111111111111111111111111111111', name: 'Test Token', symbol: 'TEST' },
    quoteToken: { address: PROGRAMS.USDC, name: 'USD Coin', symbol: 'USDC' },
    priceNative: '0.052',
    priceUsd: '0.052',
    marketCap: 52000,
    fdv: 52000,
    liquidity: { usd: 15000 },
    volume: { h24: 85000 }
  };

  const norm = normalisePair(mockPair);
  assert.equal(norm.isUsdQuote, true);
  assert.equal(norm.priceUsd, 0.052);
  assert.equal(norm.marketCapUsd, 52000);
  assert.equal(norm.quoteSymbol, 'USDC');
});

test('decodePumpIx: modern buy_exact_quote_in with USDC quote mint uses 6 decimals', () => {
  // Mock instruction with buy_exact_quote_in_v3 Anchor discriminator
  // disc = [225, 247, 80, 30, 213, 179, 132, 136]
  const disc = [225, 247, 80, 30, 213, 179, 132, 136];
  const data = new Uint8Array(32);
  data.set(disc, 0);
  
  // Set amount: 100 USDC in raw atomic units (100 * 1e6 = 100_000_000)
  const amountU64 = 100_000_000n;
  for (let i = 0; i < 8; i++) {
    data[8 + i] = Number((amountU64 >> BigInt(i * 8)) & 0xffn);
  }
  
  // Set min tokens limit
  const limitU64 = 50_000_000_000n;
  for (let i = 0; i < 8; i++) {
    data[16 + i] = Number((limitU64 >> BigInt(i * 8)) & 0xffn);
  }

  // Base58 encode data
  const base58Data = encodeBase58(data);

  const ix = {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    data: base58Data,
    accounts: [
      'GlobalAccount1111111111111111111111111111111',
      'TokenMint1111111111111111111111111111111111',
      PROGRAMS.USDC, // quote_mint at accounts[2]
      'Token2022Program1111111111111111111111111111',
      'TokenProgram11111111111111111111111111111111',
      'BondingCurve111111111111111111111111111111111',
      'UserAccount1111111111111111111111111111111111'
    ]
  };

  const decoded = decodePumpIx(ix, ['UserAccount1111111111111111111111111111111111']);
  assert.ok(decoded);
  assert.equal(decoded.isUsdQuote, true);
  assert.equal(decoded.quoteMint, PROGRAMS.USDC);
  assert.equal(decoded.solIn, 100); // 100_000_000 / 1e6 = 100 USDC! (NOT 0.1)
  assert.equal(decoded.quoteIn, 100);
});
