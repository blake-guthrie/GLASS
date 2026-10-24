// Stage 2: who bought in the launch window, how uniform their transactions were, and whether they
// moved as one (same Jito bundle, same fee recipient, same settings).
import { PUMP_TOTAL_SUPPLY, LAMPORTS_PER_SOL } from '../constants.js';
import { pMap } from '../http.js';
import { programLabel, botFee } from '../routes.js';

const sig2 = (n) => (n == null ? 'na' : Number(n.toPrecision(2)));
const slipBucket = (ev) => (ev.slippageLimitSol && ev.sol > 0 ? Math.round((ev.slippageLimitSol / ev.sol - 1) * 20) / 20 : 'na');

export function routeLabel(programId) {
  if (!programId) return 'unknown';
  return programLabel(programId) || `${programId.slice(0, 4)}…${programId.slice(-4)}`;
}

export function fingerprintOf(ev) {
  return [ev.cuLimit ?? 'na', sig2(ev.cuPrice), ev.jitoTip || 0, ev.route || 'na', ev.ixCount, slipBucket(ev)].join('|');
}

export function analyseLaunch(events, { supply = PUMP_TOTAL_SUPPLY, slotWindow = 3, earlyWindowSec = 60 } = {}) {
  const buysAll = events.filter((e) => e.side === 'buy');
  const creatorEv = buysAll.filter((e) => e.isCreator);
  const devBuyTokens = creatorEv.reduce((s, e) => s + e.tokens, 0);
  const devBuySol = creatorEv.reduce((s, e) => s + e.sol, 0);

  // Per-wallet aggregation over the launch window (slot offsets 0..slotWindow) and early window.
  // Tokens are NET (buys − sells inside the window) so flipped supply isn't counted twice.
  const byWallet = new Map();
  for (const e of events) {
    if (e.isCreator) continue;
    const inSlotWindow = e.slotOffset <= slotWindow;
    const inEarly = e.secOffset != null ? e.secOffset <= earlyWindowSec : inSlotWindow;
    if (!inSlotWindow && !inEarly) continue;
    let b = byWallet.get(e.wallet);
    if (!b) {
      if (e.side !== 'buy') continue; // a sell with no prior buy in-window (airdrop/transfer) is not a launch buy
      b = {
        wallet: e.wallet,
        firstSlotOffset: e.slotOffset,
        firstSecOffset: e.secOffset,
        bought: 0,
        sold: 0,
        tokens: 0,
        sol: 0,
        solOut: 0,
        txs: [],
        payers: new Set(),
        tip: e.jitoTip,
        tipAccount: e.tipAccount,
        cuLimit: e.cuLimit,
        cuPrice: e.cuPrice,
        route: e.route,
        routeLabel: routeLabel(e.route),
        routeEvidence: [],
        feeRecipients: new Set(),
        fingerprint: fingerprintOf(e),
        payer: e.payer,
        firstPriceQuote: e.priceQuote ?? null,
      };
      byWallet.set(e.wallet, b);
    }
    if (e.side === 'buy') {
      b.bought += e.tokens;
      b.sol += e.sol;
    } else {
      b.sold += e.tokens;
      b.solOut += e.sol;
    }
    b.txs.push(e.sig);
    for (const evidence of e.routeEvidence || []) {
      if (!b.routeEvidence.some((x) => x.signature === evidence.signature && x.kind === evidence.kind &&
        x.address === evidence.address && x.outerIndex === evidence.outerIndex && x.instructionIndex === evidence.instructionIndex)) b.routeEvidence.push(evidence);
    }
    if (e.payer && e.payer !== e.wallet) b.payers.add(e.payer);
    for (const r of e.externalFeeRecipients || []) b.feeRecipients.add(r);
    if (e.slotOffset < b.firstSlotOffset) b.firstSlotOffset = e.slotOffset;
  }
  const buyers = [...byWallet.values()].map((b) => ({
    ...b,
    tokens: Math.max(0, b.bought - b.sold),
    flipped: b.sold > 0,
    feeRecipients: [...b.feeRecipients],
    payers: [...b.payers],
    pct: (Math.max(0, b.bought - b.sold) / supply) * 100,
    boughtPct: (b.bought / supply) * 100,
  }));
  buyers.sort((a, b) => a.firstSlotOffset - b.firstSlotOffset || b.tokens - a.tokens);

  const slot0 = buyers.filter((b) => b.firstSlotOffset === 0);
  const windowB = buyers.filter((b) => b.firstSlotOffset <= slotWindow);
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  const flippedCount = windowB.filter((b) => b.flipped).length;

  // Shared transaction payers: one wallet paying fees for several launch buyers = one operator
  const payerMap = new Map();
  for (const b of windowB) for (const pz of b.payers) (payerMap.get(pz) || payerMap.set(pz, []).get(pz)).push(b.wallet);
  const sharedPayers = [...payerMap.entries()].filter(([, ws]) => ws.length >= 2).map(([address, wallets]) => ({ address, wallets })).sort((a, b) => b.wallets.length - a.wallets.length);

  // Fingerprint groups across the slot window
  const groups = new Map();
  for (const b of windowB) {
    const g = groups.get(b.fingerprint) || { key: b.fingerprint, wallets: [], tokens: 0 };
    g.wallets.push(b.wallet);
    g.tokens += b.tokens;
    groups.set(b.fingerprint, g);
  }
  const groupList = [...groups.values()].sort((a, b) => b.wallets.length - a.wallets.length).map((g) => ({ ...g, pct: (g.tokens / supply) * 100, label: describeFingerprint(g.key) }));
  const uniformity = windowB.length ? groupList[0].wallets.length / windowB.length : 0;

  // Jito: tipped share, same tip account, inferred bundles (same slot + adjacent block index + tipped)
  const tipped = windowB.filter((b) => b.tip > 0);
  const tipAccounts = new Map();
  for (const b of tipped) tipAccounts.set(b.tipAccount, (tipAccounts.get(b.tipAccount) || 0) + 1);
  const tipAmounts = new Map();
  for (const b of tipped) tipAmounts.set(b.tip, (tipAmounts.get(b.tip) || 0) + 1);
  const identicalTipShare = tipped.length ? Math.max(...tipAmounts.values()) / tipped.length : 0;
  const inferredBundles = inferBundles(events.filter((e) => e.side === 'buy'));

  // Shared external fee recipients (launch tool / bot fee wallets)
  const feeRec = new Map();
  for (const b of windowB) for (const r of b.feeRecipients) {
    const x = feeRec.get(r) || { address: r, wallets: [], ...(botFee(r) ? { platform: true, label: `${botFee(r).label} fee account` } : {}) };
    x.wallets.push(b.wallet);
    feeRec.set(r, x);
  }
  const sharedFeeRecipients = [...feeRec.values()].filter((x) => x.wallets.length >= 2).sort((a, b) => b.wallets.length - a.wallets.length);

  const analysisCore = { slot0Count: slot0.length, windowCount: windowB.length, uniformity, identicalTipShare, tippedCount: tipped.length, sharedFeeRecipients, inferredBundles, sharedPayers, flippedCount };
  const reasons = toolPatternReasons(analysisCore);

  return {
    supply,
    creatorDevBuy: { tokens: devBuyTokens, sol: devBuySol, pct: (devBuyTokens / supply) * 100, txs: creatorEv.map((e) => e.sig),
      route: creatorEv[0]?.route, routeLabel: routeLabel(creatorEv[0]?.route), routeEvidence: creatorEv.flatMap((e) => e.routeEvidence || []) },
    slot0: { count: slot0.length, tokens: sum(slot0, 'tokens'), sol: sum(slot0, 'sol'), pct: (sum(slot0, 'tokens') / supply) * 100, grossPct: (sum(slot0, 'bought') / supply) * 100 },
    window: { count: windowB.length, tokens: sum(windowB, 'tokens'), sol: sum(windowB, 'sol'), pct: (sum(windowB, 'tokens') / supply) * 100, grossPct: (sum(windowB, 'bought') / supply) * 100, flipped: flippedCount, slotWindow },
    early: { count: buyers.length, tokens: sum(buyers, 'tokens'), pct: (sum(buyers, 'tokens') / supply) * 100, seconds: earlyWindowSec },
    sharedPayers,
    buyers,
    fingerprints: { groups: groupList.slice(0, 8), uniformity, dominant: groupList[0] || null },
    jito: {
      tippedCount: tipped.length,
      tippedShare: windowB.length ? tipped.length / windowB.length : 0,
      identicalTipShare,
      tipAccounts: [...tipAccounts.entries()].map(([a, n]) => ({ account: a, count: n })),
      inferredBundles,
      bundleIds: null,
    },
    sharedFeeRecipients,
    launchToolPattern: { detected: reasons.length >= 2, reasons },
  };
}

