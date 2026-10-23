// Public, versioned scan projection. Never serialize RPC clients, settings, errors or memory.
import { DEFAULTS } from './constants.js';
import { isBase58Address } from './base58.js';
export const INDEX_SCHEMA = 1;
export const INDEX_ENGINE = 'glass-0.3.2:9649c7c';
export const INDEX_MAX_BYTES = 32_768;
export const INDEX_MAX_AGE_MS = 120_000;
const PROFILE_KEYS = ['slotWindow', 'earlyWindowSec', 'maxWalletProfiles', 'maxPriorLaunches', 'maxOperatorWallets', 'operatorHistory', 'liveTracking', 'jitoLookup'];
export function scanProfileId(settings = {}) {
  return JSON.stringify(PROFILE_KEYS.map((key) => settings[key] ?? DEFAULTS[key]));
}
const text = (v, max = 200) => typeof v === 'string' ? v.slice(0, max) : null;
const number = (v) => Number.isFinite(v) ? v : null;
const pct = (v) => Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const texts = (v) => Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, 32).map((s) => s.slice(0, 500)) : [];
const stages = ['resolve', 'creation', 'launch', 'wallets', 'live', 'operator', 'score'];

export function publishableScan(r) {
  return isBase58Address(r?.mint) && Number.isSafeInteger(r.finishedAt) && r.finishedAt > 0
    && !r.errors?.length && stages.every((s) => r.stages?.[s]?.status === 'done')
    && Number.isFinite(r.score?.score) && r.launch?.blocksRead > 0 && !r.launch.partialEarly;
}

export function publicSnapshot(report, settings = {}) {
  if (!publishableScan(report)) throw new Error('incomplete-scan');
  if (report.launch.blocksRead < (settings.slotWindow ?? DEFAULTS.slotWindow) + 1) throw new Error('incomplete-launch-window');
  const launch = report.launch, history = report.operator, flow = report.live?.summary;
  return {
    schema: INDEX_SCHEMA, engine: INDEX_ENGINE, profile: scanProfileId(settings),
    mint: report.mint, scannedAt: report.finishedAt,
    name: text(report.market?.name || report.creation?.tokenName),
    symbol: text(report.market?.symbol || report.creation?.symbol, 32),
    creator: isBase58Address(report.creation?.creator) ? report.creation.creator : null,
    createdAt: number(report.creation?.createdAt),
    risk: { score: pct(report.score.score), headline: text(report.score.verdict?.headline),
      word: text(report.score.call?.word, 32), confidence: text(report.score.call?.confidence, 16),
      why: texts(report.score.call?.why), gaps: texts(report.score.call?.gaps) },
    launch: { classified: !!launch.classified, devPct: pct(launch.creatorDevBuy?.pct),
      windowPct: pct(launch.window?.pct), bundlePct: launch.classified ? pct(launch.bundle?.pct) : null,
      sniperPct: launch.classified ? pct(launch.snipers?.pct) : null,
      organicPct: launch.classified ? pct(launch.organic?.pct) : null,
      transactions: number(launch.txsRead), blocks: number(launch.blocksRead) },
    history: { enabled: settings.operatorHistory ?? DEFAULTS.operatorHistory,
      totalCreated: number(history?.profile?.totalCreated), atLeast: !!history?.profile?.atLeast,
      rated: number(history?.rating?.rated), score: pct(history?.rating?.score), label: text(history?.rating?.label) },
    flow: { enabled: settings.liveTracking ?? DEFAULTS.liveTracking,
      boughtPct: pct(flow?.clusterBoughtPct), holdsPct: pct(flow?.clusterHoldsPct), soldPct: pct(flow?.clusterSoldPct) },
    coverage: { degraded: Math.max(0, number(report.degraded) || 0), kind: 'bounded-engine-snapshot' },
  };
}

// Reconstruct only known scalar fields; extra fields are never forwarded to the panel.
export function validateSnapshot(input, { mint, settings = {}, now = Date.now(), maxAgeMs = INDEX_MAX_AGE_MS } = {}) {
  if (!input || input.schema !== INDEX_SCHEMA || input.engine !== INDEX_ENGINE || input.profile !== scanProfileId(settings)
    || !isBase58Address(input.mint) || input.mint !== mint || !Number.isSafeInteger(input.scannedAt)
    || input.scannedAt > now + 5000 || input.scannedAt < now - maxAgeMs) return null;
  const shape = {
    schema: 'int', engine: 'text', profile: 'text', mint: 'address', scannedAt: 'int',
    name: 'text?', symbol: 'text?', creator: 'address?', createdAt: 'number?',
    risk: { score: 'pct', headline: 'text?', word: 'text?', confidence: 'text?', why: 'texts', gaps: 'texts' },
    launch: { classified: 'bool', devPct: 'pct?', windowPct: 'pct?', bundlePct: 'pct?', sniperPct: 'pct?', organicPct: 'pct?', transactions: 'number?', blocks: 'number?' },
    history: { enabled: 'bool', totalCreated: 'number?', atLeast: 'bool', rated: 'number?', score: 'pct?', label: 'text?' },
    flow: { enabled: 'bool', boughtPct: 'pct?', holdsPct: 'pct?', soldPct: 'pct?' },
    coverage: { degraded: 'number', kind: 'text' },
  };
  function read(value, schema) {
    if (typeof schema === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
      return Object.fromEntries(Object.entries(schema).map(([key, type]) => [key, read(value[key], type)]));
    }
    if (schema.endsWith('?') && value === null) return null;
    const kind = schema.replace('?', '');
    if (kind === 'texts' && Array.isArray(value) && value.length <= 32 && value.every((v) => typeof v === 'string' && v.length <= 500)) return [...value];
    if (kind === 'text' && typeof value === 'string' && value.length <= 1000) return value;
    if (kind === 'address' && isBase58Address(value)) return value;
    if (kind === 'bool' && typeof value === 'boolean') return value;
    if (['int', 'number', 'pct'].includes(kind) && Number.isFinite(value) && value >= 0
      && (kind !== 'int' || Number.isSafeInteger(value)) && (kind !== 'pct' || value <= 100)) return value;
    throw new Error('invalid snapshot field');
  }
  try { return read(input, shape); } catch { return null; }
}

export function indexEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
    url.pathname = url.pathname.replace(/\/*$/, '/');
    return url;
  } catch { return null; }
}

/** Only the requested public mint leaves the browser. Opt-in is checked before fetch. */
export async function lookupSharedSnapshot(mint, settings, { fetcher = fetch, signal, now } = {}) {
  if (settings?.sharedIndexEnabled !== true || !isBase58Address(mint)) return null;
  const base = indexEndpoint(settings.sharedIndexUrl);
  if (!base) return null;
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener?.('abort', abort, { once: true });
  const timeout = setTimeout(abort, 2000);
  try {
    const response = await fetcher(new URL(`v1/reports/${mint}`, base).href, {
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > INDEX_MAX_BYTES) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > INDEX_MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const snapshot = validateSnapshot(JSON.parse(new TextDecoder().decode(bytes)), { mint, settings, now: now ?? Date.now() });
    return snapshot && !controller.signal.aborted ? { snapshot, origin: base.origin } : null;
  } catch { return null; }
  finally { clearTimeout(timeout); signal?.removeEventListener?.('abort', abort); }
}

export function snapshotReport(hit) {
  return { mint: hit.snapshot.mint, stage: 'score', finishedAt: hit.snapshot.scannedAt,
    sharedIndex: { ...hit, trust: 'configured operator; not independently verified' }, errors: [], stages: {} };
}
