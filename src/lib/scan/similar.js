// Behavioral resemblance, not identity or a calibrated probability. No wallet key enters the score.
import { DEFAULTS, PROGRAMS } from '../constants.js';
import { isBase58Address } from '../base58.js';
import { INDEX_ENGINE, publishableScan, scanProfileId } from '../shared-index.js';

export const SIMILAR_METHOD = 'launch-behavior-v1';
export const SIMILAR_DIMENSIONS = ['transaction', 'funding', 'sniper', 'shape'];
export const SIMILAR_RULES = Object.freeze({ threshold: 85, dimensionFloor: 60, coverageFloor: 0.6, minimumBuyers: 3, genericCeiling: 0.7 });
export const DAY = 86_400_000;
export const lexical = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const time = (v) => Number.isSafeInteger(v) && v > 0;
const clamp = (v) => Math.max(0, Math.min(1, v));
const publicId = (v) => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(v);
const bucket = (v) => finite(v) && v >= 0 ? String(Math.min(20, Math.floor(Math.log10(1 + v) * 2))) : null;
const numberOrNull = (v) => v !== 'na' && v !== '' && finite(Number(v)) ? Number(v) : null;

function histogram(values, expected) {
  const known = values.filter((v) => v != null), bins = {};
  for (const v of known) bins[v] = (bins[v] || 0) + 1 / known.length;
  return { bins, coverage: expected ? known.length / expected : 0 };
}
function scalar(value, coverage = 1) { return { bins: { low: 1 - clamp(value), high: clamp(value) }, coverage }; }
function dimension(groups, samples) { return { groups, samples }; }

