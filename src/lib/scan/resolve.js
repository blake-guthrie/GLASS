// Resolve whatever a terminal puts in its URL (mint, bonding curve, PumpSwap/Raydium pool, DexScreener
// pair) to the token mint.
import { isBase58Address } from '../base58.js';
import { dexPairInfo, dexTokenInfo } from '../market.js';
import { PROGRAMS } from '../constants.js';
import { USDC_MINT } from '../quote.js';

export async function resolveMint(rpc, identifier, { hintIsMint = false } = {}) {
  if (!isBase58Address(identifier)) return { mint: null, error: 'not a Solana address' };
  // The hint only decides lookup ORDER — it is never trusted blindly. Terminals put pool/pair addresses in
  // URLs that look like mint URLs (pump.fun uses the PumpSwap pool for graduated coins).
  // 1) DexScreener: is it a token?
  const t = await dexTokenInfo(identifier);
  if (t.best?.mint === identifier) return { mint: identifier, pair: t.best, via: 'dex-token' };
  // 2) DexScreener: is it a pair/pool/bonding curve?
  const p = await dexPairInfo(identifier);
  if (p?.mint) return { mint: p.mint, pair: p, via: 'dex-pair' };
  // 3) RPC: mint account? (brand-new tokens DexScreener hasn't indexed yet)
  try {
    const info = await rpc.getAccountInfo(identifier);
    const v = info?.value;
    if (v?.data?.parsed?.type === 'mint') return { mint: identifier, pair: null, via: 'rpc-mint' };
    if (!v && hintIsMint) return { mint: null, error: 'address does not exist on-chain' };
    if (v && (v.owner === PROGRAMS.PUMP || v.owner === PROGRAMS.PUMPSWAP || v.owner === PROGRAMS.RAYDIUM_AMM || v.owner === PROGRAMS.RAYDIUM_CPMM || v.owner === PROGRAMS.METEORA_DLMM)) {
      // pool / bonding curve: its token accounts tell us the mint (indexed RPC), else read the mint out of
      // the pool's most recent transaction (works on any RPC)
      const mints = await rpc.getOwnerTokenMints(identifier);
      const nonSol = mints.filter((m) => m.mint !== PROGRAMS.WSOL && m.mint !== USDC_MINT).sort((a, b) => b.amount - a.amount);
      if (nonSol[0]) return { mint: nonSol[0].mint, pair: null, via: 'rpc-pool' };
      const sigs = await rpc.getSignaturesForAddress(identifier, { limit: 5 });
      for (const s of sigs || []) {
        const raw = await rpc.getTransaction(s.signature);
        const tb = raw?.meta?.postTokenBalances || [];
        const m = tb.map((b) => b.mint).find((x) => x && x !== PROGRAMS.WSOL && x !== USDC_MINT);
        if (m) return { mint: m, pair: null, via: 'rpc-pool-tx' };
      }
    }
  } catch (e) {
    return { mint: null, error: `rpc: ${e.message}` };
  }
  return { mint: null, error: 'could not resolve to a token mint' };
}
