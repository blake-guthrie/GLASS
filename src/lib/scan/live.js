// Stage 4: live view of the flagged cluster — what they hold now, when they sold, whether they sold
// together, and where they moved tokens to.
//
// Activity is read from each wallet's token account (ATA) for this mint, not from the wallet itself:
// a dev farm that mints 30 tokens a day has hundreds of unrelated transactions an hour, so the last N
// wallet signatures would never contain the sell of *this* token. The ATA's signature list is exactly
// the set of transactions that moved this token for that wallet.
import { parseTx, classifyForMint } from '../txparse.js';
import { pMap } from '../http.js';
import { PROGRAMS } from '../constants.js';

/**
 * @param cluster  [{wallet, tokens, kind}] the operator cluster (creator + bundle-like launch wallets)
 * @param others   [{wallet, tokens, kind}] other early buyers (snipers, organic) — balances only
 */
export async function trackCluster(rpc, mint, cluster, { launchTimeSec, supply, tokenProgram = PROGRAMS.TOKEN, maxWallets = 25, txsPerWallet = 12, others = [], onProgress } = {}) {
  const wallets = cluster.slice(0, maxWallets);
  const bought = new Map(cluster.map((c) => [c.wallet, c.tokens]));
  const tp = tokenProgram || PROGRAMS.TOKEN;

  // 1) Holdings now — cluster and every other early buyer we know about (one getMultipleAccounts batch)
  const allOwners = [...new Set([...wallets.map((w) => w.wallet), ...others.map((o) => o.wallet)])];
  const balances = await rpc.getTokenBalances(allOwners, mint, { tokenProgram: tp });
  const balMap = new Map(balances.map((b) => [b.owner, b.amount]));
  const holdings = wallets.map((w) => ({ wallet: w.wallet, kind: w.kind || (w.wallet === cluster[0]?.wallet ? 'dev' : 'bundle'), now: balMap.get(w.wallet) ?? null, bought: bought.get(w.wallet) || 0 }));
  const otherHoldings = others.map((o) => ({ wallet: o.wallet, kind: o.kind, now: balMap.get(o.wallet) ?? null, bought: o.tokens || 0 }));

  // 2) Post-launch activity per cluster wallet, via its token account for this mint
  const activity = await pMap(
    wallets,
    async ({ wallet }) => {
      let ata;
      try {
        ata = await rpc.ataFor(wallet, mint, tp);
      } catch {
        return [];
      }
      const sigs = (await rpc.getSignaturesForAddress(ata, { limit: 40 })) || [];
      const after = sigs.filter((s) => !s.err && (s.blockTime == null || s.blockTime >= launchTimeSec - 5)).slice(0, txsPerWallet);
      if (!after.length) return [];
      const raws = await rpc.getTransactions(after.map((s) => s.signature));
      const evs = [];
      raws.forEach((raw, i) => {
        const rec = parseTx(raw, after[i].signature);
        if (!rec || rec.err) return;
        const c = classifyForMint(rec, mint, wallet);
        if (!c.side) return;
        const ev = { wallet, sig: rec.sig, slot: rec.slot, t: rec.blockTime ? rec.blockTime * 1000 : null, side: c.side, tokens: c.tokens, sol: c.sol, quoteMint: c.quoteMint, quoteAmount: c.quoteAmount };
        // price at the time, from the program's own trade event when present
        const te = (rec.pumpEvents || []).find((e) => e.type === 'trade' && e.mint === mint);
        if (te?.priceQuote) ev.priceQuote = te.priceQuote;
        if (c.side === 'transfer_out') {
          const tr = rec.splTransfers.find((x) => x.mint === mint && x.fromOwner === wallet);
          ev.to = tr?.toOwner || null;
        }
        if (c.side === 'transfer_in') {
          const tr = rec.splTransfers.find((x) => x.mint === mint && x.toOwner === wallet);
          ev.from = tr?.fromOwner || null;
        }
        evs.push(ev);
      });
      onProgress?.();
      return evs;
    },
    4,
  );
  const events = activity.flat().filter((e) => e && !e.error).sort((a, b) => (a.t || 0) - (b.t || 0));
  // The launch buy itself is not "activity after launch"
  const launchMs = launchTimeSec * 1000;
  const post = events.filter((e) => !(e.side === 'buy' && e.t != null && e.t - launchMs <= 2500));

  // 3) Coordinated exits: ≥2 distinct cluster wallets selling within 10 seconds
  const sells = post.filter((e) => e.side === 'sell' && e.t);
  const exitEvents = [];
  let i = 0;
  while (i < sells.length) {
    let j = i;
    const ws = new Set();
    let tokens = 0;
    let sol = 0;
    while (j < sells.length && sells[j].t - sells[i].t <= 10_000) {
      ws.add(sells[j].wallet);
      tokens += sells[j].tokens;
      sol = sol == null || sells[j].sol == null ? null : sol + sells[j].sol;
      j++;
    }
    if (ws.size >= 2) exitEvents.push({ at: sells[i].t, wallets: ws.size, tokens, sol, pct: supply ? (tokens / supply) * 100 : null, minutesAfterLaunch: Math.round((sells[i].t / 1000 - launchTimeSec) / 60) });
    i = j;
  }

  // 4) Hand-offs: tokens moved to other wallets (to sell "clean")
  const handoffs = post.filter((e) => e.side === 'transfer_out' && e.to);
  const handoffRecipients = [...new Set(handoffs.map((h) => h.to))].slice(0, 20);
  let recipientHoldings = [];
  if (handoffRecipients.length) {
    const rb = await rpc.getTokenBalances(handoffRecipients, mint, { tokenProgram: tp });
    recipientHoldings = rb.map((b) => ({ wallet: b.owner, now: b.amount }));
  }

  const totalBought = holdings.reduce((s, h) => s + h.bought, 0);
  const totalNow = holdings.reduce((s, h) => s + (h.now || 0), 0);
  const balancesUnavailable = holdings.length > 0 && holdings.every((h) => h.now === null);
  const handedOff = handoffs.reduce((s, h) => s + h.tokens, 0);
  const recipientNow = recipientHoldings.reduce((s, r) => s + (r.now || 0), 0);
  const soldFromEvents = sells.reduce((s, x) => s + x.tokens, 0);
  // Prefer the balance-based number (complete); fall back to summed sells when balances are unavailable
  const soldTokens = balancesUnavailable ? soldFromEvents : Math.max(0, totalBought - totalNow - handedOff) + Math.max(0, handedOff - recipientNow);
  const firstSell = sells[0] || null;
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentSells = sells.filter((s) => s.t >= tenMinAgo);
  const soldSol = sells.some((x) => x.sol == null) ? null : sells.reduce((s, x) => s + x.sol, 0);

  return {
    holdings,
    otherHoldings,
    recipientHoldings,
    events: post,
    exitEvents,
    handoffs,
    summary: {
      walletsTracked: wallets.length,
      balancesUnavailable,
      clusterBoughtPct: supply ? (totalBought / supply) * 100 : null,
      clusterHoldsPct: supply && !balancesUnavailable ? ((totalNow + recipientNow) / supply) * 100 : null,
      clusterSoldPct: supply ? (soldTokens / supply) * 100 : null,
      clusterSoldShare: totalBought ? Math.min(1, soldTokens / totalBought) : null,
      clusterSoldSol: soldSol,
      sellsSeen: sells.length,
      firstClusterSellMin: firstSell ? Math.round((firstSell.t / 1000 - launchTimeSec) / 60) : null,
      firstClusterSellAt: firstSell ? firstSell.t : null,
      coordinatedExits: exitEvents.length,
      handoffCount: handoffs.length,
      handoffTokensPct: supply ? (handedOff / supply) * 100 : null,
      dumpingNow: recentSells.length,
      recentSoldPct: supply ? (recentSells.reduce((s, x) => s + x.tokens, 0) / supply) * 100 : null,
      lastClusterSellAt: sells.length ? sells[sells.length - 1].t : null,
    },
  };
}