/** Accept only completed SOL-quote engine reports. Source is an operator's public dataset label. */
export function extractLaunchRecord(report, { settings = {}, source = 'worker', quoteMint = PROGRAMS.WSOL } = {}) {
  if (!publishableScan(report) || !time(report.creation?.createdAt) || report.creation.createdAt > report.finishedAt
    || quoteMint !== PROGRAMS.WSOL || !publicId(source)) throw new Error('invalid-history-report');
  const cfg = { ...DEFAULTS, ...settings }, launch = report.launch;
  if (launch.blocksRead < cfg.slotWindow + 1) throw new Error('incomplete-history-window');
  const unique = new Map();
  for (const b of launch.buyers || []) if (isBase58Address(b?.wallet) && Number.isInteger(b.firstSlotOffset)
    && b.firstSlotOffset >= 0 && b.firstSlotOffset <= cfg.slotWindow && !unique.has(b.wallet)) unique.set(b.wallet, b);
  const buyers = [...unique.values()].slice(0, 100);
  const expected = Math.max(buyers.length, Number.isInteger(launch.window?.count) ? launch.window.count : 0);
  const profiles = new Map((report.wallets?.profiles || []).filter((p) => isBase58Address(p?.wallet)).map((p) => [p.wallet, p]));
  const tx = buyers.map((b) => {
    const parts = typeof b.fingerprint === 'string' ? b.fingerprint.split('|') : [];
    return { compute: bucket(b.cuLimit), fee: bucket(b.cuPrice), tip: bucket(b.tip),
      route: isBase58Address(b.route) ? b.route : null,
      instructions: bucket(numberOrNull(parts[4])), slippage: bucket(numberOrNull(parts[5]) == null ? null : Number(parts[5]) * 100) };
  });
  const transaction = dimension(Object.fromEntries(['compute','fee','tip','route','instructions','slippage']
    .map((k) => [k, histogram(tx.map((v) => v[k]), expected)])), buyers.length);
  const methods = new Set(['transfer','wsol-close','payer','token-transfer','proceeds']);
  const kinds = new Set(['exchange','linked','shared-funder','high-volume','wallet']);
  const fundingProfiles = buyers.map((b) => profiles.get(b.wallet));
  const funding = dimension({
    method: histogram(fundingProfiles.map((p) => p && !p.historyTruncated && methods.has(p.fundingMethod) ? p.fundingMethod : null), expected),
    kind: histogram(fundingProfiles.map((p) => p && !p.historyTruncated && kinds.has(p.fundingKind) ? p.fundingKind : null), expected),
  }, fundingProfiles.filter((p) => p && !p.historyTruncated && methods.has(p.fundingMethod) && kinds.has(p.fundingKind)).length);
  const sniper = dimension({ mix: histogram(buyers.map((b) => launch.classified && ['bundle','sniper','organic'].includes(b.kind) ? b.kind : null), expected) }, buyers.length);
  const amounts = buyers.filter((b) => positive(b.boughtPct));
  const total = amounts.reduce((n,b) => n + b.boughtPct, 0), tokenBins = {};
  for (const b of amounts) tokenBins[b.firstSlotOffset] = (tokenBins[b.firstSlotOffset] || 0) + b.boughtPct / total;
  const coverage = expected ? buyers.length / expected : 0;
  const shape = dimension({ slots: histogram(buyers.map((b) => String(b.firstSlotOffset)), expected),
    tokenSlots: { bins: tokenBins, coverage: expected ? amounts.length / expected : 0 },
    buyerScale: scalar(Math.log2(buyers.length + 1) / Math.log2(101), coverage),
    supplyScale: scalar(total / 100, expected ? amounts.length / expected : 0) }, buyers.length);
  const common = new Set((launch.sharedFeeRecipients || []).filter((f) => f.platform === true).flatMap((f) => f.wallets || []));
  const generic = buyers.filter((b) => b.kind === 'sniper' || common.has(b.wallet) || ['exchange','high-volume'].includes(profiles.get(b.wallet)?.fundingKind)).length;
  const record = { version: 1, engine: INDEX_ENGINE, method: SIMILAR_METHOD, profile: scanProfileId(cfg), source,
    quoteMint, mint: report.mint, launchAt: report.creation.createdAt, observedAt: report.finishedAt,
    sample: { windowBuyers: expected, capturedBuyers: buyers.length },
    identity: { creator: isBase58Address(report.creation.creator) ? report.creation.creator : null, buyers: buyers.map((b) => b.wallet).sort(),
      cluster: [...new Set([report.creation.creator,...buyers.filter((b) => !['organic','sniper'].includes(b.kind)).map((b) => b.wallet)].filter(isBase58Address))].sort(),
      clusterComplete:buyers.length === expected && isBase58Address(report.creation.creator) },
    features: { transaction, funding, sniper, shape }, genericShare: buyers.length ? generic / buyers.length : 1, observations: [] };
  // Only an actual quoted market observation, not a historical curve estimate or absolute ATH cap.
  if (positive(report.market?.priceUsd) && !report.market.mcapSource && isBase58Address(report.market.pairAddress)) {
    record.observations.push({ kind: 'price', at: report.finishedAt, priceUsd: report.market.priceUsd,
      source: `dexscreener:${report.market.pairAddress}`, evidence: `https://dexscreener.com/solana/${report.market.pairAddress}` });
  }
  return record;
}

