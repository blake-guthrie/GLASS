// Quote-asset scaling for pump.fun trades (SOL = 9 decimals, USDC = 6).
import { PROGRAMS, LAMPORTS_PER_SOL } from './constants.js';

export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;

/** Decimals for a known quote mint. Defaults to SOL (9) when mint is missing (legacy SOL curves). */
export function quoteDecimals(quoteMint) {
  if (quoteMint === PROGRAMS.USDC) return USDC_DECIMALS;
  if (!quoteMint || quoteMint === PROGRAMS.WSOL) return SOL_DECIMALS;
  return null;
}

/** Divide a raw on-chain quote amount by the mint's decimals. */
export function scaleQuoteRaw(raw, quoteMint) {
  const decimals = quoteDecimals(quoteMint);
  if (decimals == null || raw == null) return null;
  return Number(raw) / 10 ** decimals;
}

/** Symbol used in the panel / report for a quote mint. */
export function quoteSymbol(quoteMint) {
  if (quoteMint === PROGRAMS.USDC) return 'USDC';
  if (!quoteMint || quoteMint === PROGRAMS.WSOL) return 'SOL';
  return null;
}

/**
 * Convert 1 unit of quote into USD.
 * USDC → 1; SOL → solPriceUsd; unknown → null.
 */
export function quoteToUsdMultiplier(quoteMint, solPriceUsd) {
  if (quoteMint === PROGRAMS.USDC) return 1;
  if (!quoteMint || quoteMint === PROGRAMS.WSOL) return solPriceUsd ?? null;
  return null;
}

/**
 * Re-scale a decoded TradeEvent with the pair's quote mint.
 * TradeEvent itself does not carry quote_mint; modern buy/sell ixs put it at accounts[2].
 * Raw fields (when present) are preferred so USDC amounts are not stuck at the SOL 1e9 scale.
 */
export function tradeQuoteAmounts(trade, quoteMint = PROGRAMS.WSOL) {
  const scale = 10 ** (quoteDecimals(quoteMint) ?? SOL_DECIMALS);
  const quoteAmount =
    trade.quoteAmountRaw != null ? Number(trade.quoteAmountRaw) / scale : trade.quoteAmount;
  const tokenAmount =
    trade.tokenAmountRaw != null ? Number(trade.tokenAmountRaw) / 1e6 : trade.tokenAmount;
  const vQuote =
    trade.virtualQuoteReservesRaw != null
      ? Number(trade.virtualQuoteReservesRaw) / scale
      : trade.vSol;
  const vTok =
    trade.virtualTokenReservesRaw != null
      ? Number(trade.virtualTokenReservesRaw) / 1e6
      : trade.vTok;
  const rQuote =
    trade.realQuoteReservesRaw != null ? Number(trade.realQuoteReservesRaw) / scale : trade.rSol;
  const rTok =
    trade.realTokenReservesRaw != null ? Number(trade.realTokenReservesRaw) / 1e6 : trade.rTok;
  return {
    quoteMint: quoteMint || PROGRAMS.WSOL,
    quoteSymbol: quoteSymbol(quoteMint),
    quoteAmount,
    tokenAmount,
    vQuote,
    vTok,
    rQuote,
    rTok,
    priceQuote: vTok > 0 ? vQuote / vTok : null,
  };
}

/** Prefer the matching pump ix's quoteMint, else any modern ix, else WSOL (legacy). */
export function quoteMintFromIxs(pumpIxs = [], user = null) {
  const match = user ? pumpIxs.find((p) => p.user === user && p.quoteMint) : null;
  if (match?.quoteMint) return match.quoteMint;
  const any = pumpIxs.find((p) => p.quoteMint);
  return any?.quoteMint || PROGRAMS.WSOL;
}

/** Scale used by instruction decoders (exact_quote_in / solLimit). */
export function quoteScale(quoteMint) {
  const d = quoteDecimals(quoteMint);
  if (d === USDC_DECIMALS) return 1e6;
  return LAMPORTS_PER_SOL;
}
