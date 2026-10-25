// Normalise a `jsonParsed` Solana transaction into the flat record the scanners work with.
import { decodeBase58, encodeBase58, readU32LE, readU64LE } from './base58.js';
import { PROGRAMS, PUMP_IX, PUMP_BUY_IX, PUMP_SELL_IX, PUMP_CREATE_IX, ANCHOR_EVENT_CPI, PUMP_EVENTS, JITO_TIP_ACCOUNTS, LAMPORTS_PER_SOL } from './constants.js';
import { quoteScale, tradeQuoteAmounts, quoteMintFromIxs } from './quote.js';

const DISC = Object.entries(PUMP_IX).map(([name, bytes]) => [name, bytes.join(',')]);
const EVENT_CPI_KEY = ANCHOR_EVENT_CPI.join(',');
const EVENT_KEYS = Object.fromEntries(Object.entries(PUMP_EVENTS).map(([n, b]) => [b.join(','), n]));

function discName(data) {
  if (!data || data.length < 8) return null;
  const key = Array.from(data.subarray(0, 8)).join(',');
  for (const [name, k] of DISC) if (k === key) return name;
  return null;
}

/**
 * Decode a pump.fun Anchor event CPI (inner self-invoke). Returns null if not an event we know.
 * TradeEvent gives exact quote/token amounts, the trader, and post-trade virtual reserves (= price).
 */
export function decodePumpEvent(ix) {
  const d = safeDecode(ix.data);
  if (!d || d.length < 16) return null;
  if (Array.from(d.subarray(0, 8)).join(',') !== EVENT_CPI_KEY) return null;
  const name = EVENT_KEYS[Array.from(d.subarray(8, 16)).join(',')];
  if (!name) return null;
  let o = 16;
  const pk = () => {
    const s = encodeBase58(d.subarray(o, o + 32));
    o += 32;
    return s;
  };
  const u64 = () => {
    const v = readU64LE(d, o);
    o += 8;
    return v;
  };
  const str = () => {
    const [s, next] = readString(d, o);
    o = next;
    return s;
  };
  try {
    if (name === 'TradeEvent') {
      const mint = pk();
      // Keep raw quote/reserve integers so callers can re-scale for USDC (6 dp) vs SOL (9 dp).
      // Default human fields use SOL scale for backward compatibility with legacy SOL curves.
      const quoteAmountRaw = Number(u64());
      const tokenAmountRaw = Number(u64());
      const quoteAmount = quoteAmountRaw / LAMPORTS_PER_SOL;
      const tokenAmount = tokenAmountRaw / 1e6;
      const isBuy = d[o++] === 1;
      const user = pk();
      const timestamp = Number(u64());
      const virtualQuoteReservesRaw = Number(u64());
      const virtualTokenReservesRaw = Number(u64());
      const realQuoteReservesRaw = Number(u64());
      const realTokenReservesRaw = Number(u64());
      const vSol = virtualQuoteReservesRaw / LAMPORTS_PER_SOL;
      const vTok = virtualTokenReservesRaw / 1e6;
      const rSol = realQuoteReservesRaw / LAMPORTS_PER_SOL;
      const rTok = realTokenReservesRaw / 1e6;
      const feeRecipient = pk();
      o += 8; // fee_basis_points
      const fee = Number(u64()) / LAMPORTS_PER_SOL;
      const creator = pk();
      o += 8; // creator_fee_basis_points
      const creatorFee = Number(u64()) / LAMPORTS_PER_SOL;
      return {
        type: 'trade',
        mint,
        quoteAmount,
        tokenAmount,
        quoteAmountRaw,
        tokenAmountRaw,
        virtualQuoteReservesRaw,
        virtualTokenReservesRaw,
        realQuoteReservesRaw,
        realTokenReservesRaw,
        isBuy,
        user,
        timestamp,
        vSol,
        vTok,
        rSol,
        rTok,
        feeRecipient,
        fee,
        creator,
        creatorFee,
        priceQuote: vTok > 0 ? vSol / vTok : null,
      };
    }
    if (name === 'CreateEvent') {
      const tokenName = str();
      const symbol = str();
      const uri = str();
      const mint = pk();
      const bondingCurve = pk();
      const user = pk();
      const creator = pk();
      const timestamp = Number(u64());
      const vTok = Number(u64()) / 1e6;
      const vSol = Number(u64()) / LAMPORTS_PER_SOL;
      const rTok = Number(u64()) / 1e6;
      const supply = Number(u64()) / 1e6;
      return { type: 'create', tokenName, symbol, uri, mint, bondingCurve, user, creator, timestamp, vTok, vSol, rTok, supply };
    }
    if (name === 'CompleteEvent') {
      const user = pk();
      const mint = pk();
      const bondingCurve = pk();
      const timestamp = Number(u64());
      return { type: 'complete', user, mint, bondingCurve, timestamp };
    }
  } catch {
    return { type: name.toLowerCase().replace('event', ''), partial: true };
  }
  return null;
}

