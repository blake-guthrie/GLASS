// Service worker: runs scans on behalf of content scripts, streams progressive reports over a port,
// caches results, and keeps the operator memory.
import { RpcClient } from './lib/rpc.js';
import { runScan } from './lib/scan/pipeline.js';
import { trackCluster } from './lib/scan/live.js';
import { LiveWatcher, wsUrlFor } from './lib/livewatch.js';
import { computeScore } from './lib/scan/score.js';
import { ChromeStore, TtlCache, OperatorMemory } from './lib/cache.js';
import { DEFAULTS } from './lib/constants.js';
import { lookupSharedSnapshot, snapshotReport } from './lib/shared-index.js';
import { lookupSimilarLaunches } from './lib/similar-index.js';

const store = new ChromeStore('local');
const CACHE_PREFIX = 'report:v3:'; // bump when the report shape changes so old cached reports can't break the panel
const reportCache = new TtlCache(store, CACHE_PREFIX);
const memory = new OperatorMemory(store);
const MAX_CACHED_REPORTS = 40;

/** Smaller copy of a report for the cache: drop per-transaction event lists, keep every summary. */
function trimReport(r) {
  const c = { ...r };
  if (c.live) c.live = { ...c.live, events: (c.live.events || []).slice(0, 40) };
  if (c.wallets) c.wallets = { ...c.wallets, profiles: (c.wallets.profiles || []).map(({ programsSeen, ...p }) => p) };
  if (c.launch) c.launch = { ...c.launch, buyers: (c.launch.buyers || []).slice(0, 60) };
  return c;
}

async function evictOldReports() {
  try {
    const keys = await store.keys(CACHE_PREFIX);
    const rows = [];
    for (const k of keys) {
      const v = await store.get(k);
      if (!v || (v.exp && v.exp < Date.now())) await store.remove(k);
      else rows.push({ k, exp: v.exp || 0 });
    }
    rows.sort((a, b) => a.exp - b.exp);
    for (const r of rows.slice(0, Math.max(0, rows.length - MAX_CACHED_REPORTS))) await store.remove(r.k);
    // old-schema cache entries from previous versions
    for (const k of await store.keys('report:')) if (!k.startsWith(CACHE_PREFIX)) await store.remove(k);
  } catch (e) {
    console.debug('[GLASS] cache eviction failed', e);
  }
}
evictOldReports();
const inflight = new Map(); // key → { report, ports:Set, abort:{aborted} }

async function getSettings() {
  const r = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(r?.settings || {}) };
}

function makeRpc(settings) {
  return new RpcClient(settings.rpcUrl || DEFAULTS.rpcUrl);
}

function broadcast(job, msg) {
  for (const port of job.ports) {
    try {
      port.postMessage(msg);
    } catch {
      job.ports.delete(port);
    }
  }
}

async function startScan(key, identifier, hintIsMint, port, force) {
  const existing = inflight.get(key);
  if (existing) {
    existing.ports.add(port);
    if (existing.report) port.postMessage({ type: 'stage', stage: existing.report.stage, report: existing.report, joined: true });
    return;
  }
  const settings = await getSettings();
  const withSimilar = async (report, signal) => {
    if (!settings.sharedIndexEnabled || force || !report?.mint || signal?.aborted) return report;
    const similarLaunches = await lookupSimilarLaunches(report.mint, settings, { signal });
    return similarLaunches && !signal?.aborted ? { ...report, similarLaunches } : report;
  };
  let servedCached = false;
  if (!force) {
    const cached = await reportCache.get(key);
    if (cached) {
      port.postMessage({ type: 'done', report: cached, cached: true });
      // Still refresh in the background if older than 60s — silently, so the panel doesn't flicker back
      // to a half-empty report; the fresh one replaces it when complete.
      if (Date.now() - (cached.finishedAt || 0) < 60_000) {
        const enriched = await withSimilar(cached);
        if (enriched !== cached) { try { port.postMessage({ type: 'done', report: enriched, cached: true }); } catch {} }
        return;
      }
      servedCached = true;
    }
  }
  const job = { report: null, ports: new Set([port]), abort: { aborted: false }, silentUntilDone: servedCached };
  inflight.set(key, job);
  const rpc = makeRpc(settings);
  const heartbeat = setInterval(() => broadcast(job, { type: 'tick', rpcCalls: rpc.totalCalls, degraded: rpc.totalDegraded }), 15_000);
  try {
    if (!force && !servedCached && hintIsMint) {
      const hit = await lookupSharedSnapshot(identifier, settings, { signal: job.abort });
      if (job.abort.aborted) return;
      if (hit) {
        job.report = snapshotReport(hit);
        broadcast(job, { type: 'done', report: job.report, shared: true });
        const enriched = await withSimilar(job.report, job.abort);
        if (!job.abort.aborted && enriched !== job.report) { job.report = enriched; broadcast(job, { type: 'done', report: enriched, shared: true }); }
        return; // Shared snapshots never enter the local report cache or operator memory.
      }
    }
    const report = await runScan(rpc, identifier, {
      settings,
      memory,
      hintIsMint,
      signal: job.abort,
      log: (m) => console.debug('[GLASS]', m),
      emit: (stage, r) => {
        job.report = r;
        r.degraded = rpc.totalDegraded;
        if (job.silentUntilDone && stage !== 'done') return;
        broadcast(job, { type: stage === 'done' ? 'done' : 'stage', stage, report: r });
      },
    });
    if (report?.mint) {
      // Caching must never turn a successful scan into an error (storage quota, etc.)
      try {
        const slim = trimReport(report);
        const ttl = settings.cacheTtlMs || DEFAULTS.cacheTtlMs;
        await reportCache.set(key, slim, ttl);
        if (report.mint !== key) await reportCache.set(report.mint, slim, ttl);
        evictOldReports();
      } catch (e) {
        console.debug('[GLASS] cache write failed', e);
      }
      const enriched = await withSimilar(report, job.abort);
      if (!job.abort.aborted && enriched !== report) { job.report = enriched; broadcast(job, { type: 'done', report: enriched }); }
    }
  } catch (e) {
    broadcast(job, { type: 'error', message: e?.message || String(e) });
  } finally {
    clearInterval(heartbeat);
    inflight.delete(key);
  }
}

