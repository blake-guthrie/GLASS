import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './store.mjs';
import { scanProfileId, INDEX_ENGINE, INDEX_MAX_BYTES } from '../src/lib/shared-index.js';
import { extractLaunchRecord, validLaunchRecord, validateObservation, compareLaunches, observedOutcome, summarizeOutcomes, SIMILAR_METHOD, SIMILAR_RULES, DAY, lexical } from '../src/lib/scan/similar.js';

export const HISTORY_DEFAULTS = { source: 'worker', maxRecords: 2000, retentionDays: 90, queryDays: 30 };
const keyOf = (r) => JSON.stringify([r.source,r.profile,r.mint]);
const order = (a,b) => a.observedAt-b.observedAt || lexical(a.source,b.source);

/** Owned by the existing worker lock. Separate retention from the short-lived scan cache. */
export class LaunchHistory {
  constructor(directory, config = {}, now = Date.now) {
    this.file = path.join(directory,'history.json'); this.now = now; this.config = { ...HISTORY_DEFAULTS,...config };
    const c = this.config;
    if (Object.keys(config).some((k) => !(k in HISTORY_DEFAULTS)) || !/^[a-zA-Z0-9._:-]{1,96}$/.test(c.source)
      || !Number.isInteger(c.maxRecords) || c.maxRecords < 1 || c.maxRecords > 5000
      || !Number.isInteger(c.retentionDays) || c.retentionDays < 1 || c.retentionDays > 90
      || !Number.isInteger(c.queryDays) || c.queryDays < 1 || c.queryDays > c.retentionDays) throw new Error('invalid-history-config');
  }
  async open() {
    try {
      if ((await fs.stat(this.file)).size > 164_000_000) throw new Error('history-file-too-large');
      this.state = JSON.parse(await fs.readFile(this.file,'utf8'));
      const s = this.state;
      if (s.version !== 1 || !s.records || Array.isArray(s.records) || Object.keys(s.records).length > 5000
        || !Number.isSafeInteger(s.startedAt) || s.startedAt <= 0
        || !['evictedCapacity','evictedRetention'].every((k) => Number.isSafeInteger(s[k]) && s[k] >= 0)
        || Object.entries(s.records).some(([k,r]) => k !== keyOf(r) || !validLaunchRecord(r) || r.observedAt > this.now())) throw new Error('invalid-history-state');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // Never silently overwrite corrupt evidence.
      this.state = { version: 1, startedAt: this.now(), evictedCapacity: 0, evictedRetention: 0, records: {} };
    }
    await this.prune(); return this;
  }
  async save() { await atomicJson(this.file,this.state); }
  async prune(persist = true) {
    let changed = false;
    for (const [k,r] of Object.entries(this.state.records)) if (r.launchAt < this.now()-this.config.retentionDays*DAY) {
      delete this.state.records[k]; this.state.evictedRetention++; changed = true;
    }
    const rows = Object.entries(this.state.records).sort((a,b) => a[1].launchAt-b[1].launchAt || lexical(a[0],b[0]));
    for (const [k] of rows.slice(0,Math.max(0,rows.length-this.config.maxRecords))) {
      delete this.state.records[k]; this.state.evictedCapacity++; changed = true;
    }
    if (changed && persist) await this.save();
  }
  async archive(report, settings, quoteMint) {
    const record = extractLaunchRecord(report,{ settings,source:this.config.source,quoteMint });
    await this.importBatch({ records: [record] }); return record;
  }
  /** Atomic validated batch; updates address an exact source/profile/mint record. */
  async importBatch({ records = [], updates = [] } = {}) {
    if (!Array.isArray(records) || !Array.isArray(updates) || records.length+updates.length > 500) throw new Error('invalid-import-batch');
    const next = structuredClone(this.state.records);
    const mergeObservations = (record, observations) => {
      if (!Array.isArray(observations) || observations.length > 64) throw new Error('invalid-observations');
      for (const raw of observations) {
        const o = validateObservation(raw,record,this.now());
        const existing = record.observations.find((v) => v.kind === o.kind && v.source === o.source && v.at === o.at);
        if (existing && JSON.stringify(existing) !== JSON.stringify(o)) throw new Error('conflicting-observation');
        if (!existing) record.observations.push(o);
      }
      if (record.observations.length > 32) throw new Error('observation-capacity');
      record.observations.sort((a,b) => a.at-b.at || lexical(a.source,b.source) || lexical(a.kind,b.kind));
    };
    for (const raw of records) {
      if (!validLaunchRecord(raw) || raw.observedAt > this.now()) throw new Error('invalid-history-record');
      const r = structuredClone(raw), key = keyOf(r), old = next[key];
      if (old && old.launchAt !== r.launchAt) throw new Error('conflicting-launch-time');
      // Preserve the earliest report's fingerprint. Later reports contribute only observations.
      const base = old && old.observedAt <= r.observedAt ? old : { ...r,observations:[] };
      mergeObservations(base,[...(old?.observations || []),...r.observations]); next[key] = base;
    }
    for (const u of updates) {
      const record = next[keyOf(u)]; if (!record) throw new Error('unknown-history-record');
      mergeObservations(record,u.observations);
    }
    const previous = this.state;
    this.state = { ...previous,records:next };
    try { await this.prune(false); await this.save(); } catch (e) { this.state = previous; throw e; }
    return { records: Object.keys(this.state.records).length };
  }
  query(mint, settings = {}) {
    const now = this.now(), profile = scanProfileId(settings), all = Object.values(this.state.records);
    const target = all.filter((r) => r.mint === mint && r.profile === profile && r.observedAt <= now).sort(order)[0];
    if (!target) return null;
    const cutoff = Math.min(now,target.launchAt), start = cutoff-this.config.queryDays*DAY;
    const candidates = all.filter((r) => r.mint !== mint && r.profile === profile && r.launchAt >= start
      && r.launchAt < cutoff && r.observedAt <= cutoff).sort(order);
    const unique = new Map(); for (const r of candidates) if (!unique.has(r.mint)) unique.set(r.mint,r);
    const evaluated = [...unique.values()].map((record) => ({ record,comparison:compareLaunches(target,record) }));
    const matched = evaluated.filter((v) => v.comparison.accepted).sort((a,b) => b.comparison.score-a.comparison.score
      || b.record.launchAt-a.record.launchAt || lexical(a.record.mint,b.record.mint));
    const rejected = {}; for (const { comparison:c } of evaluated) for (const reason of c.reasons) rejected[reason] = (rejected[reason] || 0)+1;
    const result = { schema:1,engine:INDEX_ENGINE,method:SIMILAR_METHOD,profile,mint,generatedAt:now,
      targetLaunchAt:target.launchAt,cutoff,windowStart:start,windowDays:this.config.queryDays,rules:SIMILAR_RULES,
      coverage:{ storedRecords:all.length,eligibleLaunches:unique.size,matchedLaunches:matched.length,returnedMatches:Math.min(20,matched.length),
        duplicateRecords:candidates.length-unique.size,excludedRecords:all.length-candidates.length,
        evictedCapacity:this.state.evictedCapacity,evictedRetention:this.state.evictedRetention,
        collectionStartedAt:this.state.startedAt,oldestRetainedLaunchAt:all.length ? Math.min(...all.map((r) => r.launchAt)) : null,
        targetSource:target.source,targetObservedAt:target.observedAt,rejected },
      summary:summarizeOutcomes(matched.map((v) => v.record),cutoff),
      matches:matched.slice(0,20).map(({record:r,comparison:c}) => ({ mint:r.mint,launchAt:r.launchAt,observedAt:r.observedAt,source:r.source,
        score:c.score,components:c.components,coverage:c.coverage,exactWalletEvidence:c.exactWalletEvidence,outcome:observedOutcome(r,cutoff) })),
      trust:'configured operator observations; behavioral resemblance does not establish identity',
      scope:'bounded retained launches; not all launches; missing outcomes are unknown' };
    while (result.matches.length && Buffer.byteLength(JSON.stringify(result)) > INDEX_MAX_BYTES) {
      result.matches.pop(); result.coverage.returnedMatches = result.matches.length;
    }
    return result;
  }
}
