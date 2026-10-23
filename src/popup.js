import { api, backgroundHelp, requestRpcPermission } from './lib/webext.js';
import { DEFAULTS } from './lib/constants.js';

const $ = (id) => document.getElementById(id);
const fields = ['rpcUrl', 'slotWindow', 'earlyWindowSec', 'maxWalletProfiles', 'maxPriorLaunches'];
const checks = ['enabled', 'operatorHistory', 'liveTracking', 'jitoLookup'];

async function load() {
  const r = await api.storage.sync.get('settings');
  const s = { enabled: true, ...DEFAULTS, ...(r?.settings || {}) };
  for (const f of fields) $(f).value = s[f] ?? '';
  for (const c of checks) $(c).checked = s[c] !== false;
  refreshStats();
}

function collect() {
  const s = {};
  for (const f of fields) {
    const v = $(f).value.trim();
    s[f] = f === 'rpcUrl' ? v || DEFAULTS.rpcUrl : Number(v);
  }
  for (const c of checks) s[c] = $(c).checked;
  return s;
}

$('save').addEventListener('click', async () => {
  const s = collect();
  if (s.rpcUrl && !(await requestRpcPermission(s.rpcUrl))) {
    status('saved', 'Permission for that RPC host was not granted.', 'bad');
    return;
  }
  await api.storage.sync.set({ settings: s });
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
  if (!(await requestRpcPermission(url))) return status('rpcStatus', 'host permission denied', 'bad');
  const r = await api.runtime.sendMessage({ type: 'testRpc', url });
  if (r?.ok) status('rpcStatus', `ok · ${r.profile} · slot ${r.slot} · ${r.ms}ms · getBlock ${r.getBlock ? 'yes' : 'no'}${r.indexed === false ? ' · token-account queries via ATA' : ''}`, 'ok');
  else status('rpcStatus', `failed: ${r?.error || 'unknown'}`, 'bad');
});

$('clearCache').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'clearCache' });
  refreshStats();
});
$('clearMemory').addEventListener('click', async () => {
  if (!confirm('Wipe the local operator memory (wallet ↔ launch index)?')) return;
  await api.runtime.sendMessage({ type: 'clearMemory' });
  refreshStats();
});
$('exportMemory').addEventListener('click', async () => {
  const data = await api.runtime.sendMessage({ type: 'exportMemory' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `glass-operator-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

async function refreshStats() {
  const r = await api.runtime.sendMessage({ type: 'stats' }).catch(() => null);
  if (!r || r.error) {
    $('stats').textContent = `Background not responding. ${backgroundHelp}`;
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