export function validLaunchRecord(r) {
  if (!r || r.version !== 1 || r.engine !== INDEX_ENGINE || r.method !== SIMILAR_METHOD || r.quoteMint !== PROGRAMS.WSOL
    || !isBase58Address(r.mint) || !publicId(r.source) || typeof r.profile !== 'string' || r.profile.length > 300
    || !time(r.launchAt) || !time(r.observedAt) || r.observedAt < r.launchAt || !finite(r.genericShare) || r.genericShare < 0 || r.genericShare > 1
    || !Number.isInteger(r.sample?.windowBuyers) || r.sample.windowBuyers < 0 || !Number.isInteger(r.sample.capturedBuyers)
    || r.sample.capturedBuyers < 0 || r.sample.capturedBuyers > 100 || r.sample.capturedBuyers > r.sample.windowBuyers
    || !(r.identity?.creator === null || isBase58Address(r.identity?.creator)) || !Array.isArray(r.identity?.buyers)
    || r.identity.buyers.length > 100 || r.identity.buyers.some((a) => !isBase58Address(a))
    || !Array.isArray(r.identity.cluster) || r.identity.cluster.length > 101 || r.identity.cluster.some((a) => !isBase58Address(a))
    || typeof r.identity.clusterComplete !== 'boolean'
    || new Set(r.identity.buyers).size !== r.identity.buyers.length || new Set(r.identity.cluster).size !== r.identity.cluster.length
    || !Array.isArray(r.observations) || r.observations.length > 32) return false;
  const groupKeys = { transaction: ['compute','fee','tip','route','instructions','slippage'], funding: ['method','kind'], sniper: ['mix'], shape: ['slots','tokenSlots','buyerScale','supplyScale'] };
  for (const d of SIMILAR_DIMENSIONS) {
    const f = r.features?.[d];
    if (!f || !Number.isInteger(f.samples) || f.samples < 0 || f.samples > 100 || !f.groups
      || Object.keys(f.groups).sort().join() !== groupKeys[d].sort().join()) return false;
    for (const g of Object.values(f.groups)) {
      if (!g || !finite(g.coverage) || g.coverage < 0 || g.coverage > 1 || !g.bins || Array.isArray(g.bins) || Object.keys(g.bins).length > 100) return false;
      let total = 0;
      for (const [key,v] of Object.entries(g.bins)) { if (!key || key.length > 100 || !finite(v) || v < 0 || v > 1) return false; total += v; }
      if (Object.keys(g.bins).length && Math.abs(total - 1) > 1e-8) return false;
      if (g.coverage > 0 && !Object.keys(g.bins).length) return false;
    }
  }
  try { for (const o of r.observations) validateObservation(o, r); } catch { return false; }
  return JSON.stringify(r).length <= 32768;
}

export function compareLaunches(a,b) {
  const components = {}, coverage = {};
  for (const d of SIMILAR_DIMENSIONS) {
    let weighted = 0, weight = 0;
    const groups = Object.keys(a.features[d].groups);
    for (const g of groups) {
      const x = a.features[d].groups[g], y = b.features[d].groups[g];
      const w = Math.min(x.coverage, y.coverage); if (!w) continue;
      const keys = new Set([...Object.keys(x.bins), ...Object.keys(y.bins)]);
      const distance = [...keys].reduce((n,k) => n + Math.abs((Object.hasOwn(x.bins,k) ? x.bins[k] : 0) - (Object.hasOwn(y.bins,k) ? y.bins[k] : 0)), 0) / 2;
      weighted += (1 - distance) * w; weight += w;
    }
    components[d] = weight ? Math.max(0, Math.min(100, weighted / weight * 100)) : null;
    coverage[d] = weight / groups.length;
  }
  const reasons = [];
  if (Math.min(a.sample.capturedBuyers,b.sample.capturedBuyers,a.features.funding.samples,b.features.funding.samples) < SIMILAR_RULES.minimumBuyers) reasons.push('small-sample');
  if (SIMILAR_DIMENSIONS.some((d) => coverage[d] < SIMILAR_RULES.coverageFloor)) reasons.push('missing-dimensions');
  if (SIMILAR_DIMENSIONS.some((d) => components[d] == null || components[d] < SIMILAR_RULES.dimensionFloor)) reasons.push('conflicting-dimension');
  if (Math.max(a.genericShare,b.genericShare) >= SIMILAR_RULES.genericCeiling) reasons.push('common-infrastructure');
  const score = SIMILAR_DIMENSIONS.reduce((n,d) => n + (components[d] || 0), 0) / 4;
  if (score < SIMILAR_RULES.threshold) reasons.push('below-threshold');
  const wallets = new Set(a.identity.buyers);
  return { score, components, coverage, accepted: reasons.length === 0, reasons,
    exactWalletEvidence: { sameReportedCreator: !!a.identity.creator && a.identity.creator === b.identity.creator,
      sharedLaunchBuyers: b.identity.buyers.filter((w) => wallets.has(w)).length } };
}

