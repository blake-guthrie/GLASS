// Fee wallets: a top-level SOL transfer from the buyer to some wallet inside the buy transaction is a
// fee the *client* added (pump.fun's protocol fee is paid inside the program). Two very different
// things look the same on-chain:
//   • a trading bot / terminal fee account — flat 0.001–0.002 SOL from hundreds of unrelated traders a
//     minute ("moon…" wallets, etc.). Three launch buyers paying it just used the same popular bot.
//   • a launch tool's or operator's own fee wallet — few payers, all from the same launches.
// We tell them apart by looking at who else paid the wallet in its last dozen transactions.
import { parseTx } from '../txparse.js';
import { botFee } from '../routes.js';

const memo = new Map();

export async function classifyFeeWallet(rpc, address, { memory } = {}) {
  const known = botFee(address);
  if (known) return { address, platform: true, label: `${known.label} fee account (official label; shared use does not identify an operator)`, source: known.source, payers: null, mints: null, perMinute: null };
  const hit = memo.get(address);
  if (hit && hit.exp > Date.now()) return hit.v;
  // local memory (persisted across scans)
  if (memory?.getRep) {
    const r = await memory.getRep('fee', address).catch(() => null);
    if (r?.platform != null && Date.now() - (r.platformCheckedAt || 0) < 7 * 86400000) {
      const v = { address, platform: r.platform, payers: r.platformPayers, mints: r.platformMints, perMinute: r.platformPerMinute, cached: true };
      memo.set(address, { v, exp: Date.now() + 3600_000 });
      return v;
    }
  }
  let v = { address, platform: false, payers: null, mints: null, perMinute: null };
  try {
    const sigs = ((await rpc.getSignaturesForAddress(address, { limit: 40 })) || []).filter((s) => !s.err);
    const span = sigs.length >= 2 ? Math.max(1, sigs[0].blockTime - sigs[sigs.length - 1].blockTime) : null;
    const perMinute = span ? (sigs.length / span) * 60 : 0;
    const pick = sigs.slice(0, 12);
    const raws = pick.length ? await rpc.getTransactions(pick.map((s) => s.signature)) : [];
    const payers = new Set();
    const mints = new Set();
    const amounts = [];
    raws.forEach((raw, i) => {
      const rec = parseTx(raw, pick[i].signature);
      if (!rec) return;
      payers.add(rec.feePayer);
      for (const e of rec.pumpEvents || []) if (e.mint) mints.add(e.mint);
      for (const t of rec.systemTransfers || []) if (t.to === address && t.from === rec.feePayer) amounts.push(t.lamports);
    });
    // Flat small fees from many different payers across several tokens → a bot / terminal fee account
    const distinctAmounts = new Set(amounts.map((a) => Math.round(a / 1e5))).size;
    const platform = payers.size >= 7 && mints.size >= 3 && (perMinute >= 2 || distinctAmounts <= 3);
    v = { address, platform, payers: payers.size, mints: mints.size, perMinute: Math.round(perMinute * 10) / 10, flatFee: distinctAmounts <= 3 && amounts.length >= 5 };
    if (memory?.noteRepMeta) await memory.noteRepMeta('fee', address, { platform, platformPayers: payers.size, platformMints: mints.size, platformPerMinute: v.perMinute, platformCheckedAt: Date.now() }).catch(() => {});
  } catch {
    /* keep the default: not proven to be a platform */
  }
  memo.set(address, { v, exp: Date.now() + 3600_000 });
  return v;
}

/** Annotate analysis.sharedFeeRecipients in place with the platform flag + stats. */
export async function annotateFeeWallets(rpc, analysis, { memory, max = 3 } = {}) {
  const list = (analysis?.sharedFeeRecipients || []).slice(0, max);
  for (const f of list) {
    const c = await classifyFeeWallet(rpc, f.address, { memory });
    f.platform = c.platform;
    f.payersSeen = c.payers;
    f.mintsSeen = c.mints;
    f.perMinute = c.perMinute;
    f.flatFee = c.flatFee;
    f.label = c.label || (c.platform ? 'trading bot / terminal fee account (many unrelated traders pay it)' : c.payers != null ? `only ${c.payers} payer(s) across ${c.mints} token(s) in its recent history — private launch-tool or operator fee wallet` : 'unclassified fee wallet');
  }
  return list;
}
