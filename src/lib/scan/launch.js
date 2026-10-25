// Stage 1: find the creation transaction, then collect every transaction that touched the mint
// in the launch window (creation slot + N) and the early window (first N seconds).
import { PROGRAMS, AVG_SLOT_MS, LAMPORTS_PER_SOL } from '../constants.js';
import { findProgramAddress, isOnCurve } from '../pda.js';
import { decodeBase58 } from '../base58.js';
import { parseTx, txInitialisesMint } from '../txparse.js';

export async function derivePumpAccounts(mint) {
  const mintBytes = decodeBase58(mint);
  const [bondingCurve, metadata] = await Promise.all([
    findProgramAddress(['bonding-curve', mintBytes], PROGRAMS.PUMP),
    findProgramAddress(['metadata', decodeBase58(PROGRAMS.METADATA), mintBytes], PROGRAMS.METADATA),
  ]);
  return { bondingCurve: bondingCurve.address, metadata: metadata.address };
}

/**
 * Locate the creation tx. Returns { record, raw, method, bondingCurve, metadata, curveSigs? }.
 * curveSigs: oldest-first signature infos for the bonding curve when we had to page them (reused later).
 */
export async function findCreation(rpc, mint, { pairCreatedAtMs, log = () => {} } = {}) {
  const { bondingCurve, metadata } = await derivePumpAccounts(mint);
  const notes = [];

  // 1) Metaplex metadata PDA: touched at creation and almost never again.
  try {
    const sigs = await rpc.getSignaturesForAddress(metadata, { limit: 1000 });
    if (sigs?.length) {
      const oldest = sigs[sigs.length - 1];
      const raw = await rpc.getTransaction(oldest.signature);
      if (raw && txInitialisesMint(raw, mint)) {
        log('creation via metadata PDA');
        return { record: parseTx(raw, oldest.signature), raw, method: 'metadata', bondingCurve, metadata, notes };
      }
      notes.push('metadata PDA oldest tx did not initialise the mint');
    }
  } catch (e) {
    notes.push(`metadata lookup failed: ${e.message}`);
  }

  // 2) Bonding curve signatures (end at graduation, so bounded even for huge tokens).
  let curveSigs = null;
  try {
    const paged = await rpc.pageSignatures(bondingCurve, { maxPages: 25 });
    curveSigs = paged.sigs;
    const floor = typeof rpc.historyStart === 'function' ? await rpc.historyStart() : 0;
    if (floor > 0 && paged.sigs[0] && paged.sigs[0].slot <= floor) {
      paged.exhausted = false;
      notes.push('RPC history starts after this token launched');
    }
    if (paged.exhausted && paged.sigs.length) {
      for (const s of paged.sigs.slice(0, 5)) {
        const raw = await rpc.getTransaction(s.signature);
        if (raw && txInitialisesMint(raw, mint)) {
          log('creation via bonding-curve signatures');
          return { record: parseTx(raw, s.signature), raw, method: 'curve-sigs', bondingCurve, metadata, curveSigs, notes };
        }
      }
      notes.push('oldest curve txs did not initialise the mint');
    } else if (!paged.exhausted) {
      notes.push(`bonding curve has >${paged.sigs.length} txs; signature paging capped`);
    }
  } catch (e) {
    notes.push(`curve signature paging failed: ${e.message}`);
  }

  // 3) Generic (any launchpad: Raydium LaunchLab, Meteora DBC, Bonk, plain SPL): find the FIRST block that
  //    contains the mint. Seed from the earliest pool's creation time, walk back in coarse steps until the
  //    mint is absent, then scan forward to the first hit. ~60–120 getBlock calls, ≈10–60 s.
  if (pairCreatedAtMs) {
    try {
      const seedSlot = await rpc.slotForTimeMs(pairCreatedAtMs + 60_000);
      const touches = async (slot) => {
        const b = await rpc.getBlockAccounts(slot);
        if (!b) return null; // skipped slot
        return (b.transactions || []).some((t) => !t.meta?.err && t.transaction?.accountKeys?.some((k) => k.pubkey === mint));
      };
      // coarse: step back until TWO consecutive probe windows have no trace of the mint (a single quiet
      // window can just be a lull in trading). The mint must exist before its first pool, so walking past
      // the earliest pool time is expected.
      let hi = seedSlot;
      let steps = 0;
      let emptyRun = 0;
      const STEP = 300;
      while (steps++ < 80) {
        const lo = hi - STEP;
        let any = false;
        for (let x = lo; x < lo + 6; x++) {
          const r = await touches(x);
          if (r) {
            any = true;
            break;
          }
        }
        if (any) emptyRun = 0;
        else if (++emptyRun >= 2) {
          hi = lo + STEP; // back up to the last window that still had activity
          break;
        }
        hi = lo;
      }
      // fine: first block in [hi-STEP, hi+STEP] that contains the mint
      let first = null;
      for (let x = hi - STEP; x <= hi + STEP && !first; x++) {
        const b = await rpc.getBlockAccounts(x);
        if (!b) continue;
        const hit = (b.transactions || []).find((t) => !t.meta?.err && t.transaction?.accountKeys?.some((k) => k.pubkey === mint));
        if (hit) first = { slot: x, sig: hit.transaction.signatures[0] };
      }
      if (first) {
        const raw = await rpc.getTransaction(first.sig);
        if (raw) {
          const rec = parseTx(raw, first.sig);
          const init = txInitialisesMint(raw, mint);
          log(`creation via generic block scan (${init ? 'initializeMint found' : 'first on-chain appearance'}), launchpad ${rec.entryProgram}`);
          return { record: rec, raw, method: init ? 'block-scan' : 'first-seen', bondingCurve, metadata, curveSigs, notes, generic: true, launchProgram: rec.entryProgram };
        }
      }
      notes.push('generic block scan found no block containing the mint');
    } catch (e) {
      notes.push(`block scan failed: ${e.message}`);
    }
  }
  return { record: null, raw: null, method: null, bondingCurve, metadata, curveSigs, notes };
}

