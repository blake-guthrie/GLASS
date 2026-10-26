import { DEFAULTS } from './lib/constants.js';

const $ = (id) => document.getElementById(id);
const fields = ['rpcUrl', 'slotWindow', 'earlyWindowSec', 'maxWalletProfiles', 'maxPriorLaunches'];
const checks = ['enabled', 'operatorHistory', 'liveTracking', 'jitoLookup'];

async function getStorageSettings() {
  try {
    if (chrome.storage?.sync) {
      const r = await chrome.storage.sync.get('settings');
      if (r?.settings) return r.settings;
    }
  } catch {
    // fallback if sync is unavailable or throws in unauthenticated Firefox profile
  }
  try {
    const r = await chrome.storage.local.get('settings');
    return r?.settings || {};
  } catch {
    return {};
  }
}

async function setStorageSettings(s) {
  try {
    if (chrome.storage?.sync) {
      await chrome.storage.sync.set({ settings: s });
      return;
    }
  } catch {
    // fallback to local storage
  }
  await chrome.storage.local.set({ settings: s });
}

async function load() {
  const settings = await getStorageSettings();
  const s = { enabled: true, ...DEFAULTS, ...settings };
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

async function ensureHostPermission(url) {
  let origin;
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    return false;
  }
  const have = await chrome.permissions.contains({ origins: [origin] });
  if (have) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$('save').addEventListener('click', async () => {
  const s = collect();
  if (s.rpcUrl && !(await ensureHostPermission(s.rpcUrl))) {
    status('saved', 'Permission for that RPC host was not granted.', 'bad');
    return;
  }
  await setStorageSettings(s);
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
  else status('rpcStatus', `failed: ${r?.error || 'unknown error'}`, 'bad');
});

$('exportMemory').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'exportMemory' });
  if (!r?.ok) return;
  const blob = new Blob([JSON.stringify(r.memory, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `glass-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

$('wipeMemory').addEventListener('click', async () => {
  if (!confirm('Wipe everything GLASS has learned (devs, snipers, fee wallets, fingerprints)? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'wipeMemory' });
  refreshStats();
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  refreshStats();
});

function status(id, msg, kind) {
  const el = $(id);
  el.textContent = msg;
  el.className = `status ${kind || ''}`;
}

async function refreshStats() {
  const r = await chrome.runtime.sendMessage({ type: 'memoryStats' });
  if (!r) return;
  $('statDevs').textContent = r.devs ?? 0;
  $('statSnipers').textContent = r.snipers ?? 0;
  $('statFeeWallets').textContent = r.feeWallets ?? 0;
  $('statFingerprints').textContent = r.fingerprints ?? 0;
  $('statCached').textContent = r.cachedReports ?? 0;
}

load();
