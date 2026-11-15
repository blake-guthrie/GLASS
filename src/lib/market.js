import { SOL_MINT, USDC_MINT, USDT_MINT } from './constants.js';

/**
 * Calculates the actual USD price based on the quote mint.
 * @param {number} price - The raw price from the pair/pool.
 * @param {string} quoteMint - The mint address of the quote currency.
 * @param {number} solPrice - The current price of SOL in USD.
 * @returns {number} - The price converted to USD.
 */
export function calculateUSDPrice(price, quoteMint, solPrice) {
  // If the pair is quoted in USDC or USDT, the price is already in USD (approx 1:1)
  if (quoteMint === USDC_MINT || quoteMint === USDT_MINT) {
    return price;
  }

  // If quoted in SOL, multiply by current SOL price
  if (quoteMint === SOL_MINT) {
    return price * solPrice;
  }

  // Default to SOL multiplier if unknown, or return price as is if logic dictates
  return price * solPrice;
}

/**
 * Formats and calculates market cap.
 * @param {number} totalSupply - Total supply of the token.
 * @param {number} price - Raw price from the pair.
 * @param {string} quoteMint - Mint of the quote token.
 * @param {number} solPrice - Current SOL price.
 * @returns {number} - The calculated Market Cap in USD.
 */
export function getMarketCap(totalSupply, price, quoteMint, solPrice) {
  const usdPrice = calculateUSDPrice(price, quoteMint, solPrice);
  return (totalSupply / Math.pow(10, 6)) * usdPrice; // Assuming standard 6 decimals for calculation if not provided
}

export function formatCash(n) {
  if (n < 1e3) return n.toFixed(2);
  if (n >= 1e3 && n < 1e6) return +(n / 1e3).toFixed(1) + "K";
  if (n >= 1e6 && n < 1e9) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e9 && n < 1e12) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e12) return +(n / 1e12).toFixed(1) + "T";
};
