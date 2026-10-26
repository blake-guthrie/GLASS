import { test } from 'node:test';
import assert from 'node:assert/strict';
import known from '../src/data/known.js';

test('known exchanges: Bitfinex hot-wallet classification and provenance', () => {
  const bitfinexWallet = 'FxteHmLwG9nk1eL4pjNve3Eub2goGkkz6g6TbvdmW46a';
  assert.equal(known.exchanges[bitfinexWallet], 'Bitfinex', 'Bitfinex hot wallet resolves correctly');
});

test('known exchanges: preserves existing exchange labels', () => {
  assert.equal(known.exchanges['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'], 'Binance');
  assert.equal(known.exchanges['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'], 'Coinbase');
  assert.equal(known.exchanges['5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD'], 'OKX');
  assert.equal(known.exchanges['AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2'], 'Bybit');
  assert.equal(known.exchanges['FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5'], 'Kraken');
  assert.equal(known.exchanges['u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w'], 'Gate.io');
  assert.equal(known.exchanges['BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6'], 'KuCoin');
  assert.equal(known.exchanges['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ'], 'MEXC');
  assert.equal(known.exchanges['AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS'], 'Crypto.com');
  assert.equal(known.exchanges['88xTWZMeKfiTgbfEmPLdsUCQcZinwUfk25EBQZ21XMAZ'], 'HTX');
});

test('known exchanges: unknown-address controls return undefined', () => {
  // Unknown Solana addresses must not match any exchange
  assert.equal(known.exchanges['11111111111111111111111111111111'], undefined);
  assert.equal(known.exchanges['So11111111111111111111111111111111111111112'], undefined);
  assert.equal(known.exchanges['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], undefined);
  assert.equal(known.exchanges['randomUnregisteredWalletAddress1234567890'], undefined);
});