/**
 * Human-readable coordination signals. Rebuilt after the fee-wallet check: a fee wallet that collects
 * a flat fee from hundreds of unrelated traders a minute is a bot/terminal's fee account, and "3 wallets
 * used the same bot" is not coordination.
 */
export function toolPatternReasons(a) {
  const reasons = [];
  const slot0 = a.slot0Count ?? a.slot0?.count ?? 0;
  const n = a.windowCount ?? a.window?.count ?? 0;
  const uniformity = a.uniformity ?? a.fingerprints?.uniformity ?? 0;
  const tipped = a.tippedCount ?? a.jito?.tippedCount ?? 0;
  const identicalTipShare = a.identicalTipShare ?? a.jito?.identicalTipShare ?? 0;
  const fees = (a.sharedFeeRecipients || []).filter((f) => !f.platform);
  const inferred = a.inferredBundles || a.jito?.inferredBundles || [];
  const payers = a.sharedPayers || [];
  const flipped = a.flippedCount ?? a.window?.flipped ?? 0;
  if (slot0 >= 3) reasons.push(`${slot0} wallets bought in the creation slot`);
  if (uniformity >= 0.6 && n >= 4) reasons.push(`${Math.round(uniformity * 100)}% of launch buyers share one transaction fingerprint`);
  if (identicalTipShare >= 0.6 && tipped >= 3) reasons.push(`${tipped} tipped Jito, ${Math.round(identicalTipShare * 100)}% with the identical tip`);
  if (fees[0]?.wallets.length >= 3) reasons.push(`${fees[0].wallets.length} wallets paid the same non-protocol fee wallet (${fees[0].address.slice(0, 4)}…)`);
  if (inferred.some((b) => b.length >= 3)) reasons.push('buys appear in the same Jito bundle(s)');
  if (payers[0]?.wallets.length >= 2) reasons.push(`${payers[0].wallets.length} launch buyers had their fees paid by the same wallet (${payers[0].address.slice(0, 4)}…)`);
  if (flipped >= 3 && flipped / Math.max(1, n) >= 0.3) reasons.push(`${flipped} launch buyers sold again inside the launch window (flip bots)`);
  return reasons;
}

