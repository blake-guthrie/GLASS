// SYNTHETIC RPC records, not captured launches. Independent literal layouts from
// the pinned official sources linked in docs/creator-history.md. No SDK execution.
import { encodeBase58 } from '../../src/lib/base58.js';
export const key = (n) => encodeBase58(new Uint8Array(32).fill(n));
export const signature = (n) => encodeBase58(new Uint8Array(64).fill(n));
export const RAY = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const BONK = '8pCtbn9iatQ8493mDQax4xfEUjhoVBpUWYVQoRU18333';
export const RAY_PLATFORM = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
const variants = {
  rayLegacy: [[175,175,109,31,13,152,155,237],18],
  ray: [[67,153,175,39,218,16,38,32],18],
  ray2022: [[37,190,126,222,44,154,171,17],15],
  dbc: [[140,85,215,176,102,54,104,79],16],
  dbc2022: [[169,118,51,78,145,110,220,155],14],
  dbcHook: [[182,13,233,177,42,145,135,2],15],
};
export function fixture({ creator = key(9), family = 'bonk', variant = family === 'meteora-dbc' ? 'dbc' : 'ray', id = 1, platform, inner = false, raw = false } = {}) {
  const ray = variant.startsWith('ray');
  const [disc, count] = variants[variant];
  const fields = ['Fixture token', 'FIX', 'https://example.invalid/metadata'];
  const data = [...disc, ...(ray ? [6] : [])];
  for (const text of fields) {
    const bytes = new TextEncoder().encode(text);
    const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, bytes.length, true);
    data.push(...length, ...bytes);
  }
  // Remaining Raydium curve/vesting parameters: synthetic valid-sized payload.
  if (ray) data.push(...new Uint8Array(80));
  const accounts = Array.from({ length: count }, (_, i) => key(i + 50));
  accounts[ray ? 1 : 2] = creator;
  accounts[ray ? 6 : 3] = key(id + 100);
  accounts[5] = key(id + 150);
  if (ray) accounts[3] = platform || (family === 'bonk' ? BONK : RAY_PLATFORM);
  const programId = ray ? RAY : DBC;
  const ix = { programId, accounts, data: encodeBase58(data) };
  const tx = {
    slot: 1000 + id, blockTime: 1700000000 + id,
    transaction: { signatures: [signature(id)], message: { accountKeys: accounts.map((pubkey) => ({ pubkey })), instructions: inner ? [{ programId: key(249), accounts: [], data: '' }] : [ix] } },
    meta: { err: null, innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : [], logMessages: inner ? [`Program ${key(249)} invoke [1]`, `Program ${programId} invoke [2]`, `Program ${programId} success`, `Program ${key(249)} success`] : [`Program ${programId} invoke [1]`, `Program ${programId} success`] },
  };
  if (raw) {
    tx.transaction.message.accountKeys = [programId, ...accounts.slice(0, 3)];
    tx.meta.loadedAddresses = { writable: accounts.slice(3, 10), readonly: accounts.slice(10) };
    delete ix.programId; ix.programIdIndex = 0;
    ix.accounts = accounts.map((_, i) => i + 1);
  }
  return tx;
}
export function rpcFixture(txs, { pages, missing = new Set(), errorPage = -1 } = {}) {
  const calls = [], bySig = new Map(txs.map((tx) => [tx.transaction.signatures[0], tx]));
  const records = txs.map((tx) => ({ signature: tx.transaction.signatures[0], err: tx.meta.err, slot: tx.slot, blockTime: tx.blockTime }));
  let page = 0;
  return {
    calls,
    async getSignaturesForAddress(address, opts) {
      calls.push(['signatures', address, opts]);
      if (page === errorPage) throw new Error('fixture RPC unavailable');
      if (pages) return pages[page++] || [];
      const start = opts.before ? records.findIndex((s) => s.signature === opts.before) + 1 : 0;
      page++; return records.slice(start, start + opts.limit);
    },
    async getTransaction(sig) { calls.push(['transaction', sig]); return missing.has(sig) ? null : bySig.get(sig) || null; },
  };
}
