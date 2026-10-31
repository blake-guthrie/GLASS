import { PROGRAMS } from './constants.js';

// Pump uses the zero public key for the quote of legacy/native SOL curves.
export function normaliseQuoteMint(mint) {
  return !mint || mint === PROGRAMS.SYSTEM ? PROGRAMS.WSOL : mint;
}

export function quoteDecimals(mint) {
  mint = normaliseQuoteMint(mint);
  return mint === PROGRAMS.WSOL ? 9 : mint === PROGRAMS.USDC ? 6 : null;
}

/** Convert an explicitly identified quote, never a token symbol, into USD. */
export function quotePriceUsd(record, solUsd, market = null) {
  if (!record || !Number.isFinite(record.priceQuote) || record.priceQuote < 0) return null;
  const mint = normaliseQuoteMint(record.quoteMint);
  let rate = null;
  if (mint === PROGRAMS.WSOL && Number.isFinite(solUsd) && solUsd > 0) rate = solUsd;
  // A pair's USD/native price ratio prices that pair's quote, not necessarily SOL.
  if (rate == null && market?.quoteMint === mint && Number.isFinite(market.priceUsd) && market.priceUsd > 0 && Number.isFinite(market.priceNative) && market.priceNative > 0) {
    rate = market.priceUsd / market.priceNative;
  }
  // Without a market quote, value Circle's actual USDC mint at its nominal $1 peg.
  if (rate == null && mint === PROGRAMS.USDC) rate = 1;
  if (rate == null) return null;
  const usd = record.priceQuote * rate;
  return Number.isFinite(usd) ? usd : null;
}

export function fallbackValuation(market, supply, record, solUsd) {
  if (!Number.isFinite(supply) || supply <= 0) return null;
  const reported = market?.priceUsd;
  const priceUsd = Number.isFinite(reported) && reported >= 0 ? reported : quotePriceUsd(record, solUsd, market);
  if (priceUsd == null || !Number.isFinite(priceUsd * supply)) return null;
  return { priceUsd, marketCapUsd: priceUsd * supply };
}
