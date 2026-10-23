import { runScan } from '../src/lib/scan/pipeline.js';
import { DEFAULTS } from '../src/lib/constants.js';
import { isBase58Signature } from '../src/lib/base58.js';
import { publicSnapshot, validateSnapshot } from '../src/lib/shared-index.js';
import { creationMints, mintAuthority, supportsQuote } from './feed.mjs';

export const WORKER_DEFAULTS = { pageSize: 100, pagesPerTick: 2, signaturesPerTick: 20,
  maxPending: 2000, maxJobs: 5000, maxAttempts: 5, retryMs: 5000,
  pollMs: 3000, retentionMs: 86_400_000, scanDelayMs: 65_000 };

export class PrescanWorker {
  constructor({ rpc, store, settings = {}, config = {}, scan = runScan, now = Date.now }) {
    this.rpc = rpc; this.store = store; this.scan = scan; this.now = now;
    this.settings = { ...DEFAULTS, ...settings }; this.config = { ...WORKER_DEFAULTS, ...config };
    const scanBounds = { slotWindow: 20, earlyWindowSec: 300, maxWalletProfiles: 100, maxPriorLaunches: 30, maxOperatorWallets: 50 };
    const scanKeys = [...Object.keys(scanBounds), 'operatorHistory', 'liveTracking', 'jitoLookup'];
    if (Object.keys(settings).some((key) => !scanKeys.includes(key))) throw new Error('unknown-scan-option');
    for (const [key, max] of Object.entries(scanBounds)) if (!Number.isInteger(this.settings[key]) || this.settings[key] < 0 || this.settings[key] > max) throw new Error(`invalid-scan-option:${key}`);
    for (const key of ['operatorHistory', 'liveTracking', 'jitoLookup']) if (typeof this.settings[key] !== 'boolean') throw new Error(`invalid-scan-option:${key}`);
    if (Object.keys(config).some((key) => !(key in WORKER_DEFAULTS) && key !== 'startSignature')) throw new Error('unknown-worker-option');
    for (const [key, value] of Object.entries(WORKER_DEFAULTS)) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] < (key === 'scanDelayMs' ? 0 : 1)) throw new Error(`invalid-worker-option:${key}`);
    }
    if (this.config.pageSize > 1000 || this.config.pagesPerTick > 100 || this.config.maxPending < this.config.pageSize
      || this.config.maxPending > 100_000 || this.config.maxJobs > 100_000 || this.config.maxAttempts > 100) throw new Error('worker-bounds-exceeded');
  }
  async initialize() {
    this.authority = await mintAuthority();
    const state = this.store.state;
    if (state.authority && state.authority !== this.authority) throw new Error('state-authority-mismatch');
    state.authority = this.authority;
    if (this.config.startSignature && !state.initialized) {
      if (!isBase58Signature(this.config.startSignature)) throw new Error('invalid-start-signature');
      state.checkpoint = this.config.startSignature; state.initialized = true;
    }
    for (const job of Object.values(state.jobs)) if (job.status === 'running') job.status = 'queued';
    await this.store.save();
  }
  status() {
    const s = this.store.state, jobs = Object.values(s.jobs), pending = Object.values(s.pending);
    const oldest = jobs.filter((j) => j.status === 'queued').map((j) => j.discoveredAt).sort((a,b) => a-b)[0];
    return { schema: 1, startedAt: s.startedAt, lastPollAt: s.lastPollAt,
      catchingUp: !!s.cycle, pendingSignatures: pending.filter((j) => j.status !== 'failed').length,
      failedSignatures: pending.filter((j) => j.status === 'failed').length,
      queuedMints: jobs.filter((j) => ['queued','running'].includes(j.status)).length,
      failedScans: jobs.filter((j) => j.status === 'failed').length,
      unsupportedQuotes: jobs.filter((j) => j.status === 'unsupported-quote').length,
      published: jobs.filter((j) => j.status === 'published').length,
      lagSeconds: oldest ? Math.max(0, Math.floor((this.now()-oldest)/1000)) : 0,
      cursorGaps: s.cursorGaps, lastError: s.lastError,
      coverage: 'bounded polling; provider retention and worker capacity can leave gaps' };
  }
  async poll(signal) {
    const s = this.store.state, c = this.config;
    if (signal?.aborted) return;
    if (!s.initialized) {
      const rows = await this.rpc.getSignaturesForAddress(this.authority, { limit: 1 });
      this.validatePage(rows, 1);
      // Explicit start-now boundary. Existing history is not silently advertised as scanned.
      s.checkpoint = rows[0]?.signature || null; s.initialized = true;
      s.lastPollAt = this.now(); await this.store.save(); return;
    }
    for (let page = 0; page < c.pagesPerTick && !signal?.aborted; page++) {
      if (Object.keys(s.pending).length + c.pageSize > c.maxPending || Object.keys(s.jobs).length >= c.maxJobs) { s.lastError = 'backpressure'; break; }
      s.cycle ||= { target: s.checkpoint, head: null, before: null };
      const cycle = s.cycle;
      const rows = await this.rpc.getSignaturesForAddress(this.authority, { limit: c.pageSize, ...(cycle.before ? { before: cycle.before } : {}) });
      this.validatePage(rows, c.pageSize);
      s.lastPollAt = this.now(); s.lastError = null;
      if (!cycle.head) cycle.head = rows[0]?.signature || null;
      const boundary = cycle.target ? rows.findIndex((r) => r.signature === cycle.target) : -1;
      const fresh = boundary >= 0 ? rows.slice(0, boundary) : rows;
      for (const row of fresh) {
        if (s.seen.includes(row.signature) || s.pending[row.signature]) continue;
        if (row.err != null) { this.remember(row.signature); continue; }
        s.pending[row.signature] = { signature: row.signature, status: 'queued', attempts: 0, nextAt: 0 };
      }
      if (boundary >= 0 || rows.length < c.pageSize) {
        if (cycle.target && boundary < 0) { s.cursorGaps++; s.lastError = 'checkpoint-not-visible-possibly-pruned'; }
        s.checkpoint = cycle.head || s.checkpoint; s.cycle = null;
        await this.store.save(); break;
      }
      const next = rows.at(-1).signature;
      if (next === cycle.before) throw new Error('pagination-stalled');
      cycle.before = next; await this.store.save();
    }
    await this.store.save();
  }
  validatePage(rows, limit) {
    if (!Array.isArray(rows) || rows.length > limit || rows.some((r) => !isBase58Signature(r?.signature))) throw new Error('invalid-signature-page');
  }
  remember(signature) {
    const seen = this.store.state.seen; seen.push(signature);
    if (seen.length > this.config.maxPending) seen.splice(0, seen.length-this.config.maxPending);
  }
  failure(job, reason) {
    job.attempts++; job.reason = reason;
    job.status = job.attempts >= this.config.maxAttempts ? 'failed' : 'queued';
    job.nextAt = this.now() + Math.min(300_000, this.config.retryMs * 2 ** Math.min(job.attempts-1, 10));
  }
  async discover(signal) {
    const s = this.store.state;
    const due = Object.values(s.pending).filter((j) => j.status === 'queued' && j.nextAt <= this.now()).slice(0, this.config.signaturesPerTick);
    for (const pending of due) {
      if (signal?.aborted) break;
      try {
        const tx = await this.rpc.getTransaction(pending.signature);
        if (!tx?.meta || tx.transaction?.signatures?.[0] !== pending.signature) throw new Error('transaction-unavailable');
        const coins = creationMints(tx, this.authority);
        const added = coins.filter((coin) => !s.jobs[coin.mint]);
        if (Object.keys(s.jobs).length + added.length > this.config.maxJobs) { s.lastError = 'backpressure'; await this.store.save(); break; }
        for (const coin of added) s.jobs[coin.mint] = { ...coin, signature: pending.signature,
          status: coin.supportedQuote ? 'queued' : 'unsupported-quote',
          reason: coin.supportedQuote ? null : 'engine-requires-SOL-quote',
          discoveredAt: this.now(), attempts: 0,
          nextAt: Math.max(this.now(), (coin.blockTime || this.now()/1000)*1000 + Math.max(this.config.scanDelayMs, this.settings.earlyWindowSec * 1000)) };
        this.remember(pending.signature); delete s.pending[pending.signature];
      } catch { this.failure(pending, 'transaction-unavailable-or-invalid'); }
      await this.store.save();
    }
  }
  async scanNext(signal) {
    const jobs = Object.values(this.store.state.jobs);
    const job = jobs.find((j) => j.status === 'queued' && j.nextAt <= this.now());
    if (!job || signal?.aborted) return;
    const existing = await this.store.readReport(job.mint);
    if (validateSnapshot(existing, { mint: job.mint, settings: this.settings, now: this.now(), maxAgeMs: this.config.retentionMs })) {
      job.status = 'published'; job.publishedAt = existing.scannedAt; await this.store.save(); return;
    }
    job.status = 'running'; await this.store.save();
    try {
      const report = await this.scan(this.rpc, job.mint, { settings: this.settings, hintIsMint: true, signal });
      if (signal?.aborted) { job.status = 'queued'; await this.store.save(); return; }
      if (report?.mint !== job.mint) throw new Error('scan-mint-mismatch');
      const snapshot = publicSnapshot(report, this.settings);
      if (!validateSnapshot(snapshot, { mint: job.mint, settings: this.settings, now: this.now() })) throw new Error('invalid-snapshot');
      await this.store.writeReport(snapshot); // publish first; restart detects this if state save is interrupted
      job.status = 'published'; job.publishedAt = snapshot.scannedAt; job.reason = null;
    } catch {
      if (signal?.aborted) job.status = 'queued';
      else this.failure(job, 'scan-incomplete-or-failed');
    }
    await this.store.save();
  }
  async retryFailed() {
    for (const job of [...Object.values(this.store.state.pending), ...Object.values(this.store.state.jobs)]) {
      if (['failed','unsupported-quote'].includes(job.status)) {
        if (job.quoteMint && !supportsQuote(job.quoteMint)) continue; // upgrade engine/schema first
        if (job.quoteMint) job.supportedQuote = true;
        job.status = 'queued'; job.attempts = 0; job.nextAt = 0;
      }
    }
    await this.store.save();
  }
  async tick(signal) {
    if (this.running) throw new Error('tick-already-running');
    this.running = true;
    try {
      for (const [mint, job] of Object.entries(this.store.state.jobs)) {
        if (job.status === 'published' && this.now()-(job.publishedAt || 0) > this.config.retentionMs) {
          await this.store.removeReport(mint); delete this.store.state.jobs[mint];
        }
      }
      try { await this.poll(signal); } catch { this.store.state.lastError = 'feed-request-failed'; await this.store.save(); }
      await this.discover(signal); await this.scanNext(signal);
      return this.status();
    } finally { this.running = false; }
  }
}
