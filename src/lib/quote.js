// Quote assets of pump.fun bonding curves. Most curves are priced in SOL, USDC-quoted pairs in USDC: amounts
// must be scaled by that asset's decimals, and a price in a USD stablecoin is already a USD price (multiplying
// it by the SOL price again is what gave USDC-quoted pairs a wrong market cap).
import { PROGRAMS, USDC_MINT } from './constants.js';

export const QUOTES = {
  [PROGRAMS.WSOL]: { mint: PROGRAMS.WSOL, symbol: 'SOL', decimals: 9, usd: false },
  [USDC_MINT]: { mint: USDC_MINT, symbol: 'USDC', decimals: 6, usd: true },
};

/** Quote asset info for a mint. Missing (legacy SOL-only instructions) or unknown mints are treated as SOL. */
export function quoteInfo(mint) {
  return QUOTES[mint] || QUOTES[PROGRAMS.WSOL];
}

/** USD value of one unit of the quote asset: 1 for a USD stablecoin, else the SOL price (null if unknown). */
export function quoteUsdPrice(mint, solUsd) {
  return quoteInfo(mint).usd ? 1 : solUsd || null;
}

/** Market cap in USD from a per-token price quoted in `quoteMint`. */
export function mcapUsdFromQuote(priceQuote, supply, quoteMint, solUsd) {
  const usd = quoteUsdPrice(quoteMint, solUsd);
  return priceQuote && supply && usd ? priceQuote * supply * usd : null;
}
