// Read-only route evidence. Registry names identify programs or fee recipients, never an operator.
import known from '../data/known.js';
import { PROGRAMS, ROUTER_LABELS, JITO_TIP_ACCOUNTS } from './constants.js';

export function programLabel(address) {
  return Object.hasOwn(ROUTER_LABELS, address) ? ROUTER_LABELS[address]
    : Object.hasOwn(known.programs, address) ? known.programs[address] : null;
}

export function botFee(address) {
  return Object.hasOwn(known.botFees, address) ? known.botFees[address] : null;
}

const positiveInteger = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0;
};

// Match RPC instructions to complete runtime invocation frames. A successful outer transaction can
// catch a failed CPI; neither that frame nor its rolled-back children may produce route evidence.
// Missing/truncated/mismatched logs deliberately produce no new attribution for that invocation.
function executedFrames(tx) {
  const stack = [], roots = [];
  for (const line of tx.meta.logMessages || []) {
    let match = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (match) {
      if (Number(match[2]) !== stack.length + 1) return [];
      const parent = stack.at(-1) || null;
      const frame = { program: match[1], parent, children: [], ok: false };
      (parent ? parent.children : roots).push(frame);
      stack.push(frame);
    } else if ((match = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line))) {
      const frame = stack.pop();
      if (!frame || frame.program !== match[1]) return [];
      frame.ok = match[2] === 'success';
    }
  }
  const all = [];
  let rootIndex = 0;
  const top = tx.transaction.message.instructions || [];
  for (let outerIndex = 0; outerIndex < top.length; outerIndex++) {
    const ix = top[outerIndex];
    const root = roots[rootIndex];
    // Some RPC/runtime versions omit native Compute Budget logs; others include them.
    if (ix.programId === PROGRAMS.COMPUTE_BUDGET && root?.program !== ix.programId) continue;
    if (!root || root.program !== ix.programId) return [];
    rootIndex++;
    const frames = [];
    const walk = (f, depth = 1) => { f.depth = depth; frames.push(f); f.children.forEach((c) => walk(c, depth + 1)); };
    walk(root);
    const instructions = [ix, ...((tx.meta.innerInstructions || []).find((g) => g.index === outerIndex)?.instructions || [])];
    if (frames.length !== instructions.length || frames.some((f, i) => f.program !== instructions[i].programId ||
      (instructions[i].stackHeight != null && instructions[i].stackHeight !== f.depth))) continue;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      frame.ix = instructions[i]; frame.outerIndex = outerIndex; frame.instructionIndex = i;
      let valid = true;
      for (let f = frame; f; f = f.parent) if (!f.ok) valid = false;
      if (valid) all.push(frame);
    }
  }
  return rootIndex === roots.length ? all : [];
}

function inside(frame, ancestor) {
  for (let f = frame; f; f = f.parent) if (f === ancestor) return true;
  return false;
}

/** Evidence is scoped to a wallet's token transfer in the same successful invocation tree.
 * Standalone SOL transfers, account presence, unknown fees and Jito tips never establish bot use.
 * Token fees are not supported by this native-SOL registry. Missing evidence means unknown.
 */
export function routeEvidence(tx) {
  if (!tx?.transaction?.message || !tx.meta || tx.meta.err) return [];
  const frames = executedFrames(tx);
  const keys = (tx.transaction.message.accountKeys || []).map((k) => typeof k === 'string' ? k : k.pubkey);
  const accounts = new Map(), conflicts = new Set();
  const account = (address, mint, owner) => {
    if (!address || !mint || !owner || conflicts.has(address)) return;
    const prev = accounts.get(address);
    if (prev && (prev.mint !== mint || prev.owner !== owner)) { accounts.delete(address); conflicts.add(address); }
    else accounts.set(address, { mint, owner });
  };
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) account(keys[b.accountIndex], b.mint, b.owner);
  const tokenFrame = (f) => [PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022].includes(f.program);
  for (const f of frames.filter(tokenFrame)) {
    const p = f.ix.parsed;
    if (/^initializeAccount[23]?$/.test(p?.type || '')) account(p.info?.account, p.info?.mint, p.info?.owner);
  }
  const moves = [];
  for (const f of frames.filter(tokenFrame)) {
    const p = f.ix.parsed, info = p?.info;
    if (!['transfer', 'transferChecked'].includes(p?.type) || !positiveInteger(info?.tokenAmount?.amount ?? info?.amount)) continue;
    const from = accounts.get(info.source), to = accounts.get(info.destination);
    const mint = info.mint || from?.mint || to?.mint;
    if (!mint || (from && from.mint !== mint) || (to && to.mint !== mint) || (from && to && from.owner === to.owner)) continue;
    for (const a of [from, to]) if (a) moves.push({ frame: f, wallet: a.owner, mint });
  }
  const result = new Map();
  const add = (f, move, kind, address, label, extra = {}) => {
    const value = { kind, address, label, wallet: move.wallet, mint: move.mint, outerIndex: f.outerIndex,
      instructionIndex: f.instructionIndex, signature: tx.transaction.signatures?.[0] || null, ...extra };
    result.set([kind, address, move.wallet, move.mint, f.outerIndex, f.instructionIndex].join('|'), value);
  };
  for (const f of frames) {
    const label = programLabel(f.program);
    if (label) for (const m of moves) if (inside(m.frame, f)) add(f, m, 'program', f.program, label);
    const info = f.ix.parsed?.info, fee = botFee(info?.destination);
    if (f.program !== PROGRAMS.SYSTEM || !['transfer', 'transferWithSeed'].includes(f.ix.parsed?.type) ||
      !fee || fee.role !== 'native-sol-fee-recipient' || JITO_TIP_ACCOUNTS.has(info.destination) ||
      !positiveInteger(info.lamports) || info.source === info.destination || !f.parent) continue;
    for (const m of moves) if (m.wallet === info.source && inside(m.frame, f.parent)) {
      add(f, m, 'fee', info.destination, fee.label, { lamports: Number(info.lamports), source: fee.source, verifiedAt: fee.verifiedAt });
    }
  }
  return [...result.values()];
}

export function routesForTrade(record, mint, wallet, outerIndex) {
  return (record.routeEvidence || []).filter((e) => e.mint === mint && e.wallet === wallet &&
    (outerIndex == null || e.outerIndex === outerIndex));
}