function safeDecode(b58) {
  try {
    return decodeBase58(b58);
  } catch {
    return null;
  }
}

function readString(bytes, off) {
  const len = readU32LE(bytes, off);
  const s = new TextDecoder().decode(bytes.subarray(off + 4, off + 4 + len));
  return [s, off + 4 + len];
}

/**
 * Decode a pump.fun instruction (top-level or inner).
 * Account layouts differ per variant, so `signers` (from the tx) is used to pin the user:
 *   legacy buy/sell/buy_exact_sol_in : [global, fee_recipient, mint, bonding_curve, ...user@6]
 *   *_v2 / *_v3 (quote-asset aware)  : [global, mint, quote_mint, ..., bonding_curve, ..., user]
 *   create / create_v2               : [mint, ...user]
 */
export function decodePumpIx(ix, signers = []) {
  const data = safeDecode(ix.data);
  const name = discName(data);
  if (!name) return null;
  const accounts = ix.accounts || [];
  const out = { name, accounts, kind: PUMP_BUY_IX.has(name) ? 'buy' : PUMP_SELL_IX.has(name) ? 'sell' : PUMP_CREATE_IX.has(name) ? 'create' : name };
  const firstSigner = accounts.find((a) => signers.includes(a)) || null;
  const modern = /_v[23]$/.test(name) || name.includes('exact_quote_in');
  try {
    if (out.kind === 'buy' || out.kind === 'sell') {
      // All variants: [amount u64][limit u64]. "exact_*_in" variants put the quote amount first.
      // Modern v2/v3 layouts expose quote_mint at accounts[2] (WSOL or USDC).
      const quoteMint = modern ? accounts[2] : PROGRAMS.WSOL;
      const qScale = quoteScale(quoteMint);
      const a = Number(readU64LE(data, 8));
      const b = Number(readU64LE(data, 16));
      if (name.includes('exact_sol_in') || name.includes('exact_quote_in')) {
        out.solIn = a / qScale;
        out.minTokensOut = b / 1e6;
      } else {
        out.tokenAmount = a / 1e6;
        out.solLimit = b / qScale; // max quote cost (buy) / min quote output (sell)
      }
      if (modern) {
        out.mint = accounts[1];
        out.quoteMint = quoteMint;
        out.user = firstSigner || accounts[8] || null;
        out.feeRecipient = null; // read from TradeEvent instead
        out.bondingCurve = accounts[5] && accounts[5] !== out.user ? accounts[5] : null;
      } else {
        out.mint = accounts[2];
        out.quoteMint = PROGRAMS.WSOL;
        out.user = accounts[6] || firstSigner;
        out.feeRecipient = accounts[1];
        out.bondingCurve = accounts[3];
      }
    } else if (out.kind === 'create') {
      let off = 8;
      let s;
      [s, off] = readString(data, off);
      out.tokenName = s;
      [s, off] = readString(data, off);
      out.symbol = s;
      [s, off] = readString(data, off);
      out.uri = s;
      out.mint = accounts[0];
      out.user = firstSigner || accounts[7] || accounts[5] || null;
    }
  } catch {
    /* partial decode is fine */
  }
  return out;
}

/**
 * @param tx  result of getTransaction(jsonParsed) (may be null)
 * @returns normalised record or null
 */
