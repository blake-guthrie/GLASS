#!/usr/bin/env node
// CLI harness: runs the exact same scan pipeline the extension uses, against mainnet.
// Usage: node cli/scan.mjs <mint|pair> [--rpc URL] [--json out.json] [--no-operator] [--no-live] [--memory file.json]
import fs from 'node:fs';
import { RpcClient } from '../src/lib/rpc.js';
import { runScan } from '../src/lib/scan/pipeline.js';
import { MemoryStore, OperatorMemory } from '../src/lib/cache.js';
import { fmtUsd, fmtMin } from '../src/lib/scan/operator.js';
import { fmtPct } from '../src/lib/scan/score.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id) {
  console.error('usage: node cli/scan.mjs <mint|pair> [--rpc URL] [--json out.json] [--no-operator] [--no-live] [--memory file.json] [--quiet]');
  process.exit(1);
}
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const rpcUrl = opt('--rpc', process.env.GLASS_RPC || 'https://solana-rpc.publicnode.com');
// --origin sends an Origin header like a browser extension would, to reproduce endpoint behaviour exactly.
const origin = opt('--origin', null);
const quiet = args.includes('--quiet');
const memFile = opt('--memory', null);
const memStore = new MemoryStore(memFile && fs.existsSync(memFile) ? JSON.parse(fs.readFileSync(memFile, 'utf8')) : {});
const memory = new OperatorMemory(memStore);

const rpc = new RpcClient(rpcUrl, { extraHeaders: origin ? { Origin: origin } : undefined, onStat: (st) => st.failover && console.error(`  · RPC failover: ${st.failover.reason} → ${st.failover.to}`) });
const started = Date.now();
const report = await runScan(rpc, id, {
  settings: { operatorHistory: !args.includes('--no-operator'), liveTracking: !args.includes('--no-live') },
  memory,
  log: quiet ? () => {} : (m) => console.error(`  · ${m}`),
  emit: (stage, r) => {
    if (quiet) return;
    const st = r.stages[stage];
    if (st?.status === 'done') console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${stage} ✓ (${st.ms}ms, rpc calls so far: ${r.rpcCalls})`);
    else if (st?.status === 'error') console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${stage} ✗ ${r.errors.at(-1)?.message}`);
  },
});

if (memFile) fs.writeFileSync(memFile, JSON.stringify(memStore.toJSON(), null, 0));
const jsonOut = opt('--json', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));

