// Read-only launch history. Pinned account orders/discriminators: docs/creator-history.md.
// Decode initialization transactions: a pool's CURRENT creator can be transferred.
import { decodeBase58, isBase58Address, isBase58Signature } from '../base58.js';

export const LAUNCHPAD_PROGRAMS = Object.freeze({
  launchlab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  meteora: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
});
export const BONK_PLATFORM = '8pCtbn9iatQ8493mDQax4xfEUjhoVBpUWYVQoRU18333';
export const RAYDIUM_PLATFORM = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
const RAY_INIT = new Map([
  ['175,175,109,31,13,152,155,237', { name: 'initialize', accounts: 18 }],
  ['67,153,175,39,218,16,38,32', { name: 'initialize_v2', accounts: 18 }],
  ['37,190,126,222,44,154,171,17', { name: 'initialize_with_token2022', accounts: 15 }],
]);
const DBC_INIT = new Map([
  ['140,85,215,176,102,54,104,79', { name: 'initialize_virtual_pool_with_spl_token', accounts: 16 }],
  ['169,118,51,78,145,110,220,155', { name: 'initialize_virtual_pool_with_token2022', accounts: 14 }],
  ['182,13,233,177,42,145,135,2', { name: 'initialize_virtual_pool_with_token2022_transfer_hook', accounts: 15 }],
]);
const FAMILIES = ['bonk', 'raydium-launchlab', 'meteora-dbc'];
const cache = new WeakMap();

function metadata(data, offset) {
  const values = [];
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > data.length) throw new Error('truncated string length');
    const n = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    if (n > 4096 || offset + n > data.length) throw new Error('truncated metadata');
    values.push(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, offset + n)));
    offset += n;
  }
  return { name: values[0] || null, symbol: values[1] || null };
}

// A successful outer transaction can catch a failed CPI. Require that particular
// invocation's success log before attributing an inner initialization.
function invocationResults(logs) {
  const queues = new Map(), stack = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    if (typeof line !== 'string') continue;
    const start = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (start) {
      const call = { program: start[1], depth: Number(start[2]), success: false, parent: stack.at(-1) };
      stack.push(call);
      if (!queues.has(call.program)) queues.set(call.program, []);
      queues.get(call.program).push(call);
      continue;
    }
    const end = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (end && stack.at(-1)?.program === end[1]) stack.pop().success = end[2] === 'success';
  }
  return queues;
}

function committedInvocation(call) {
  while (call?.success) {
    if (call.depth === 1) return true;
    if (call.parent?.depth !== call.depth - 1) return false;
    call = call.parent;
  }
  return false;
}

/** Successful RPC jsonParsed OR raw JSON transactions, including CPI and v0 lookup keys.
 * Attribution is the protocol's initialization creator field; LaunchLab does NOT require
 * that creator to sign, so this is an on-chain designation, not proof of wallet consent.
 */
export function launchesFromTransaction(tx, creator) {
  if (!tx?.meta || tx.meta.err !== null || !isBase58Address(creator)) return [];
  const msg = tx.transaction?.message;
  if (!msg || !Array.isArray(msg.accountKeys) || !Array.isArray(msg.instructions)) return [];
  const keys = msg.accountKeys.map((k) => typeof k === 'string' ? k : k?.pubkey);
  // jsonParsed already expands lookup-table addresses; raw JSON does not.
  if (msg.accountKeys.every((k) => typeof k === 'string')) {
    for (const values of [tx.meta.loadedAddresses?.writable, tx.meta.loadedAddresses?.readonly]) if (Array.isArray(values)) keys.push(...values);
  }
  const groups = Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
  const instructions = msg.instructions.flatMap((ix, index) => [
    { ix, inner: false },
    ...groups.filter((g) => g?.index === index).flatMap((g) => Array.isArray(g.instructions) ? g.instructions.map((child) => ({ ix: child, inner: true })) : []),
  ]);
  const invocations = invocationResults(tx.meta.logMessages);
  const found = new Map();
  for (const { ix, inner } of instructions) {
    if (!ix || typeof ix !== 'object') continue;
    const program = ix.programId ?? keys[ix.programIdIndex];
    const ray = program === LAUNCHPAD_PROGRAMS.launchlab;
    if (!ray && program !== LAUNCHPAD_PROGRAMS.meteora) continue;
    const invocation = invocations.get(program)?.shift();
    if (inner && (!committedInvocation(invocation) || (ix.stackHeight != null && invocation.depth !== ix.stackHeight))) continue;
    try {
      const data = decodeBase58(ix.data);
      const schema = (ray ? RAY_INIT : DBC_INIT).get(Array.from(data.subarray(0, 8)).join(','));
      if (!schema || !Array.isArray(ix.accounts) || ix.accounts.length < schema.accounts) continue;
      const accounts = ix.accounts.map((a) => typeof a === 'number' ? keys[a] : a);
      const originalCreator = accounts[ray ? 1 : 2];
      const mint = accounts[ray ? 6 : 3], pool = accounts[5], config = accounts[ray ? 2 : 0];
      const quoteMint = accounts[ray ? 7 : 4], platform = ray ? accounts[3] : null;
      if (originalCreator !== creator || ![mint, pool, config, quoteMint, ...(ray ? [platform] : [])].every(isBase58Address)) continue;
      const family = ray ? platform === BONK_PLATFORM ? 'bonk' : 'raydium-launchlab' : 'meteora-dbc';
      const identity = metadata(data, ray ? 9 : 8);
      found.set(mint, {
        mint, ...identity, creator, pool, config, quoteMint, platform,
        platformName: ray ? platform === BONK_PLATFORM ? 'Bonk' : platform === RAYDIUM_PLATFORM ? 'Raydium' : null : null,
        source: family, program, instruction: schema.name,
        attribution: 'initialization creator account',
        signature: tx.transaction?.signatures?.[0] || null,
        createdAt: Number.isSafeInteger(tx.blockTime) && tx.blockTime > 0 && Number.isSafeInteger(tx.blockTime * 1000) ? tx.blockTime * 1000 : null,
        createdSlot: Number.isSafeInteger(tx.slot) && tx.slot >= 0 ? tx.slot : null,
        athMcapUsd: null, athAt: null, minutesToPeak: null, nowMcapUsd: null,
        graduated: null, lastTradeAt: null, replies: null,
        url: `https://solscan.io/token/${mint}`,
      });
    } catch { /* Malformed / unsupported instruction: never infer creator from payer or fees. */ }
  }
  return [...found.values()];
}

