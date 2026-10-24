// Observed, single-transaction funding provenance. No wallet identity or intent inference.
import { PROGRAMS } from './constants.js';

const integer = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const token = (pid) => pid === PROGRAMS.TOKEN || pid === PROGRAMS.TOKEN_2022;

// Successful children of a caught failed CPI are rolled back too. Inner evidence requires a complete
// instruction/log alignment; successful top-level instructions remain usable without runtime logs.
function execution(tx) {
  const roots = [], stack = [];
  let malformed = false;
  for (const line of tx.meta.logMessages || []) {
    let m = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (m) {
      if (+m[2] !== stack.length + 1) { malformed = true; break; }
      const parent = stack.at(-1) || null;
      const f = { program: m[1], parent, children: [], ok: false, depth: +m[2] };
      (parent ? parent.children : roots).push(f); stack.push(f);
    } else if ((m = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line))) {
      const f = stack.pop();
      if (!f || f.program !== m[1]) { malformed = true; break; }
      f.ok = m[2] === 'success';
    }
  }
  if (stack.length) malformed = true;
  const top = tx.transaction.message.instructions || [], matched = new Map();
  let index = 0;
  if (!malformed) for (let outer = 0; outer < top.length; outer++) {
    const ix = top[outer], root = roots[index];
    if (ix.programId === PROGRAMS.COMPUTE_BUDGET && root?.program !== ix.programId) continue;
    if (!root || root.program !== ix.programId) { malformed = true; break; }
    index++;
    const frames = [];
    const walk = (f) => { frames.push(f); f.children.forEach(walk); };
    walk(root);
    const ixs = [ix, ...((tx.meta.innerInstructions || []).find(g => g.index === outer)?.instructions || [])];
    if (frames.length !== ixs.length || frames.some((f, i) => f.program !== ixs[i].programId || (ixs[i].stackHeight != null && f.depth !== ixs[i].stackHeight))) continue;
    const successful = [];
    frames.forEach((f, i) => {
      f.ix = ixs[i]; f.outer = outer;
      let ok = true;
      for (let a = f; a; a = a.parent) if (!a.ok) ok = false;
      if (ok) successful.push(f);
    });
    matched.set(outer, { successful, instructions: ixs });
  }
  if (malformed || index !== roots.length) matched.clear();
  const result = [], verified = new Set(top);
  top.forEach((ix, outer) => {
    const group = matched.get(outer);
    for (const i of group?.instructions || []) verified.add(i);
    result.push(...(group?.successful || [{ ix, program: ix.programId, parent: null, outer, depth: 1 }]));
  });
  return { frames: result, verified };
}

const ancestor = (f, pid) => { for (let a = f; a; a = a.parent) if (a.program === pid) return a; return null; };
const inside = (f, parent) => { for (let a = f; a; a = a.parent) if (a === parent) return true; return false; };