// ---- pretty print ----
const L = report.launch;
const m = report.market || {};
console.log(`\nGLASS report — ${m.name || report.creation?.tokenName || ''} (${m.symbol || report.creation?.symbol || ''})  ${report.mint}`);
console.log(`market: ${fmtUsd(m.marketCapUsd)} mcap · ${m.dexId || '?'} · liquidity ${fmtUsd(m.liquidityUsd)} · pair ${m.pairAddress || '-'}`);
if (report.creation) console.log(`created: slot ${report.creation.slot} at ${new Date(report.creation.createdAt).toISOString()} by ${report.creation.creator} (via ${report.creation.method})`);
if (report.score) {
  const c = report.score.call;
  if (c) console.log(`\n${c.word.toUpperCase()} (${c.confidence} confidence) — ${c.why.join('; ')}${c.gaps?.length ? ` · not known: ${c.gaps.join(', ')}` : ''}`);
  console.log(`GLASS RISK ${report.score.score}/100 — ${report.score.verdict.headline}`);
  console.log(`  ${report.score.verdict.sub}`);
  for (const p of report.score.parts) console.log(`  [${String(p.pts).padStart(2)}/${p.max}] ${p.label}: ${p.detail}`);
}
if (L) {
  console.log(`\nLaunch window (slots 0–${L.window.slotWindow}): ${L.window.count} wallets, ${fmtPct(L.window.pct)} of supply, ${L.window.sol.toFixed(2)} SOL · creation-slot: ${L.slot0.count} wallets ${fmtPct(L.slot0.pct)} · dev buy ${fmtPct(L.creatorDevBuy.pct)} (${L.creatorDevBuy.sol.toFixed(2)} SOL)`);
  console.log(`early (${L.early.seconds}s): ${L.early.count} wallets ${fmtPct(L.early.pct)}${L.partialEarly ? ' (partial)' : ''} · txs read ${L.txsRead} · blocks ${L.blocksRead}`);
  console.log(`fingerprint uniformity ${(L.fingerprints.uniformity * 100).toFixed(0)}% — dominant: ${L.fingerprints.dominant?.label || '-'} (${L.fingerprints.dominant?.wallets.length || 0} wallets)`);
  console.log(`jito: ${L.jito.tippedCount} tipped (${(L.jito.tippedShare * 100).toFixed(0)}%), identical tip share ${(L.jito.identicalTipShare * 100).toFixed(0)}%, inferred bundles ${L.jito.inferredBundles.length}, confirmed multi-tx bundles ${L.jito.confirmedMultiTxBundles ?? 'n/a'}`);
  if (L.sharedFeeRecipients.length) console.log(`shared fee recipients: ${L.sharedFeeRecipients.map((x) => `${x.address} (${x.wallets.length})`).join(', ')}`);
  console.log(`launch-tool pattern: ${L.launchToolPattern.detected ? 'YES' : 'no'} — ${L.launchToolPattern.reasons.join('; ') || 'none'}`);
  for (const b of L.buyers.slice(0, 12)) console.log(`  +${b.firstSlotOffset} ${b.wallet} ${fmtPct(b.pct)} ${b.sol.toFixed(3)}◎ tip ${b.tip} ${b.routeLabel}`);
}
if (report.wallets?.summary) {
  const s = report.wallets.summary;
  console.log(`\nWallets profiled ${s.walletsProfiled}: funding ${JSON.stringify(s.fundingKinds)} · exchanges ${s.exchangesUsed?.join(',') || '-'} · median age ${s.medianAgeHours == null ? '-' : s.medianAgeHours.toFixed(1) + 'h'} · generated-activity ${s.generatedActivityWallets} · fresh ${s.freshWallets}`);
  for (const r of s.reasons || []) console.log(`  - ${r}`);
}
if (report.live?.summary) {
  const s = report.live.summary;
  console.log(`\nLive: cluster bought ${fmtPct(s.clusterBoughtPct)} → holds ${fmtPct(s.clusterHoldsPct)} now, sold ${fmtPct(s.clusterSoldPct)} · first sell +${s.firstClusterSellMin ?? '-'}m · coordinated exits ${s.coordinatedExits} · hand-offs ${s.handoffCount} · dumping now: ${s.dumpingNow}`);
}
if (report.operator) {
  const o = report.operator;
  const pf = o.profile;
  const profileSource = pf?.source === 'creator-history' ? 'multiple launchpads; partial coverage' : pf?.source || 'source unknown';
  console.log(`\nDev history: ${pf ? `${pf.totalCreated}${pf.atLeast ? '+' : ''} tokens launched by this wallet (${profileSource}) · ${pf.archetype?.label || ''}` : `${o.coverage ? 'creator records unavailable' : 'pump.fun record unavailable'}${o.profileError ? ` (${o.profileError})` : ''}`} · ${o.discovered} prior launch(es) linked${o.rating ? ` — ${o.rating.label} ${o.rating.score ?? ''}` : ''}`);
  for (const r of o.rating?.reasons || []) console.log(`  - ${r}`);
  for (const l of (o.launches || []).slice(0, 15)) console.log(`  ${l.relation.padEnd(7)} ${l.symbol || '?'} ${l.mint} peak ${fmtUsd(l.peakMcapUsd)} @${fmtMin(l.minutesToPeak)} now ${fmtUsd(l.nowMcapUsd)} ${l.graduated ? 'GRAD' : ''} ${l.outcome} ${l.clusterExit?.sells ? `cluster sold +${l.clusterExit.firstSellMin}m` : ''}`);
  if (o.rating?.exit) {
    const e = o.rating.exit;
    console.log(`  exit zone: conservative ${fmtUsd(e.conservative.mcapUsd)} · base ${fmtUsd(e.base.mcapUsd)} · stretch ${fmtUsd(e.stretch.mcapUsd)}${e.operatorDump ? ` · operator usually dumps ~${fmtUsd(e.operatorDump.mcapUsd)} (+${fmtMin(e.operatorDump.minutes)})` : ''}`);
  }
}
if (report.errors.length) console.log(`\nerrors: ${report.errors.map((e) => `${e.stage}: ${e.message}`).join(' | ')}`);
console.log(`\n${report.rpcCalls} RPC calls via ${report.rpc?.url}${report.rpc?.switched ? ` (fell back from ${report.rpc.switched.from})` : ''}, ${((report.totalMs || Date.now() - started) / 1000).toFixed(1)}s${rpc.degraded ? `, ${rpc.degraded} failed requests` : ''}`);