function result(coins, details) {
  return {
    coins,
    coverage: Object.fromEntries(FAMILIES.map((family) => [family, {
      status: details.pages > 0 ? 'partial' : 'unavailable', exact: false,
      observed: coins.filter((c) => c.source === family).length,
      ...details,
      scope: family === 'meteora-dbc' ? 'Meteora DBC initialization transactions (including transfer-hook)' : family === 'bonk' ? 'Pinned Bonk LaunchLab platform' : 'LaunchLab initialization transactions excluding identified Bonk platform',
    }])),
  };
}

/** Bounded, resumable RPC history; a short page is NEVER proof of lifetime completeness.
 * Transport is the existing RpcClient (getSignaturesForAddress + getTransaction).
 * Cache is scoped to the actual client, wallet, page bounds and cursor, for 90 seconds.
 */
export async function fetchLaunchpadHistory(rpc, creator, { pageSize = 50, maxPages = 2, before } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new RangeError('history bounds: pageSize 1–100, maxPages 1–10');
  if (before !== undefined && !isBase58Signature(before)) throw new TypeError('invalid history cursor');
  const initial = { pages: 0, signatures: 0, transactions: 0, missingTransactions: 0, failedTransactions: 0, nextBefore: before || null, endpointExhausted: false, reason: 'RPC history can be pruned; only supported initializations in the inspected window are included.' };
  if (!isBase58Address(creator) || !rpc?.getSignaturesForAddress || !rpc?.getTransaction) return result([], { ...initial, reason: 'Valid creator and read-only RPC client required.' });
  let memo = cache.get(rpc);
  if (!memo) cache.set(rpc, memo = new Map());
  const key = JSON.stringify([creator, pageSize, maxPages, before]);
  const hit = memo.get(key);
  if (hit?.exp > Date.now()) return hit.value;
  const value = (async () => {
    const details = { ...initial }, coins = new Map(), seen = new Set();
    let cursor = before;
    try {
      for (let page = 0; page < maxPages; page++) {
        const sigs = await rpc.getSignaturesForAddress(creator, { limit: pageSize, ...(cursor ? { before: cursor } : {}) });
        if (!Array.isArray(sigs) || sigs.length > pageSize || sigs.some((s) => !isBase58Signature(s?.signature))) throw new Error('Malformed signature page');
        details.pages++;
        const fresh = sigs.filter((s) => !seen.has(s.signature));
        for (const s of fresh) seen.add(s.signature);
        details.signatures += fresh.length;
        // Four requests at a time; bounded even on clients without batch/pacing support.
        for (let i = 0; i < fresh.length; i += 4) {
          await Promise.all(fresh.slice(i, i + 4).map(async (s) => {
            if (s.err != null) { details.failedTransactions++; return; }
            try {
              const tx = await rpc.getTransaction(s.signature);
              if (!tx?.meta || tx.transaction?.signatures?.[0] !== s.signature) { details.missingTransactions++; return; }
              details.transactions++;
              if (tx.meta.err !== null) { details.failedTransactions++; return; }
              for (const c of launchesFromTransaction(tx, creator)) if (!coins.has(c.mint)) coins.set(c.mint, c);
            } catch { details.missingTransactions++; }
          }));
        }
        if (sigs.length < pageSize) { details.endpointExhausted = true; details.nextBefore = null; break; }
        const next = sigs.at(-1).signature;
        details.nextBefore = next;
        if (next === cursor || !fresh.length) throw new Error('RPC pagination did not advance');
        cursor = next;
      }
    } catch (e) { details.reason += ` Request stopped: ${e.message}`; }
    const sorted = [...coins.values()].sort((a, b) => (b.createdSlot ?? -1) - (a.createdSlot ?? -1) || a.mint.localeCompare(b.mint));
    return result(sorted, details);
  })();
  memo.set(key, { value, exp: Date.now() + 90_000 });
  const out = await value;
  if (!out.coverage.bonk.pages || out.coverage.bonk.missingTransactions || /Request stopped:/.test(out.coverage.bonk.reason)) memo.delete(key);
  return out;
}