export function parseTx(tx, signatureHint) {
  if (!tx || !tx.transaction || !tx.meta) return null;
  const msg = tx.transaction.message;
  const meta = tx.meta;
  const keys = (msg.accountKeys || []).map((k) => (typeof k === 'string' ? { pubkey: k } : k));
  const pubkeys = keys.map((k) => k.pubkey);
  const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
  const feePayer = pubkeys[0];
  const sig = tx.transaction.signatures?.[0] || signatureHint;

  // SOL deltas per account (lamports)
  const solDelta = {};
  const pre = meta.preBalances || [];
  const post = meta.postBalances || [];
  for (let i = 0; i < pubkeys.length; i++) {
    const d = (post[i] ?? 0) - (pre[i] ?? 0);
    if (d !== 0) solDelta[pubkeys[i]] = d;
  }

  // Token deltas keyed by owner+mint, plus token-account → owner/mint map
  const tokenAccountInfo = {};
  const tokenDeltaMap = new Map();
  const preTB = meta.preTokenBalances || [];
  const postTB = meta.postTokenBalances || [];
  const tbKey = (b) => `${b.accountIndex}`;
  const preMap = new Map(preTB.map((b) => [tbKey(b), b]));
  const postMap = new Map(postTB.map((b) => [tbKey(b), b]));
  const idxs = new Set([...preMap.keys(), ...postMap.keys()]);
  for (const idx of idxs) {
    const b = postMap.get(idx) || preMap.get(idx);
    const owner = b.owner;
    const mint = b.mint;
    const acct = pubkeys[b.accountIndex];
    if (acct) tokenAccountInfo[acct] = { owner, mint, programId: b.programId };
    const before = Number(preMap.get(idx)?.uiTokenAmount?.uiAmount || 0);
    const after = Number(postMap.get(idx)?.uiTokenAmount?.uiAmount || 0);
    const d = after - before;
    if (d !== 0) {
      const k = `${owner}|${mint}`;
      tokenDeltaMap.set(k, (tokenDeltaMap.get(k) || 0) + d);
    }
  }
  const tokenDeltas = [...tokenDeltaMap.entries()].map(([k, delta]) => {
    const [owner, mint] = k.split('|');
    return { owner, mint, delta };
  });

  // Walk instructions (top-level + inner)
  const topIxs = msg.instructions || [];
  const innerGroups = meta.innerInstructions || [];
  let cuLimit = null;
  let cuPrice = null;
  const systemTransfers = []; // {from, to, lamports, inner}
  const splTransfers = []; // {fromAcct, toAcct, fromOwner, toOwner, mint, amount, inner}
  const pumpIxs = [];
  const pumpEvents = [];
  const closeAccounts = [];
  const programs = []; // top-level program ids in order
  const ataCreates = [];

  const visit = (ix, inner, depthProgram) => {
    const pid = ix.programId;
    if (pid === PROGRAMS.COMPUTE_BUDGET) {
      const d = safeDecode(ix.data);
      if (d && d.length >= 5 && d[0] === 2) cuLimit = readU32LE(d, 1);
      if (d && d.length >= 9 && d[0] === 3) cuPrice = Number(readU64LE(d, 1));
      return;
    }
    if (ix.parsed && (ix.program === 'system' || pid === PROGRAMS.SYSTEM)) {
      const t = ix.parsed.type;
      const info = ix.parsed.info || {};
      if (t === 'transfer' || t === 'transferWithSeed') {
        systemTransfers.push({ from: info.source, to: info.destination, lamports: Number(info.lamports || 0), inner, via: depthProgram || null });
      } else if (t === 'createAccount' || t === 'createAccountWithSeed') {
        systemTransfers.push({ from: info.source, to: info.newAccount, lamports: Number(info.lamports || 0), inner, via: depthProgram || null, create: true });
      }
      return;
    }
    if (ix.parsed && (ix.program === 'spl-token' || ix.program === 'spl-token-2022')) {
      const t = ix.parsed.type;
      const info = ix.parsed.info || {};
      if (t === 'closeAccount') {
        // Closing a (WSOL) token account sends its lamports to `destination` — a common way to fund a
        // wallet without a system transfer ever touching it.
        closeAccounts.push({ account: info.account, destination: info.destination, owner: info.owner || info.multisigOwner || null, inner, via: depthProgram || null });
        return;
      }
      if (t === 'transfer' || t === 'transferChecked') {
        const amount = info.tokenAmount ? Number(info.tokenAmount.uiAmount || 0) : Number(info.amount || 0) / 1e6;
        const src = tokenAccountInfo[info.source];
        const dst = tokenAccountInfo[info.destination];
        splTransfers.push({
          fromAcct: info.source,
          toAcct: info.destination,
          fromOwner: src?.owner || info.authority || null,
          toOwner: dst?.owner || null,
          mint: info.mint || src?.mint || dst?.mint || null,
          amount,
          authority: info.authority || info.multisigAuthority || null,
          inner,
          via: depthProgram || null,
        });
      }
      return;
    }
    if (ix.parsed && ix.program === 'spl-associated-token-account') {
      ataCreates.push(ix.parsed.info?.account);
      return;
    }
    if (pid === PROGRAMS.PUMP) {
      const evt = inner ? decodePumpEvent(ix) : null;
      if (evt) {
        pumpEvents.push(evt);
        return;
      }
      const dec = decodePumpIx(ix, signers);
      if (dec) pumpIxs.push({ ...dec, inner, via: depthProgram || null });
      return;
    }
  };

  topIxs.forEach((ix, i) => {
    if (ix.programId !== PROGRAMS.COMPUTE_BUDGET) programs.push(ix.programId);
    visit(ix, false, null);
    const group = innerGroups.find((g) => g.index === i);
    if (group) for (const inner of group.instructions) visit(inner, true, ix.programId);
  });

  // Jito tip = system transfer to a tip account (anywhere) or SOL delta into a tip account
  let jitoTip = 0;
  let tipAccount = null;
  for (const t of systemTransfers) {
    if (JITO_TIP_ACCOUNTS.has(t.to)) {
      jitoTip += t.lamports;
      tipAccount = t.to;
    }
  }
  if (!tipAccount) {
    for (const k of pubkeys) {
      if (JITO_TIP_ACCOUNTS.has(k) && solDelta[k] > 0) {
        jitoTip += solDelta[k];
        tipAccount = k;
      }
    }
  }

  const entryProgram = programs.find((p) => ![PROGRAMS.SYSTEM, PROGRAMS.ATA, PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022].includes(p)) || programs[0] || null;

  return {
    sig,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: meta.err || null,
    fee: meta.fee || 0,
    feePayer,
    signers,
    pubkeys,
    cuLimit,
    cuPrice,
    jitoTip,
    tipAccount,
    programs,
    entryProgram,
    systemTransfers,
    splTransfers,
    pumpIxs,
    pumpEvents,
    closeAccounts,
    ataCreates,
    solDelta,
    tokenDeltas,
    tokenAccountInfo,
    ixCount: topIxs.length,
    version: tx.version,
  };
}