export function fundingProvenance(tx) {
  const empty = { schema: 1, accounts: {}, closes: [], transfers: [], tokenTransfers: [], preBalances: {}, postBalances: {} };
  if (!tx?.meta || !tx.transaction?.message || tx.meta.err !== null) return empty;
  const { frames, verified } = execution(tx), keys = (tx.transaction.message.accountKeys || []).map(k => typeof k === 'string' ? k : k.pubkey);
  const accounts = {}, conflicts = new Set(), preTokens = new Map();
  const add = (address, mint, owner, programId) => {
    if (!address || !mint || !owner || !token(programId) || conflicts.has(address)) return;
    const old = accounts[address];
    if (old && (old.mint !== mint || old.owner !== owner || old.programId !== programId)) { delete accounts[address]; conflicts.add(address); }
    else accounts[address] = { mint, owner, programId };
  };
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) add(keys[b.accountIndex], b.mint, b.owner, b.programId);
  for (const b of tx.meta.preTokenBalances || []) preTokens.set(keys[b.accountIndex], integer(b.uiTokenAmount?.amount));
  for (const f of frames) {
    const p = f.ix.parsed;
    if (token(f.program) && /^initializeAccount[23]?$/.test(p?.type || '')) add(p.info?.account, p.info?.mint, p.info?.owner, f.program);
  }
  const preBalances = {}, postBalances = {};
  keys.forEach((k, i) => { preBalances[k] = integer(tx.meta.preBalances?.[i]); postBalances[k] = integer(tx.meta.postBalances?.[i]); });
  const transfers = [], tokenTransfers = [], closes = [];
  const native = (a) => a?.mint === PROGRAMS.WSOL && a.programId === PROGRAMS.TOKEN;
  for (const f of frames) {
    const p = f.ix.parsed, info = p?.info || {};
    if (f.program === PROGRAMS.SYSTEM && ['transfer', 'transferWithSeed', 'createAccount', 'createAccountWithSeed'].includes(p?.type)) {
      const amount = integer(info.lamports);
      if (amount != null && amount > 0 && info.source && (info.destination || info.newAccount)) transfers.push({ from: info.source, to: info.destination || info.newAccount, lamports: amount, create: !!info.newAccount, frame: f });
    }
    if (token(f.program) && ['transfer', 'transferChecked'].includes(p?.type)) {
      const amount = integer(info.tokenAmount?.amount ?? info.amount), from = accounts[info.source], to = accounts[info.destination];
      const mint = info.mint || from?.mint || to?.mint;
      if (amount == null || amount <= 0 || !mint || conflicts.has(info.source) || conflicts.has(info.destination) ||
        (from && (from.mint !== mint || from.programId !== f.program)) || (to && (to.mint !== mint || to.programId !== f.program))) continue;
      tokenTransfers.push({ fromAcct: info.source, toAcct: info.destination, fromOwner: from?.owner || null, toOwner: to?.owner || null,
        mint, rawAmount: amount, native: f.program === PROGRAMS.TOKEN && mint === PROGRAMS.WSOL, frame: f });
    }
  }
  const repeated = new Set(), seen = new Set();
  for (const f of frames) if (token(f.program) && f.ix.parsed?.type === 'closeAccount') {
    const account = f.ix.parsed.info?.account;
    if (seen.has(account)) repeated.add(account); seen.add(account);
  }
  for (const f of frames) {
    const p = f.ix.parsed, info = p?.info || {};
    if (!token(f.program) || p?.type !== 'closeAccount') continue;
    const a = accounts[info.account], end = frames.indexOf(f), before = frames.slice(0, end);
    const incoming = tokenTransfers.filter(t => t.toAcct === info.account && before.includes(t.frame));
    const deposits = transfers.filter(t => t.to === info.account && before.includes(t.frame));
    const out = tokenTransfers.some(t => t.fromAcct === info.account && before.includes(t.frame)) || transfers.some(t => t.from === info.account && before.includes(t.frame));
    const c = { account: info.account, destination: info.destination, mint: a?.mint || null, accountOwner: a?.owner || null,
      closeAuthority: info.owner || info.multisigOwner || null, native: native(a), components: [], lamports: null, reason: null };
    const start = preBalances[info.account], initial = preTokens.get(info.account);
    const creations = deposits.filter(d => d.create && ancestor(d.frame, PROGRAMS.ATA)?.ix.parsed?.info?.account === info.account);
    const initialized = before.some(b => token(b.program) && /^initializeAccount[23]?$/.test(b.ix.parsed?.type || '') && b.ix.parsed.info?.account === info.account);
    const authorityChanged = before.some(b => token(b.program) && b.ix.parsed?.type === 'setAuthority' && b.ix.parsed.info?.account === info.account);
    const unverifiedTokenMovement = (tx.meta.innerInstructions || []).flatMap(g => g.instructions || []).some(ix => token(ix.programId) &&
      [ix.parsed?.info?.account, ix.parsed?.info?.source, ix.parsed?.info?.destination].includes(info.account) && !verified.has(ix));
    const unsupported = repeated.has(info.account) || out || start == null || postBalances[info.account] !== 0 || !a || a.programId !== f.program ||
      (!preTokens.has(info.account) && !initialized) || authorityChanged || unverifiedTokenMovement || (a?.mint === PROGRAMS.WSOL && f.program !== PROGRAMS.TOKEN);
    if (unsupported) c.reason = 'missing, conflicting or unsupported account lifecycle';
    else if (!c.native) {
      // A non-native token account can only close at zero token balance. Its lamports are rent,
      // but the original depositor is not established by the close authority or transaction payer.
      if (!deposits.length) c.components.push({ kind: 'account-rent', lamports: start, source: null });
      else c.reason = 'non-native account deposits require additional provenance';
    } else {
      if (start === 0 && initialized && creations.length === 1 && deposits.length === 1) {
        c.components.push({ kind: 'account-rent', lamports: creations[0].lamports, source: creations[0].from });
      } else if (initial != null && initial <= start && deposits.length === 0) {
        if (initial) c.components.push({ kind: a.owner === info.destination ? 'self-unwrap' : 'external-wsol', lamports: initial, source: a.owner });
        if (start > initial) c.components.push({ kind: 'account-rent', lamports: start - initial, source: null });
      } else c.reason = 'native principal and rent reserve cannot be separated';
      if (!c.reason) for (const t of incoming) {
        if (!t.native) { c.reason = 'incompatible native transfer'; break; }
        const router = ancestor(t.frame, PROGRAMS.JUPITER_V6);
        const inputs = router ? tokenTransfers.filter(i => !i.native && i.fromOwner && inside(i.frame, router) && i.fromOwner !== i.toOwner) : [];
        const inputOwners = [...new Set(inputs.map(i => i.fromOwner))];
        // A successful router invocation alone does not prove that this recipient supplied input.
        const ownSwap = inputOwners.length === 1 && inputOwners[0] === info.destination;
        c.components.push({ kind: router ? (ownSwap ? 'swap-proceeds' : 'unknown-swap-output') : t.fromOwner === info.destination ? 'self-unwrap' : t.fromOwner ? 'external-wsol' : 'unknown-wsol',
          lamports: t.rawAmount, source: router ? null : t.fromOwner, ...(router ? { router: PROGRAMS.JUPITER_V6, inputOwners,
            inputs: inputs.map(i => ({ owner: i.fromOwner, mint: i.mint, rawAmount: i.rawAmount })) } : {}) });
      }
    }
    if (!c.reason) {
      const total = c.components.reduce((s, part) => s + part.lamports, 0);
      if (Number.isSafeInteger(total)) c.lamports = total;
      else c.reason = 'amount exceeds exact integer range';
    }
    if (c.reason) c.components = [];
    closes.push(c);
  }
  return { schema: 1, accounts, closes, transfers: transfers.map(({ frame, ...t }) => ({ ...t, direct: !frame.parent })),
    tokenTransfers: tokenTransfers.map(({ frame, ...t }) => ({ ...t, direct: !frame.parent })), preBalances, postBalances };
}

