import { PROGRAMS } from './constants.js';

// Keep different currencies separate. Missing/unsupported quotes must not become zero SOL.
export function sumQuotes(rows) {
  const total = { sol: 0, usdc: 0, unknown: 0 };
  for (const row of rows) {
    if (row.quotes) {
      for (const key of Object.keys(total)) total[key] += row.quotes[key] || 0;
      continue;
    }
    const legacy = !Object.hasOwn(row, 'quoteMint');
    const mint = legacy ? PROGRAMS.WSOL : row.quoteMint;
    const amount = legacy ? row.sol : row.quoteAmount;
    if (!Number.isFinite(amount) || amount < 0) total.unknown++;
    else if (mint === PROGRAMS.WSOL) total.sol += amount;
    else if (mint === PROGRAMS.USDC) total.usdc += amount;
    else total.unknown++;
  }
  return total;
}
