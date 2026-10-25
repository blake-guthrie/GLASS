import { PROGRAMS } from './constants.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Older pump records use the zero pubkey for native SOL. Never infer the asset
// from a ticker symbol: anyone can create a token named USDC.
export function normaliseQuoteMint(mint) {
  return !mint || mint === PROGRAMS.SYSTEM ? PROGRAMS.WSOL : mint;
}

export function quoteScale(mint) {
  const m = normaliseQuoteMint(mint);
  return m === PROGRAMS.WSOL ? 1e9 : m === USDC_MINT ? 1e6 : null;
}

export function quotePriceUsd(price, mint, solUsd) {
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const m = normaliseQuoteMint(mint);
  const fx = m === USDC_MINT ? 1 : m === PROGRAMS.WSOL ? solUsd : null;
  return fx > 0 && Number.isFinite(fx) ? price * fx : null;
}