export function fundingForWallet(record, wallet) {
  if (!record || record.err) return null;
  const p = record.fundingProvenance;
  if (!p) return null;
  const closes = p.closes.filter(c => c.destination === wallet);
  const direct = p.transfers.filter(t => t.to === wallet && t.from !== wallet && t.direct && !t.create);
  const before = p.preBalances[wallet], after = p.postBalances[wallet];
  const delta = before != null && after != null ? after - before : null;
  if (!closes.length && !direct.length && !(delta > 0)) {
    const transfer = p.tokenTransfers.find(t => t.direct && t.toOwner === wallet && t.fromOwner && t.fromOwner !== wallet);
    if (!transfer) return null;
    return { schema: 1, signature: record.sig, slot: record.slot, blockTime: record.blockTime, feePayer: record.feePayer, feeLamports: record.fee,
      preSolLamports: before, receivedLamports: null, components: [{ kind: 'token-transfer', source: transfer.fromOwner, mint: transfer.mint, rawAmount: transfer.rawAmount }], closes: [], coverage: 'observed-transfer' };
  }
  const inSol = p.transfers.filter(t => t.to === wallet).reduce((s, t) => s + t.lamports, 0);
  const outSol = p.transfers.filter(t => t.from === wallet).reduce((s, t) => s + t.lamports, 0);
  const allCloseAmounts = closes.every(c => c.lamports != null);
  const expected = closes.reduce((s, c) => s + (c.lamports || 0), 0) + inSol - outSol - (record.feePayer === wallet ? record.fee : 0);
  const reconciled = allCloseAmounts && delta != null && Number.isSafeInteger(expected) && expected === delta;
  const components = direct.map(t => ({ kind: 'sol-transfer', source: t.from, lamports: t.lamports }));
  if (reconciled) for (const c of closes) for (const part of c.components) components.push({ ...part, account: c.account, accountOwner: c.accountOwner, closeAuthority: c.closeAuthority });
  return { schema: 1, signature: record.sig, slot: record.slot, blockTime: record.blockTime, feePayer: record.feePayer, feeLamports: record.fee,
    preSolLamports: before, netSolChangeLamports: delta, receivedLamports: reconciled ? closes.reduce((s, c) => s + c.lamports, 0) + inSol : null,
    components, closes: closes.map(c => ({ ...c, components: undefined, lamports: reconciled ? c.lamports : null })),
    coverage: reconciled ? 'reconciled' : 'partial', ...(reconciled ? {} : { note: 'Account movements do not establish a complete SOL breakdown; fee payer is not assumed to be the source.' }) };
}