/**
 * Collect launch-window and early-window transactions for the mint.
 * Returns { records: parsed[], launchSigs, earlySigs, partialEarly, blocksRead }
 */
export async function collectLaunchTxs(rpc, mint, creation, { slotWindow = 3, earlyWindowSec = 60, maxEarlyTxs = 80, log = () => {}, onLaunchWindow } = {}) {
  const S0 = creation.record.slot;
  const T0 = creation.record.blockTime;
  const seen = new Set([creation.record.sig]);
  const order = new Map(); // sig → {slot, index}
  order.set(creation.record.sig, { slot: S0, index: -1 });
  const launchSigs = [];
  let blocksRead = 0;

  // Launch window via block scan (exact, ordered, includes non-pump-direct routes).
  for (let s = S0; s <= S0 + slotWindow; s++) {
    let block = null;
    try {
      block = await rpc.getBlockAccounts(s);
    } catch (e) {
      log(`block ${s} unavailable: ${e.message}`);
    }
    if (!block) continue;
    blocksRead++;
    (block.transactions || []).forEach((t, idx) => {
      if (t.meta?.err) return;
      const keys = t.transaction?.accountKeys || [];
      if (!keys.some((k) => k.pubkey === mint)) return;
      const sig = t.transaction.signatures[0];
      if (!order.has(sig)) order.set(sig, { slot: s, index: idx });
      if (!seen.has(sig)) {
        seen.add(sig);
        launchSigs.push(sig);
      }
    });
  }

  // Parse the launch window first so callers can show it while the early window loads.
  const records = [creation.record];
  const attachOrder = (r) => {
    const o = order.get(r.sig);
    r.order = o ? o.slot * 1_000_000 + Math.max(0, o.index) : r.slot * 1_000_000 + 999999;
  };
  attachOrder(creation.record);
  if (launchSigs.length) {
    const raws = await rpc.getTransactions(launchSigs);
    raws.forEach((raw, i) => {
      if (!raw || raw.error) return;
      const rec = parseTx(raw, launchSigs[i]);
      if (rec) {
        attachOrder(rec);
        records.push(rec);
      }
    });
    records.sort((a, b) => a.order - b.order);
  }
  onLaunchWindow?.(records.slice());

  // Early window. pump.fun: bonding-curve signatures (cheap for new coins; capped for huge ones).
  // Other launchpads (no bonding curve): scan the blocks for the first `earlyWindowSec` seconds directly.
  let curveSigs = creation.curveSigs;
  let partialEarly = false;
  if (creation.generic) {
    curveSigs = [];
    const slotMs = typeof rpc.slotTimeMs === 'function' ? await rpc.slotTimeMs() : AVG_SLOT_MS;
    const span = Math.min(90, Math.ceil((earlyWindowSec * 1000) / slotMs)); // ≤90 blocks ≈ 20 s on 2026 mainnet
    let count = 0;
    for (let s = S0 + slotWindow + 1; s <= S0 + span; s++) {
      let block = null;
      try {
        block = await rpc.getBlockAccounts(s);
      } catch {
        block = null;
      }
      if (!block) continue;
      blocksRead++;
      (block.transactions || []).forEach((t, idx) => {
        if (t.meta?.err) return;
        if (!t.transaction?.accountKeys?.some((k) => k.pubkey === mint)) return;
        curveSigs.push({ signature: t.transaction.signatures[0], slot: s, blockTime: block.blockTime, err: null, _idx: idx });
        count++;
      });
      if (count >= maxEarlyTxs) {
        partialEarly = true;
        break;
      }
    }
  } else if (!curveSigs) {
    const paged = await rpc.pageSignatures(creation.bondingCurve, {
      maxPages: 12,
      stop: (oldestOnPage) => oldestOnPage.blockTime != null && oldestOnPage.blockTime < T0,
    });
    curveSigs = paged.sigs;
    partialEarly = !paged.exhausted && !(paged.sigs[0]?.blockTime <= T0);
  }
  const earlySigs = [];
  for (const s of curveSigs) {
    if (s.err) continue;
    if (s.blockTime != null && s.blockTime > T0 + earlyWindowSec) break;
    if (s.slot < S0) continue;
    if (!seen.has(s.signature)) {
      seen.add(s.signature);
      earlySigs.push(s.signature);
      if (!order.has(s.signature)) order.set(s.signature, { slot: s.slot, index: s._idx ?? 100000 + earlySigs.length });
    }
    if (earlySigs.length >= maxEarlyTxs) {
      partialEarly = true;
      break;
    }
  }

  if (earlySigs.length) {
    const raws = await rpc.getTransactions(earlySigs);
    raws.forEach((raw, i) => {
      if (!raw || raw.error) return;
      const rec = parseTx(raw, earlySigs[i]);
      if (rec) {
        attachOrder(rec);
        records.push(rec);
      }
    });
    records.sort((a, b) => a.order - b.order);
  }
  return { records, launchSigs, earlySigs, partialEarly, blocksRead };
}

