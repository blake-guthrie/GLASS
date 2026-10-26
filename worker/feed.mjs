// Official source pin and exact account/quote semantics: worker/README.md.
import { PROGRAMS, PUMP_IX } from '../src/lib/constants.js';
import { decodeBase58, isBase58Address } from '../src/lib/base58.js';
import { findProgramAddress } from '../src/lib/pda.js';
export const mintAuthority = async () => (await findProgramAddress(['mint-authority'], PROGRAMS.PUMP)).address;
// Upgrade this capability only with the corresponding quote-aware engine/schema.
export const supportsQuote = (quote) => quote === PROGRAMS.WSOL;

function successfulCalls(logs) {
  const calls = [], stack = [];
  for (const log of logs || []) {
    const start = /^Program (\w+) invoke \[(\d+)\]$/.exec(log);
    if (start) {
      const call = { program: start[1], depth: Number(start[2]), parent: stack.at(-1), ok: false };
      stack.push(call); if (call.program === PROGRAMS.PUMP) calls.push(call);
    }
    const end = /^Program (\w+) (success|failed:.*)$/.exec(log);
    if (end && stack.at(-1)?.program === end[1]) stack.pop().ok = end[2] === 'success';
  }
  return calls;
}
function committed(call) {
  while (call?.ok) {
    if (call.depth === 1) return true;
    if (call.parent?.depth !== call.depth - 1) return false;
    call = call.parent;
  }
  return false;
}

/** Source transaction must match the requested signature in the caller. */
export function creationMints(tx, authority) {
  if (!tx?.meta || tx.meta.err !== null) return [];
  const message = tx.transaction?.message;
  if (!Array.isArray(message?.accountKeys) || !Array.isArray(message.instructions)) return [];
  const keys = message.accountKeys.map((k) => typeof k === 'string' ? k : k.pubkey);
  if (message.accountKeys.every((k) => typeof k === 'string')) {
    for (const a of [tx.meta.loadedAddresses?.writable, tx.meta.loadedAddresses?.readonly]) if (Array.isArray(a)) keys.push(...a);
  }
  const calls = successfulCalls(Array.isArray(tx.meta.logMessages) ? tx.meta.logMessages : []);
  const groups = Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
  const instructions = message.instructions.flatMap((ix, i) => [{ ix, inner: false }, ...groups.filter((g) => g?.index === i && Array.isArray(g.instructions)).flatMap((g) => g.instructions.map((child) => ({ ix: child, inner: true })))]);
  const found = new Map();
  for (const { ix, inner } of instructions) {
    if ((ix?.programId ?? keys[ix?.programIdIndex]) !== PROGRAMS.PUMP) continue;
    const call = calls.shift();
    if (inner && (!committed(call) || (ix.stackHeight != null && ix.stackHeight !== call.depth))) continue;
    try {
      const data = decodeBase58(ix.data), disc = [...data.subarray(0, 8)].join(',');
      const v2 = disc === PUMP_IX.create_v2.join(',');
      if (!v2 && disc !== PUMP_IX.create.join(',')) continue;
      const accounts = ix.accounts.map((x) => typeof x === 'number' ? keys[x] : x);
      if (accounts.length < (v2 ? 16 : 14) || accounts[1] !== authority || !isBase58Address(accounts[0])) continue;
      if (v2 && accounts.length > 16 && (accounts.length < 19 || !isBase58Address(accounts[16]))) continue;
      const quoteMint = v2 && accounts.length > 16 ? accounts[16] : PROGRAMS.WSOL;
      found.set(accounts[0], { mint: accounts[0], quoteMint,
        supportedQuote: supportsQuote(quoteMint),
        slot: Number.isSafeInteger(tx.slot) ? tx.slot : null,
        blockTime: Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null });
    } catch { /* Unsupported/malformed instruction is not evidence of a created mint. */ }
  }
  return [...found.values()];
}
