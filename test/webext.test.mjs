import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.GLASS_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url));

test('popup requests optional RPC permission before yielding the user gesture', async () => {
  const listeners = {}, fields = new Map(), requests = [];
  const get = (id) => {
    if (!fields.has(id)) fields.set(id, { value: id === 'rpcUrl' ? 'https://custom.example/rpc?key=example' : '3', checked: true, style: {}, addEventListener: (_, fn) => { listeners[id] = fn; } });
    return fields.get(id);
  };
  const api = { storage: { sync: { get: async () => ({}), set: async () => {} } },
    runtime: { sendMessage: async () => ({}) },
    permissions: { contains: async () => false, request: (o) => { requests.push(o); return Promise.resolve(true); } } };
  const context = vm.createContext({ api, chrome: api, browser: api, URL, Promise, DEFAULTS: {}, document: { getElementById: get }, setTimeout() {} });
  const helper = path.join(root, 'src/lib/webext.js');
  if (fs.existsSync(helper)) vm.runInContext(fs.readFileSync(helper, 'utf8').replace(/export /g, '').replace('const api =', 'var selectedApi =').replaceAll('api.permissions', 'selectedApi.permissions'), context);
  const popup = fs.readFileSync(path.join(root, 'src/popup.js'), 'utf8').replace(/^import .*;\r?$/gm, '').replace(/load\(\);\s*$/, '');
  vm.runInContext(popup, context);
  const saved = listeners.save();
  assert.equal(requests.length, 1, 'permission request must occur synchronously inside click');
  assert.equal(requests[0].origins[0], 'https://custom.example/*');
  await saved;
});

test('Firefox storage uses promise APIs even when callback-only chrome also exists', async () => {
  const data = new Map();
  globalThis.browser = { storage: { local: {
    async get(key) { return key === null ? Object.fromEntries(data) : { [key]: data.get(key) }; },
    async set(values) { for (const [k,v] of Object.entries(values)) data.set(k,v); },
    async remove(key) { data.delete(key); },
  } } };
  globalThis.chrome = { storage: { local: { get() {}, set() {}, remove() {} } } };
  try {
    const { ChromeStore } = await import(pathToFileURL(path.join(root, 'src/lib/cache.js')));
    const store = new ChromeStore(); await store.set('settings', { enabled: true });
    assert.deepEqual(await store.get('settings'), { enabled: true });
    assert.deepEqual(await store.keys(), ['settings']); await store.remove('settings');
    assert.deepEqual(await store.keys(), []);
  } finally { delete globalThis.browser; delete globalThis.chrome; }
});