/** Operator-provided observations are validated assertions, not independently verified chain facts. */
export function validateObservation(o, record, now = Date.now()) {
  if (!o || !['price','exit-window'].includes(o.kind) || !time(o.at) || o.at < record.launchAt || o.at > now
    || !publicId(o.source) || typeof o.evidence !== 'string' || o.evidence.length > 240) throw new Error('invalid-outcome-observation');
  let url;try { url = new URL(o.evidence); } catch { throw new Error('invalid-evidence-reference'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid-evidence-reference');
  if (o.kind === 'price') {
    if (!positive(o.priceUsd)) throw new Error('invalid-observed-price');
    return { kind: o.kind, at: o.at, source: o.source, evidence: url.href, priceUsd: o.priceUsd };
  }
  if (o.basis !== 'initial-launch-cluster' || o.windowStart !== record.launchAt || o.windowEnd !== record.launchAt + 90 * 60_000
    || o.at < o.windowEnd || typeof o.complete !== 'boolean' || !positive(o.initialTokens) || !finite(o.soldTokens) || o.soldTokens < 0
    || o.soldFraction !== Math.min(1,o.soldTokens/o.initialTokens) || o.complete && !record.identity.clusterComplete
    || !Array.isArray(o.cohortWallets) || !o.cohortWallets.length
    || JSON.stringify([...o.cohortWallets].sort()) !== JSON.stringify(record.identity.cluster)) throw new Error('invalid-exit-window');
  return { kind: o.kind, at: o.at, source: o.source, evidence: url.href, basis: o.basis,
    windowStart: o.windowStart, windowEnd: o.windowEnd, complete: o.complete, soldFraction: o.soldFraction,
    initialTokens:o.initialTokens,soldTokens:o.soldTokens,cohortWallets:[...o.cohortWallets].sort() };
}

export function observedOutcome(record, cutoff) {
  const observations = record.observations.filter((o) => o.at <= cutoff).sort((a,b) => a.at - b.at || lexical(a.source,b.source));
  const baseline = observations.find((o) => o.kind === 'price' && o.at <= record.launchAt + 5 * 60_000);
  const later = baseline ? observations.filter((o) => o.kind === 'price' && o.source === baseline.source && o.at > baseline.at && o.at <= record.launchAt + DAY) : [];
  let peak = baseline && later.length ? [baseline,...later].reduce((best,o) => o.priceUsd > best.priceUsd ? o : best) : null;
  if (peak && !finite(peak.priceUsd / baseline.priceUsd)) peak = null;
  const exits = observations.filter((o) => o.kind === 'exit-window' && o.complete);
  const exit = exits.length && exits.every((o) => (o.soldFraction >= 0.5) === (exits[0].soldFraction >= 0.5)) ? exits[0] : null;
  return { observedPeakMultiple: peak ? peak.priceUsd / baseline.priceUsd : null,
    priceSamples: peak ? later.length + 1 : 0, baselineAt: peak ? baseline.at : null, peakAt: peak?.at ?? null,
    baselineUsd: peak ? baseline.priceUsd : null, peakUsd: peak?.priceUsd ?? null, priceSource: peak ? baseline.source : null,
    rapidDump: exit ? exit.soldFraction >= 0.5 : null,
    exitSource: exit?.source ?? null, exitWindowEnd: exit?.windowEnd ?? null, soldFraction: exit?.soldFraction ?? null,
    evidence: [peak ? baseline.evidence : null, peak?.evidence, exit?.evidence].filter((v,i,a) => v && a.indexOf(v) === i),
    provenance: 'operator observations; not independently verified' };
}

export function summarizeOutcomes(records, cutoff) {
  const values = records.map((r) => observedOutcome(r,cutoff));
  const peaks = values.map((v) => v.observedPeakMultiple).filter((v) => v != null).sort((a,b) => a-b);
  const exits = values.filter((v) => v.rapidDump != null), dumps = exits.filter((v) => v.rapidDump).length;
  const mid = Math.floor(peaks.length / 2);
  return { matchedLaunches: records.length, knownPeaks: peaks.length, unknownPeaks: records.length - peaks.length,
    medianObservedPeakMultiple: peaks.length ? peaks.length % 2 ? peaks[mid] : peaks[mid-1]/2+peaks[mid]/2 : null,
    knownExitWindows: exits.length, unknownExitWindows: records.length-exits.length, rapidDumps: dumps,
    rapidDumpFraction: exits.length ? dumps / exits.length : null,
    baseline: 'first observed USD token price within 5 minutes of launch',
    peak: 'maximum same-source observed price in first 24 hours; at least two samples; not ATH',
    rapidDump: 'at least 50% of initial launch-cluster tokens sold within a complete first 90-minute window' };
}
