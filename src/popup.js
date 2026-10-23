import { DEFAULTS } from './lib/constants.js';
import { indexEndpoint } from './lib/shared-index.js';

const $ = (id) => document.getElementById(id);
const fields = ['rpcUrl', 'sharedIndexUrl', 'slotWindow', 'earlyWindowSec', 'maxWalletProfiles', 'maxPriorLaunches'];
const checks = ['enabled', 'operatorHistory', 'liveTracking', 'jitoLookup', 'sharedIndexEnabled'];

async function load() {
  const r = await chrome.storage.sync.get('settings');
  const s = { enabled: true, ...DEFAULTS, ...(r?.settings || {}) };
  for (const f of fields) $(f).value = s[f] ?? '';
  for (const c of checks) $(c).checked = s[c] !== false;
  refreshStats();
}

function collect() {
  const s = {};
  for (const f of fields) {
    const v = $(f).value.trim();
    s[f] = f === 'rpcUrl' ? v || DEFAULTS.rpcUrl : f === 'sharedIndexUrl' ? v : Number(v);
  }
  for (const c of checks) s[c] = $(c).checked;
  return s;
}

function ensureHostPermission(...urls) {
  try {
    const origins = [...new Set(urls.map((url) => new URL(url).origin + '/*'))];
    // Invoke request in the click gesture, before any await (including contains).
    return chrome.permissions.request({ origins });
  } catch {
    return Promise.resolve(false);
  }
}

$('save').addEventListener('click', async () => {
  const s = collect();
  if (s.sharedIndexEnabled) {
    const endpoint = indexEndpoint(s.sharedIndexUrl);
    if (!endpoint) return status('saved', 'Index URL must be HTTPS (or localhost HTTP), without credentials or query parameters.', 'bad');
  }
  if (!(await ensureHostPermission(s.rpcUrl, ...(s.sharedIndexEnabled ? [s.sharedIndexUrl] : [])))) {
    status('saved', 'Permission for the configured hosts was not granted.', 'bad');
    return;
  }
  await chrome.storage.sync.set({ settings: s });
  status('saved', 'Saved', 'ok');
  setTimeout(() => status('saved', ''), 1500);
});

$('useHelius').addEventListener('click', () => {
  const k = $('heliusKey').value.trim();
  if (!k) return;
  $('rpcUrl').value = `https://mainnet.helius-rpc.com/?api-key=${k}`;
  $('heliusKey').value = '';
});

$('testRpc').addEventListener('click', async () => {
  const url = $('rpcUrl').value.trim() || DEFAULTS.rpcUrl;
  status('rpcStatus', 'testing…');
  if (!(await ensureHostPermission(url))) return status('rpcStatus', 'host permission denied', 'bad');
  const r = await chrome.runtime.sendMessage({ type: 'testRpc', url });
  if (r?.ok) status('rpcStatus', `ok · ${r.profile} · slot ${r.slot} · ${r.ms}ms · getBlock ${r.getBlock ? 'yes' : 'no'}${r.indexed === false ? ' · token-account queries via ATA' : ''}`, 'ok');
  else status('rpcStatus', `failed: ${r?.error || 'unknown'}`, 'bad');
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  refreshStats();
});
$('clearMemory').addEventListener('click', async () => {
  if (!confirm('Wipe the local operator memory (wallet ↔ launch index)?')) return;
  await chrome.runtime.sendMessage({ type: 'clearMemory' });
  refreshStats();
});
$('exportMemory').addEventListener('click', async () => {
  const data = await chrome.runtime.sendMessage({ type: 'exportMemory' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `glass-operator-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

async function refreshStats() {
  const r = await chrome.runtime.sendMessage({ type: 'stats' }).catch(() => null);
  if (!r || r.error) {
    $('stats').textContent = 'Background worker not responding — open chrome://extensions → GLASS → "Errors" / "service worker" to see why.';
    $('stats').style.color = '#ff8a94';
    return;
  }
  $('stats').style.color = '';
  $("stats").textContent = `${r.memory?.tokens ?? 0} tokens · ${r.memory?.wallets ?? 0} wallets · ${r.memory?.reputations ?? 0} reputations remembered · ${r.cachedReports} cached reports${r.inflight ? ` · ${r.inflight} scan running` : ''}`;
}

function status(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}

load();