/** Explain a fingerprint key for humans: which settings, and why identical settings matter. */
export function explainFingerprint(key) {
  const [cu, price, tip, route, ix, slip] = key.split('|');
  const parts = [];
  if (cu !== 'na') parts.push({ k: 'compute budget', v: `${Number(cu).toLocaleString()} CU` });
  if (price !== 'na') parts.push({ k: 'priority fee', v: `${Number(price).toLocaleString()} µ-lamports/CU` });
  if (tip && tip !== '0') parts.push({ k: 'Jito tip', v: `${(Number(tip) / LAMPORTS_PER_SOL).toFixed(4)} SOL` });
  parts.push({ k: 'route', v: routeLabel(route === 'na' ? null : route) });
  if (ix && ix !== 'na') parts.push({ k: 'instructions', v: ix });
  if (slip !== 'na') parts.push({ k: 'slippage', v: `${Math.round(Number(slip) * 100)}%` });
  return parts;
}

function describeFingerprint(key) {
  const [cu, price, tip, route, ix, slip] = key.split('|');
  const parts = [];
  if (cu !== 'na') parts.push(`CU ${cu}`);
  if (price !== 'na') parts.push(`prio ${price}µ`);
  if (tip && tip !== '0') parts.push(`tip ${(Number(tip) / LAMPORTS_PER_SOL).toFixed(4)}◎`);
  parts.push(routeLabel(route === 'na' ? null : route));
  if (slip !== 'na') parts.push(`slip ${Math.round(Number(slip) * 100)}%`);
  return parts.join(' · ');
}

/**
 * Once wallets are profiled, split the launch window into operator-like bundle wallets, sniper bots
 * and organic buyers. Unprofiled wallets (beyond the cap) stay 'unclassified' and count toward bundle.
 */