/**
 * Turn parsed records into per-wallet launch events for the mint.
 */
export function extractLaunchEvents(records, mint, creation) {
  const S0 = creation.record.slot;
  const T0 = creation.record.blockTime;
  const creator = creation.record.feePayer;
  const curve = creation.bondingCurve;
  const events = [];
  for (const rec of records) {
    if (rec.err) continue;
    const externalFeeRecipients = rec.systemTransfers
      .filter((t) => !t.inner && t.from === rec.feePayer && t.to !== curve && !t.create && t.lamports > 0)
      .map((t) => t.to)
      .filter((to) => !isJitoTip(rec, to));
    const base = {
      sig: rec.sig,
      slot: rec.slot,
      slotOffset: rec.slot - S0,
      secOffset: rec.blockTime != null && T0 != null ? rec.blockTime - T0 : null,
      order: rec.order,
      payer: rec.feePayer,
      inCreateTx: rec.sig === creation.record.sig,
      cuLimit: rec.cuLimit,
      cuPrice: rec.cuPrice,
      jitoTip: rec.jitoTip,
      tipAccount: rec.tipAccount,
      route: rec.entryProgram,
      ixCount: rec.ixCount,
      externalFeeRecipients,
    };

    // Preferred: the program's own TradeEvent log (exact amounts, trader, post-trade price)
    const trades = (rec.pumpEvents || []).filter((e) => e.type === 'trade' && e.mint === mint);
    if (trades.length) {
      for (const t of trades) {
        const pumpIx = rec.pumpIxs.find((p) => p.user === t.user) || rec.pumpIxs[0] || null;
        const quoteMint = pumpIx?.quoteMint || PROGRAMS.WSOL;
        const isUsdQuote = quoteMint === PROGRAMS.USDC || quoteMint === PROGRAMS.USDT;
        const quoteScale = isUsdQuote ? 1e6 : LAMPORTS_PER_SOL;
        const quoteAmount = t.quoteAmountRaw != null ? Number(t.quoteAmountRaw) / quoteScale : t.quoteAmount;
        const tokenAmount = t.tokenAmountRaw != null ? Number(t.tokenAmountRaw) / 1e6 : t.tokenAmount;
        const virtualQuote = t.virtualQuoteReservesRaw != null ? Number(t.virtualQuoteReservesRaw) / quoteScale : t.vSol;
        const virtualTokens = t.virtualTokenReservesRaw != null ? Number(t.virtualTokenReservesRaw) / 1e6 : t.vTok;
        events.push({
          ...base,
          wallet: t.user,
          side: t.isBuy ? 'buy' : 'sell',
          tokens: tokenAmount,
          sol: quoteAmount,
          quoteAmount,
          quoteMint,
          quoteSymbol: quoteMint === PROGRAMS.USDC ? 'USDC' : quoteMint === PROGRAMS.USDT ? 'USDT' : 'SOL',
          priceQuote: virtualTokens > 0 ? virtualQuote / virtualTokens : null,
          isCreator: t.user === creator,
          slippageLimitSol: pumpIx?.solLimit ?? (pumpIx?.solIn ? pumpIx.solIn : null),
          pumpIxName: pumpIx?.name || null,
          fromEvent: true,
        });
      }
      continue;
    }

    // Fallback: token balance deltas + SOL into/out of the curve (PumpSwap/Raydium routes, odd txs).
    // Off-curve owners (pools, vaults, PDAs — e.g. the PumpSwap pool receiving the migration) are not buyers.
    const curveDelta = creation.generic ? 0 : (rec.solDelta[curve] || 0) / LAMPORTS_PER_SOL;
    const deltas = rec.tokenDeltas.filter((d) => d.mint === mint && d.owner !== curve && Math.abs(d.delta) > 0 && isWallet(d.owner));
    if (!deltas.length) continue;
    const buys = deltas.filter((d) => d.delta > 0);
    const totalBuyTokens = buys.reduce((s, d) => s + d.delta, 0) || 1;
    for (const d of deltas) {
      const isBuy = d.delta > 0;
      // SOL paid: pump.fun → share of the curve's SOL delta; other launchpads → the wallet's own SOL change
      // (minus fees is close enough; WSOL-wrapped routes show up as the wallet's lamport delta too).
      const ownDelta = Math.abs((rec.solDelta[d.owner] || 0) / LAMPORTS_PER_SOL);
      const solShare = isBuy && curveDelta > 0 ? (curveDelta * d.delta) / totalBuyTokens : curveDelta < 0 && !isBuy ? -curveDelta : ownDelta;
      const pumpIx = rec.pumpIxs.find((p) => p.user === d.owner) || rec.pumpIxs[0] || null;
      events.push({
        ...base,
        wallet: d.owner,
        side: isBuy ? 'buy' : 'sell',
        tokens: Math.abs(d.delta),
        sol: solShare,
        priceQuote: null,
        isCreator: d.owner === creator,
        slippageLimitSol: pumpIx?.solLimit ?? null,
        pumpIxName: pumpIx?.name || null,
        fromEvent: false,
      });
    }
  }
  return events;
}

function isJitoTip(rec, to) {
  return rec.tipAccount === to;
}

const walletCache = new Map();
function isWallet(address) {
  let v = walletCache.get(address);
  if (v === undefined) {
    try {
      v = isOnCurve(decodeBase58(address));
    } catch {
      v = false;
    }
    walletCache.set(address, v);
  }
  return v;
}
