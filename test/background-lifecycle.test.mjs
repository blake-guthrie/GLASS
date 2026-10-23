import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.GLASS_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').replace(/^import .*;\r?$/gm, '');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });

function harness() {
  const onConnect = event(), onMessage = event();
  const scans = [], watches = [], timeouts = [];
  const gate = deferred();
  let getSettings = async () => ({ settings: { rpcUrl: 'https://rpc.example' } });
  const api = { runtime: { onConnect, onMessage }, storage: { sync: { get: () => getSettings() } } };
  class Store { async keys() { return []; } }
  class Cache { async get() {} async set() {} async clear() {} }
  class Memory { async stats() { return { tokens: 0 }; } }
  class Watch {
    constructor(o) { this.o = o; watches.push(this); }
    prime() {}
    async start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  vm.runInNewContext(source, {
    api, chrome: api, console, DEFAULTS: { rpcUrl: 'https://rpc.example' }, ChromeStore: Store, TtlCache: Cache, OperatorMemory: Memory,
    RpcClient: class {}, LiveWatcher: Watch, wsUrlFor: (u) => u.replace('https:', 'wss:'),
    runScan: async (...args) => { scans.push(args); return gate.promise; },
    setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); },
  });
  return {
    scans, watches, timeouts, gate,
    settings(fn) { getSettings = fn; },
    port() {
      const p = { name: 'glass-scan', onMessage: event(), onDisconnect: event(), messages: [], postMessage(m) { this.messages.push(m); } };
      onConnect.emit(p); return p;
    },
  };
}
const watch = { type: 'watch', mint: 'mint', wallets: [{ wallet: 'wallet' }] };

test('disconnect during async settings cannot start an orphan watcher', async () => {
  const h = harness(), wait = deferred(); h.settings(() => wait.promise);
  const p = h.port(); p.onMessage.emit(watch); p.onDisconnect.emit();
  wait.resolve({ settings: {} }); await settle();
  assert.equal(h.watches.length, 0);
});

test('unwatch cancels a watch still waiting for settings', async () => {
  const h = harness(), wait = deferred(); h.settings(() => wait.promise);
  const p = h.port(); p.onMessage.emit(watch); p.onMessage.emit({ type: 'unwatch' });
  wait.resolve({ settings: {} }); await settle();
  assert.equal(h.watches.length, 0);
});

test('only the latest pending watch starts, even when storage resolves out of order', async () => {
  const h = harness(), first = deferred(), second = deferred(); let calls = 0;
  h.settings(() => (++calls === 1 ? first : second).promise);
  const p = h.port(); p.onMessage.emit(watch); p.onMessage.emit({ ...watch, mint: 'new' });
  second.resolve({ settings: {} }); await settle(); first.resolve({ settings: {} }); await settle();
  assert.equal(h.watches.length, 1); assert.equal(h.watches[0].o.mint, 'new');
});

test('simultaneous cold-start scans share one job before async storage returns', async () => {
  const h = harness(), wait = deferred(); h.settings(() => wait.promise);
  h.port().onMessage.emit({ type: 'scan', identifier: 'same', force: true });
  h.port().onMessage.emit({ type: 'scan', identifier: 'same', force: true });
  wait.resolve({ settings: {} }); await settle();
  assert.equal(h.scans.length, 1); h.gate.resolve(null); await settle();
});

test('a port changing tokens detaches from every old scan', async () => {
  const h = harness(), p = h.port();
  p.onMessage.emit({ type: 'scan', identifier: 'first', force: true }); await settle();
  p.onMessage.emit({ type: 'scan', identifier: 'second', force: true }); await settle();
  assert.equal(h.scans.length, 2);
  for (const t of h.timeouts.filter((t) => t.ms === 30_000)) t.fn();
  assert.equal(h.scans[0][2].signal.aborted, true);
  assert.equal(h.scans[1][2].signal.aborted, false);
  h.gate.resolve(null); await settle();
});

test('disconnect stops a running watcher and a new port can subscribe', async () => {
  const h = harness(), p = h.port(); p.onMessage.emit(watch); await settle();
  assert.equal(h.watches[0].started, true); p.onDisconnect.emit();
  assert.equal(h.watches[0].stopped, true);
  const next = h.port(); next.onMessage.emit(watch); await settle();
  assert.equal(h.watches.length, 2); assert.equal(h.watches[1].started, true);
  next.onDisconnect.emit();
});

test('a port joining after completion receives done while cache persistence is pending', async () => {
  const h = harness(); h.port().onMessage.emit({ type: 'scan', identifier: 'same', force: true }); await settle();
  h.scans[0][2].emit('done', { identifier: 'same', mint: 'same', stage: 'score', finishedAt: 1 });
  const next = h.port(); next.onMessage.emit({ type: 'scan', identifier: 'same' }); await settle();
  assert.equal(next.messages[0].type, 'done'); h.gate.resolve(null); await settle();
});