export function applyWalletKinds(analysis, profiles) {
  const kinds = new Map(profiles.map((p) => [p.wallet, p.kind]));
  const profs = new Map(profiles.map((p) => [p.wallet, p]));
  const buckets = { bundle: [], sniper: [], organic: [], unclassified: [] };
  // fingerprint group sizes among window buyers
  const fpCount = new Map();
  for (const b of analysis.buyers) if (b.firstSlotOffset <= analysis.window.slotWindow) fpCount.set(b.fingerprint, (fpCount.get(b.fingerprint) || 0) + 1);
  for (const b of analysis.buyers) {
    if (b.firstSlotOffset > analysis.window.slotWindow) continue;
    let k = kinds.get(b.wallet) || 'unclassified';
    const p = profs.get(b.wallet);
    // Execution evidence beats a quiet wallet history: a buy in the very block the token was created,
    // with the same transaction settings as other creation-block buyers, was prepared with the create.
    if (k === 'organic' && b.firstSlotOffset === 0 && (fpCount.get(b.fingerprint) >= 2 || !p || p.historyTruncated)) {
      k = 'bundle';
      b.kindReason = fpCount.get(b.fingerprint) >= 2 ? 'bought in the creation block with the same transaction fingerprint as other creation-block buyers' : 'bought in the creation block (wallet history too old for this RPC to judge)';
    } else if (k === 'bundle' && p?.fundingKind === 'linked') b.kindReason = 'funded by another launch wallet';
    else if (k === 'bundle' && p?.fundingKind === 'shared-funder') b.kindReason = 'funded by the same wallet as other launch buyers';
    else if (k === 'bundle' && p?.activityScore >= 0.6) b.kindReason = 'scripted-looking warm-up activity';
    else if (k === 'bundle' && p && p.preLaunchTxs === 0) b.kindReason = 'first ever transaction was the launch buy';
    else if (k === 'bundle' && p?.ageHoursAtLaunch != null && p.ageHoursAtLaunch < 7 * 24 && p.preLaunchTxs <= 40) b.kindReason = `fresh wallet (${p.ageHoursAtLaunch < 1 ? '<1h' : `${Math.round(p.ageHoursAtLaunch)}h`} old, ${p.preLaunchTxs} txs before launch)`;
    else if (k === 'sniper') b.kindReason = 'high-volume bot wallet that buys many launches';
    else if (k === 'organic' && p) b.kindReason = `${p.ageHoursAtLaunch != null ? `${Math.round(p.ageHoursAtLaunch / 24)}d old` : 'older'} wallet with a normal history, no links found`;
    b.kind = k;
    buckets[k].push(b);
  }
  const agg = (arr) => ({ count: arr.length, tokens: arr.reduce((s, x) => s + x.tokens, 0), sol: arr.reduce((s, x) => s + x.sol, 0), pct: (arr.reduce((s, x) => s + x.tokens, 0) / analysis.supply) * 100, wallets: arr.map((x) => x.wallet) });
  analysis.bundle = agg([...buckets.bundle, ...buckets.unclassified]);
  analysis.snipers = agg(buckets.sniper);
  analysis.organic = agg(buckets.organic);
  analysis.classified = true;
  return analysis;
}

/** Infer Jito bundles: tipped buy txs in the same slot with consecutive block positions. */
export function inferBundles(buyEvents) {
  const txs = new Map();
  for (const e of buyEvents) if (!txs.has(e.sig)) txs.set(e.sig, e);
  const list = [...txs.values()].filter((e) => e.jitoTip > 0).sort((a, b) => a.order - b.order);
  const bundles = [];
  let cur = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const prev = list[i - 1];
    if (prev && prev.slot === e.slot && e.order - prev.order <= 2 && cur.length < 5) cur.push(e.sig);
    else {
      if (cur.length >= 2) bundles.push(cur);
      cur = [e.sig];
    }
  }
  if (cur.length >= 2) bundles.push(cur);
  return bundles;
}

/** Ask Jito's explorer for bundle ids of the tipped launch txs and group them. */
export async function enrichWithJito(analysis, events, lookup, { max = 40 } = {}) {
  const sigs = [...new Set(events.filter((e) => e.side === 'buy' && e.jitoTip > 0 && e.slotOffset <= analysis.window.slotWindow).map((e) => e.sig))].slice(0, max);
  if (!sigs.length) return analysis;
  const ids = await pMap(sigs, (s) => lookup(s), 4);
  const byBundle = new Map();
  sigs.forEach((s, i) => {
    const id = ids[i];
    if (typeof id !== 'string') return;
    (byBundle.get(id) || byBundle.set(id, []).get(id)).push(s);
  });
  const bundles = [...byBundle.entries()].map(([id, txs]) => ({ id, txs }));
  const sigToWallet = new Map(events.map((e) => [e.sig, e.wallet]));
  analysis.jito.bundleIds = bundles.map((b) => ({ ...b, wallets: [...new Set(b.txs.map((s) => sigToWallet.get(s)).filter(Boolean))] }));
  analysis.jito.confirmedMultiTxBundles = bundles.filter((b) => b.txs.length >= 2).length;
  if (analysis.jito.confirmedMultiTxBundles > 0 && !analysis.launchToolPattern.reasons.some((r) => r.includes('confirmed'))) {
    analysis.launchToolPattern.reasons.push(`${analysis.jito.confirmedMultiTxBundles} confirmed Jito bundle(s) contained multiple launch buys`);
    analysis.launchToolPattern.detected = analysis.launchToolPattern.reasons.length >= 2;
  }
  return analysis;
}
