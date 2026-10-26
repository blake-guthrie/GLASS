import { INDEX_ENGINE, INDEX_MAX_BYTES, INDEX_MAX_AGE_MS, indexEndpoint, scanProfileId } from './shared-index.js';
import { isBase58Address } from './base58.js';
import { SIMILAR_METHOD, SIMILAR_DIMENSIONS, SIMILAR_RULES, DAY } from './scan/similar.js';
const integer = (n,max = 5000) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const numeric = (n,min,max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const source = (s) => typeof s === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(s);
const time = (n) => Number.isSafeInteger(n) && n > 0;
const evidence = (s) => { try { const u = new URL(s); return typeof s === 'string' && s.length <= 240 && u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };

/** Strict method/time/denominator checks. This validates the envelope, not the operator's claims. */
export function validateSimilar(input, { mint,settings = {},now = Date.now() } = {}) {
  try {
    const i = input,c = i.coverage,s = i.summary;
    if (i.schema !== 1 || i.engine !== INDEX_ENGINE || i.method !== SIMILAR_METHOD || i.profile !== scanProfileId(settings)
      || i.mint !== mint || !isBase58Address(mint) || !time(i.generatedAt) || i.generatedAt > now+5000 || i.generatedAt < now-INDEX_MAX_AGE_MS
      || !time(i.targetLaunchAt) || i.targetLaunchAt > i.generatedAt || i.cutoff !== i.targetLaunchAt
      || !integer(i.windowDays,90) || !i.windowDays || i.windowStart !== i.cutoff-i.windowDays*DAY
      || Object.keys(SIMILAR_RULES).some((k) => i.rules?.[k] !== SIMILAR_RULES[k])) return null;
    for (const k of ['storedRecords','eligibleLaunches','matchedLaunches','returnedMatches','duplicateRecords','excludedRecords']) if (!integer(c[k])) return null;
    if (!['evictedCapacity','evictedRetention'].every((k) => integer(c[k],Number.MAX_SAFE_INTEGER))
      || !time(c.collectionStartedAt) || c.collectionStartedAt > i.generatedAt
      || !(c.oldestRetainedLaunchAt === null || time(c.oldestRetainedLaunchAt) && c.oldestRetainedLaunchAt <= i.generatedAt)
      || !source(c.targetSource) || !time(c.targetObservedAt) || c.targetObservedAt < i.targetLaunchAt || c.targetObservedAt > i.generatedAt
      || c.eligibleLaunches+c.duplicateRecords+c.excludedRecords !== c.storedRecords
      || c.matchedLaunches > c.eligibleLaunches || c.returnedMatches > Math.min(20,c.matchedLaunches)
      || !Array.isArray(i.matches) || i.matches.length !== c.returnedMatches) return null;
    const rejected = {};
    for (const [k,v] of Object.entries(c.rejected)) {
      if (!['small-sample','missing-dimensions','conflicting-dimension','common-infrastructure','below-threshold'].includes(k) || !integer(v,c.eligibleLaunches-c.matchedLaunches)) return null;
      rejected[k] = v;
    }
    for (const k of ['matchedLaunches','knownPeaks','unknownPeaks','knownExitWindows','unknownExitWindows','rapidDumps']) if (!integer(s[k],c.matchedLaunches)) return null;
    if (s.matchedLaunches !== c.matchedLaunches || s.knownPeaks+s.unknownPeaks !== s.matchedLaunches
      || s.knownExitWindows+s.unknownExitWindows !== s.matchedLaunches || s.rapidDumps > s.knownExitWindows
      || (s.knownPeaks ? !numeric(s.medianObservedPeakMultiple,1,Number.MAX_VALUE) : s.medianObservedPeakMultiple !== null)
      || (s.knownExitWindows ? s.rapidDumpFraction !== s.rapidDumps/s.knownExitWindows : s.rapidDumpFraction !== null)) return null;
    const seen = new Set();
    const matches = i.matches.map((m) => {
      if (!isBase58Address(m.mint) || m.mint === mint || seen.has(m.mint) || !source(m.source)
        || !time(m.launchAt) || m.launchAt < i.windowStart || m.launchAt >= i.cutoff
        || !time(m.observedAt) || m.observedAt < m.launchAt || m.observedAt > i.cutoff || !numeric(m.score,SIMILAR_RULES.threshold,100)) throw Error();
      seen.add(m.mint);
      const components = {},coverage = {};
      for (const d of SIMILAR_DIMENSIONS) {
        if (!numeric(m.components[d],SIMILAR_RULES.dimensionFloor,100) || !numeric(m.coverage[d],SIMILAR_RULES.coverageFloor,1)) throw Error();
        components[d] = m.components[d]; coverage[d] = m.coverage[d];
      }
      if (Math.abs(Object.values(components).reduce((a,b) => a+b,0)/4-m.score) > 1e-8) throw Error();
      const x = m.exactWalletEvidence,o = m.outcome;
      if (typeof x.sameReportedCreator !== 'boolean' || !integer(x.sharedLaunchBuyers,100)
        || ![true,false,null].includes(o.rapidDump) || !integer(o.priceSamples,32)
        || !Array.isArray(o.evidence) || o.evidence.length > 3 || !o.evidence.every(evidence)) throw Error();
      if (o.observedPeakMultiple === null) { if (o.priceSamples !== 0 || o.baselineAt !== null || o.peakAt !== null || o.baselineUsd !== null || o.peakUsd !== null || o.priceSource !== null) throw Error(); }
      else if (!numeric(o.observedPeakMultiple,1,Number.MAX_VALUE) || o.priceSamples < 2 || !time(o.baselineAt) || !time(o.peakAt)
        || o.baselineAt < m.launchAt || o.baselineAt > m.launchAt+300_000 || o.peakAt < o.baselineAt
        || o.peakAt > Math.min(i.cutoff,m.launchAt+DAY) || !numeric(o.baselineUsd,Number.MIN_VALUE,Number.MAX_VALUE)
        || !numeric(o.peakUsd,o.baselineUsd,Number.MAX_VALUE) || o.peakUsd/o.baselineUsd !== o.observedPeakMultiple || !source(o.priceSource)) throw Error();
      if (o.rapidDump === null) { if (o.exitSource !== null || o.exitWindowEnd !== null || o.soldFraction !== null) throw Error(); }
      else if (m.launchAt+90*60_000 > i.cutoff || o.exitWindowEnd !== m.launchAt+90*60_000 || !source(o.exitSource)
        || !numeric(o.soldFraction,0,1) || o.rapidDump !== (o.soldFraction >= .5)) throw Error();
      return { mint:m.mint,launchAt:m.launchAt,observedAt:m.observedAt,source:m.source,score:m.score,components,coverage,
        exactWalletEvidence:{ sameReportedCreator:x.sameReportedCreator,sharedLaunchBuyers:x.sharedLaunchBuyers },
        outcome:{ ...Object.fromEntries(['observedPeakMultiple','priceSamples','baselineAt','peakAt','baselineUsd','peakUsd','priceSource','rapidDump','exitSource','exitWindowEnd','soldFraction'].map((k) => [k,o[k]])),evidence:[...o.evidence] } };
    });
    const summary = Object.fromEntries(['matchedLaunches','knownPeaks','unknownPeaks','medianObservedPeakMultiple','knownExitWindows','unknownExitWindows','rapidDumps','rapidDumpFraction'].map((k) => [k,s[k]]));
    return { schema:1,engine:INDEX_ENGINE,method:SIMILAR_METHOD,profile:i.profile,mint,generatedAt:i.generatedAt,targetLaunchAt:i.targetLaunchAt,
      cutoff:i.cutoff,windowStart:i.windowStart,windowDays:i.windowDays,rules:{...SIMILAR_RULES},summary,matches,
      coverage:{...Object.fromEntries(['storedRecords','eligibleLaunches','matchedLaunches','returnedMatches','duplicateRecords','excludedRecords','evictedCapacity','evictedRetention','collectionStartedAt','oldestRetainedLaunchAt','targetSource','targetObservedAt'].map((k) => [k,c[k]])),rejected} };
  } catch { return null; }
}

export async function lookupSimilarLaunches(mint, settings, { fetcher = fetch,signal,now } = {}) {
  if (settings?.sharedIndexEnabled !== true || !isBase58Address(mint) || signal?.aborted) return null;
  const base = indexEndpoint(settings.sharedIndexUrl); if (!base) return null;
  const controller = new AbortController(),abort = () => controller.abort();
  signal?.addEventListener?.('abort',abort,{once:true}); const timer = setTimeout(abort,2000);
  try {
    const response = await fetcher(new URL(`v1/similar/${mint}`,base).href,{ credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > INDEX_MAX_BYTES) return null;
    const reader = response.body?.getReader(); if (!reader) return null;
    let size = 0; const chunks = [];
    for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length;
      if (size > INDEX_MAX_BYTES) { await reader.cancel(); return null; } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    const result = validateSimilar(JSON.parse(new TextDecoder().decode(bytes)),{mint,settings,now:now ?? Date.now()});
    return result && !controller.signal.aborted && !signal?.aborted ? { ...result,origin:base.origin } : null;
  } catch { return null; }
  finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener?.('abort',abort); }
}