/** True if this tx initialises `mint` (works for pump create / create_v2 and any future variant). */
export function txInitialisesMint(tx, mint) {
  const meta = tx?.meta;
  const groups = meta?.innerInstructions || [];
  const check = (ix) => ix?.parsed && /^initializeMint/.test(ix.parsed.type || '') && ix.parsed.info?.mint === mint;
  for (const ix of tx?.transaction?.message?.instructions || []) if (check(ix)) return true;
  for (const g of groups) for (const ix of g.instructions || []) if (check(ix)) return true;
  // fall back to pump create discriminator / CreateEvent targeting the mint
  for (const ix of tx?.transaction?.message?.instructions || []) {
    if (ix.programId === PROGRAMS.PUMP) {
      const d = decodePumpIx(ix);
      if (d && d.kind === 'create' && d.mint === mint) return true;
    }
  }
  for (const g of groups) for (const ix of g.instructions || []) {
    if (ix.programId === PROGRAMS.PUMP) {
      const e = decodePumpEvent(ix);
      if (e?.type === 'create' && e.mint === mint) return true;
    }
  }
  return false;
}

/**
 * Describe what a parsed tx did to `mint` for a given wallet:
 * returns {side:'buy'|'sell'|'transfer_in'|'transfer_out'|null, tokens, sol}
 */
export function classifyForMint(rec, mint, wallet) {
  const ev = rec.pumpEvents?.find((e) => e.type === 'trade' && e.mint === mint && e.user === wallet);
  if (ev) {
    const quoteMint = quoteMintFromIxs(rec.pumpIxs, wallet);
    const q = tradeQuoteAmounts(ev, quoteMint);
    return {
      side: ev.isBuy ? 'buy' : 'sell',
      tokens: q.tokenAmount,
      sol: q.quoteAmount,
      priceQuote: q.priceQuote,
      quoteMint: q.quoteMint,
      quoteSymbol: q.quoteSymbol,
      fromEvent: true,
    };
  }
  const td = rec.tokenDeltas.find((d) => d.owner === wallet && d.mint === mint);
  if (!td) return { side: null, tokens: 0, sol: 0 };
  const solChange = (rec.solDelta[wallet] || 0) / LAMPORTS_PER_SOL;
  const isSwap = rec.pumpIxs.some((p) => p.kind === 'buy' || p.kind === 'sell') || rec.programs.some((p) => p === PROGRAMS.PUMPSWAP || p === PROGRAMS.JUPITER_V6 || p === PROGRAMS.RAYDIUM_AMM || p === PROGRAMS.RAYDIUM_CPMM || p === PROGRAMS.METEORA_DLMM);
  const plainTransfer = rec.splTransfers.some((t) => t.mint === mint && !t.via && (t.fromOwner === wallet || t.toOwner === wallet));
  if (td.delta > 0) return { side: isSwap && !plainTransfer ? 'buy' : plainTransfer && !isSwap ? 'transfer_in' : 'buy', tokens: td.delta, sol: -solChange };
  return { side: isSwap && !plainTransfer ? 'sell' : plainTransfer && !isSwap ? 'transfer_out' : 'sell', tokens: -td.delta, sol: solChange };
}
