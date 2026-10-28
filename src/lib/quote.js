// Pump uses a zero pubkey for native SOL in persisted accounts/events and WSOL in trade accounts.
import { PROGRAMS } from './constants.js';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function quoteInfo(mint) {
  if (mint === PROGRAMS.SYSTEM || mint === PROGRAMS.WSOL) return { quoteMint: PROGRAMS.WSOL, quoteDecimals: 9 };
  return { quoteMint: mint ?? null, quoteDecimals: mint === USDC_MINT ? 6 : null };
}
export function quoteUnits(raw, mint) {
  const { quoteDecimals } = quoteInfo(mint);
  return quoteDecimals == null ? null : Number(raw) / 10 ** quoteDecimals;
}
export function quoteUsd(amount, mint, solUsd) {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const rate = mint === USDC_MINT ? 1 : quoteInfo(mint).quoteMint === PROGRAMS.WSOL ? solUsd : null;
  return Number.isFinite(rate) && rate > 0 ? amount * rate : null;
}

// DexScreener's priceNative is in the pair's quote asset, not necessarily SOL.
export function marketSolUsd(market) {
  if (quoteInfo(market?.quoteMint).quoteMint !== PROGRAMS.WSOL) return null;
  const rate = market?.priceUsd / market?.priceNative;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
