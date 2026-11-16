// src/lib/market.js
// Utility functions for market‑related calculations used by the GLASS extension.

import { getPrice } from "./http.js";
import { knownTokens } from "../data/known.js";

/**
 * Calculate the market cap for a given token pair.
 *
 * @param {Object} pair - The token pair object containing `base` and `quote` symbols.
 * @param {number} supply - Total circulating supply of the base token.
 * @returns {Promise<number>} Market cap in USD.
 */
export async function calculateMarketCap(pair, supply) {
  // If the quote currency is USDC (or USDT, which is also a stable USD peg), the price
  // returned by the on‑chain oracle is already denominated in USD. In that case we can
  // use the price directly without any further conversion.
  const isUsdStable = pair.quote === "USDC" || pair.quote === "USDT";

  // Retrieve the price of the base token in terms of the quote currency.
  const priceInQuote = await getPrice(pair.base, pair.quote);

  // Convert the price to USD if necessary.
  const priceInUsd = isUsdStable ? priceInQuote : await convertToUsd(pair.quote, priceInQuote);

  // Market cap is simply price (USD) * circulating supply.
  return priceInUsd * supply;
}

/**
 * Convert a price expressed in a non‑USD quote currency to USD.
 * This helper queries the price of the quote token against USDC.
 *
 * @param {string} quote - The quote currency symbol (e.g., "SOL").
 * @param {number} priceInQuote - The price of the base token in the quote currency.
 * @returns {Promise<number>} Price expressed in USD.
 */
async function convertToUsd(quote, priceInQuote) {
  // Guard against unknown quote tokens.
  if (!knownTokens[quote]) {
    throw new Error(`Unknown quote token: ${quote}`);
  }

  // Fetch the USD price of the quote token (e.g., SOL/USD).
  const quoteUsdPrice = await getPrice(quote, "USDC");
  return priceInQuote * quoteUsdPrice;
}

// Export for testing purposes.
export const __private = { convertToUsd };