const watchers = new Map(); // port → LiveWatcher
function stopWatch(port) {
  const w = watchers.get(port);
  if (w) {
    w.stop();
    watchers.delete(port);
  }
}
async function startWatch(port, msg) {
  stopWatch(port);
  const settings = await getSettings();
  const wsUrl = wsUrlFor(settings.rpcUrl || DEFAULTS.rpcUrl);
  if (!wsUrl || !msg.mint || !Array.isArray(msg.wallets) || !msg.wallets.length) return;
  const w = new LiveWatcher({
    wsUrl,
    mint: msg.mint,
    tokenProgram: msg.tokenProgram,
    wallets: msg.wallets,
    curve: msg.curve || null,
    log: (m) => console.debug('[GLASS live]', m),
    onEvent: (ev) => {
      try {
        port.postMessage({ type: 'live-event', ev });
      } catch {
        stopWatch(port);
      }
    },
    onStatus: (st) => {
      try {
        port.postMessage({ type: 'live-status', status: st });
      } catch {
        stopWatch(port);
      }
    },
  });
  w.prime(msg.balances || []);
  watchers.set(port, w);
  await w.start();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'glass-scan') return;
  let key = null;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'scan' && msg.identifier) {
      key = msg.identifier;
      stopWatch(port);
      startScan(key, msg.identifier, !!msg.hintIsMint, port, !!msg.force).catch((e) => {
        try {
          port.postMessage({ type: 'error', message: e?.message || String(e) });
        } catch {
          /* port gone */
        }
      });
    } else if (msg?.type === 'watch') {
      startWatch(port, msg).catch((e) => console.debug('[GLASS] watch failed', e));
    } else if (msg?.type === 'unwatch') stopWatch(port);
  });
  port.onDisconnect.addListener(() => {
    stopWatch(port);
    const job = key && inflight.get(key);
    if (job) {
      job.ports.delete(port);
      // Let the scan finish (another tab may ask for it), unless nobody is listening for 30s.
      setTimeout(() => {
        if (inflight.get(key) === job && job.ports.size === 0) job.abort.aborted = true;
      }, 30_000);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'testRpc': {
        const rpc = new RpcClient(msg.url, { fallbacks: [] });
        const t = Date.now();
        try {
          const slot = await rpc.getSlot();
          const block = await rpc.getBlockAccounts(slot - 20);
          return { ok: true, slot, ms: Date.now() - t, getBlock: !!block, profile: rpc.profile?.name, indexed: rpc.indexedMethods };
        } catch (e) {
          const blocked = /403/.test(e.message);
          return { ok: false, error: blocked ? `${e.message} — this endpoint rejects browser extensions; GLASS will fall back to publicnode automatically` : e.message, ms: Date.now() - t };
        }
      }
      case 'stats': {
        const mem = await memory.stats();
        const reports = (await store.keys(CACHE_PREFIX)).length;
        return { memory: mem, cachedReports: reports, inflight: inflight.size };
      }
      case 'clearCache': {
        await reportCache.clear();
        return { ok: true };
      }
      case 'clearMemory': {
        await memory.clear();
        return { ok: true };
      }
      case 'exportMemory':
        return memory.export();
      case 'getReport': {
        const r = await reportCache.get(msg.key);
        return r || null;
      }
      case 'refreshLive': {
        // Re-track the flagged cluster only (balances + recent sells) — the cheap part of a scan — so the
        // panel's insider-flow section stays current while the token page is open.
        const settings = await getSettings();
        const rpc = makeRpc(settings);
        const { mint, cluster, snipers, others, launchTimeSec, supply, tokenProgram } = msg;
        if (!mint || !Array.isArray(cluster) || !cluster.length) return { error: 'nothing to track' };
        const live = await trackCluster(rpc, mint, cluster.slice(0, 25), { launchTimeSec, supply, tokenProgram, maxWallets: 25, txsPerWallet: 8, others: others || [] });
        if (snipers?.length) {
          const bal = new Map(live.otherHoldings.map((h) => [h.wallet, h.now]));
          const bought = snipers.reduce((s, b) => s + (b.tokens || 0), 0);
          const now = snipers.reduce((s, b) => s + (bal.get(b.wallet) || 0), 0);
          live.snipers = { count: snipers.length, boughtPct: (bought / supply) * 100, holdsPct: (now / supply) * 100, exitedShare: bought ? Math.min(1, 1 - now / bought) : null };
        }
        let score = null;
        if (msg.scoreInput?.launch) {
          try {
            score = computeScore({ ...msg.scoreInput, live });
          } catch {
            score = null;
          }
        }
        return { live: { ...live, events: (live.events || []).slice(-60) }, score, rpcCalls: rpc.totalCalls, at: Date.now() };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: e?.message || String(e) }));
  return true; // async
});
