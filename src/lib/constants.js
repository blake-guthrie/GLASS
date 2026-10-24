// Program IDs, well-known accounts and instruction discriminators.
// Anchor discriminators = sha256("global:<ix_name>")[0..8]; verified in test/discriminators.test.mjs.

export const PROGRAMS = {
  PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_FEES: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  SYSTEM: '11111111111111111111111111111111',
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  METADATA: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp4',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// Labels for routers / trading bots that wrap pump.fun buys. Used for the "route" fingerprint.
export const ROUTER_LABELS = {
  [PROGRAMS.PUMP]: 'pump.fun direct',
  [PROGRAMS.PUMPSWAP]: 'PumpSwap',
  [PROGRAMS.JUPITER_V6]: 'Jupiter',
  [PROGRAMS.RAYDIUM_AMM]: 'Raydium',
  [PROGRAMS.RAYDIUM_CPMM]: 'Raydium CPMM',
  [PROGRAMS.METEORA_DLMM]: 'Meteora',
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW': 'Photon',
  // Add more router/bot program IDs in src/data/known.json → "programs". Unknown routers are
  // still fingerprinted by address, they just display truncated.
};

export const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

// Known pump.fun protocol fee recipients (older + newer). Newer ones are discovered dynamically too.
export const PUMP_FEE_RECIPIENTS = new Set([
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // original pump.fun fee account
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', // observed fee_recipient (Oct 2026)
]);
// The pump.fun `buy`/`sell` instruction carries fee_recipient at account index 1, and the
// parser reads it from there, so unknown rotating fee accounts are recognised per transaction.

// Every pump.fun buy/sell/create variant seen on mainnet through Oct 2026. Unknown future variants are
// still handled: trades are read from the program's TradeEvent CPI log, not from the instruction.
export const PUMP_IX = {
  create: [24, 30, 200, 40, 5, 28, 7, 119],
  create_v2: [214, 144, 76, 236, 95, 139, 49, 180],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  buy_v2: [184, 23, 238, 97, 103, 197, 211, 61],
  buy_v3: [7, 5, 29, 196, 245, 23, 101, 80],
  buy_exact_sol_in: [56, 252, 116, 8, 158, 223, 205, 95],
  buy_exact_quote_in: [198, 46, 21, 82, 180, 217, 232, 112],
  buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47],
  buy_exact_quote_in_v3: [225, 247, 80, 30, 213, 179, 132, 136],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  sell_v2: [93, 246, 130, 60, 231, 233, 64, 178],
  sell_v3: [28, 146, 222, 119, 38, 196, 105, 213],
  migrate: [155, 234, 231, 146, 236, 158, 162, 30],
};
export const PUMP_BUY_IX = new Set(['buy', 'buy_v2', 'buy_v3', 'buy_exact_sol_in', 'buy_exact_quote_in', 'buy_exact_quote_in_v2', 'buy_exact_quote_in_v3']);
export const PUMP_SELL_IX = new Set(['sell', 'sell_v2', 'sell_v3']);
export const PUMP_CREATE_IX = new Set(['create', 'create_v2']);

// Anchor event CPI: inner self-invoke whose data = [e4 45 a5 2e 51 cb 9a 1d] + event discriminator + fields
export const ANCHOR_EVENT_CPI = [228, 69, 165, 46, 81, 203, 154, 29];
export const PUMP_EVENTS = {
  TradeEvent: [189, 219, 127, 211, 78, 230, 97, 238],
  CreateEvent: [27, 114, 169, 77, 222, 235, 99, 118],
  CompleteEvent: [95, 114, 97, 156, 212, 46, 152, 8],
};

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const PUMP_TOTAL_SUPPLY = 1_000_000_000; // tokens (6 decimals)
export const PUMP_CURVE_SOL_TARGET = 85; // approx SOL to fill the bonding curve
export const AVG_SLOT_MS = 400;

export const DEFAULTS = {
  // Solana's own public RPC answers HTTP 403 to browser extensions; publicnode accepts them.
  rpcUrl: 'https://solana-rpc.publicnode.com',
  slotWindow: 3, // slots after creation that count as "launch window"
  earlyWindowSec: 60, // seconds after creation for the "early buyer" set
  maxWalletProfiles: 40,
  maxOperatorWallets: 12,
  maxPriorLaunches: 8,
  jitoLookup: true,
  operatorHistory: true,
  liveTracking: true,
  cacheTtlMs: 2 * 60 * 1000,
  launchCacheTtlMs: 24 * 60 * 60 * 1000,
};

export const SOURCES = {
  dexscreener: 'https://api.dexscreener.com',
  gecko: 'https://api.geckoterminal.com/api/v2',
  jito: 'https://bundles.jito.wtf/api/v1',
  // pump.fun's own public read API: every coin a wallet has ever created, with ATH mcap and graduation.
  // Read-only, no key. GLASS sends nothing but the wallet address.
  pumpfun: 'https://frontend-api-v3.pump.fun',
};
