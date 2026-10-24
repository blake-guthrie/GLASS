import { api } from './webext.js';
// Storage abstraction: chrome.storage.local in the extension, an in-memory Map (optionally persisted to
// a JSON file by the CLI) elsewhere. Also hosts the "operator memory" — wallets seen as launch buyers
// on previously scanned tokens, so cross-launch clusters are recognised for free next time.

export class MemoryStore {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }
  async get(key) {
    return this.map.get(key);
  }
  async set(key, value) {
    this.map.set(key, value);
  }
  async remove(key) {
    this.map.delete(key);
  }
  async keys(prefix = '') {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
  toJSON() {
    return Object.fromEntries(this.map);
  }
}

export class ChromeStore {
  constructor(area = 'local') {
    this.area = api?.storage?.[area];
  }
  async get(key) {
    const r = await this.area.get(key);
    return r?.[key];
  }
  async set(key, value) {
    await this.area.set({ [key]: value });
  }
  async remove(key) {
    await this.area.remove(key);
  }
  async keys(prefix = '') {
    const all = await this.area.get(null);
    return Object.keys(all || {}).filter((k) => k.startsWith(prefix));
  }
}

export function defaultStore() {
  return api?.storage?.local ? new ChromeStore('local') : new MemoryStore();
}

/** TTL cache on top of a store. */
export class TtlCache {
  constructor(store, prefix = 'cache:') {
    this.store = store;
    this.prefix = prefix;
  }
  async get(key) {
    const hit = await this.store.get(this.prefix + key);
    if (!hit) return undefined;
    if (hit.exp && hit.exp < Date.now()) {
      await this.store.remove(this.prefix + key);
      return undefined;
    }
    return hit.v;
  }
  async set(key, v, ttlMs) {
    await this.store.set(this.prefix + key, { v, exp: ttlMs ? Date.now() + ttlMs : null });
  }
  async clear() {
    for (const k of await this.store.keys(this.prefix)) await this.store.remove(k);
  }
}

/**
 * Operator memory: wallet → launches it took part in; token → cluster snapshot.
 * Kept small: one record per token, one index entry per wallet (max 40 launches per wallet).
 */
export class OperatorMemory {
  constructor(store) {
    this.store = store;
  }
  async remember(mint, { creator, wallets, createdAt, windowPct, operatorScore }) {
    const tok = { mint, creator, wallets: wallets.slice(0, 60), createdAt, windowPct, operatorScore, savedAt: Date.now() };
    await this.store.set(`mem:token:${mint}`, tok);
    await this._capTokens(1500);
    const roles = [[creator, 'creator'], ...wallets.filter((w) => w !== creator).map((w) => [w, 'buyer'])];
    for (const [w, role] of roles) {
      if (!w) continue;
      const key = `mem:wallet:${w}`;
      const cur = (await this.store.get(key)) || [];
      if (!cur.some((x) => x.mint === mint)) {
        cur.unshift({ mint, role, createdAt });
        await this.store.set(key, cur.slice(0, 40));
      }
    }
  }
  /** Keep the index bounded: drop the oldest remembered tokens (and their wallet index entries) past `max`. */
  async _capTokens(max) {
    const keys = await this.store.keys('mem:token:');
    if (keys.length <= max) return;
    const rows = [];
    for (const k of keys) rows.push({ k, t: (await this.store.get(k))?.savedAt || 0 });
    rows.sort((a, b) => a.t - b.t);
    for (const r of rows.slice(0, keys.length - max)) {
      const tok = await this.store.get(r.k);
      await this.store.remove(r.k);
      for (const w of [tok?.creator, ...(tok?.wallets || [])].filter(Boolean)) {
        const key = `mem:wallet:${w}`;
        const cur = ((await this.store.get(key)) || []).filter((x) => x.mint !== tok.mint);
        if (cur.length) await this.store.set(key, cur);
        else await this.store.remove(key);
      }
    }
  }
  async getWalletLaunches(wallet) {
    return (await this.store.get(`mem:wallet:${wallet}`)) || [];
  }
  /**
   * Reputation layer: wallets that keep showing up across the launches *you* scanned — sniper bots,
   * shared fee wallets, funders, creators — with how those launches were called at the time.
   * kind: 'sniper' | 'fee' | 'funder' | 'dev'
   */
  async noteRep(kind, wallet, mint, level) {
    if (!wallet || !mint) return;
    const key = `mem:rep:${kind}:${wallet}`;
    const cur = (await this.store.get(key)) || { seen: 0, mints: [], levels: {}, lastSeen: 0 };
    if (cur.mints.includes(mint)) return;
    cur.seen += 1;
    cur.mints.unshift(mint);
    cur.mints = cur.mints.slice(0, 30);
    if (level) cur.levels[level] = (cur.levels[level] || 0) + 1;
    cur.lastSeen = Date.now();
    await this.store.set(key, cur);
  }
  /** Merge arbitrary metadata into a reputation record (e.g. platform-fee classification). */
  async noteRepMeta(kind, wallet, meta) {
    const key = `mem:rep:${kind}:${wallet}`;
    const cur = (await this.store.get(key)) || { seen: 0, mints: [], levels: {}, lastSeen: 0 };
    await this.store.set(key, { ...cur, ...meta });
  }
  async getRep(kind, wallet) {
    return (await this.store.get(`mem:rep:${kind}:${wallet}`)) || null;
  }
  async getReps(kind, wallets) {
    const out = {};
    for (const w of wallets) {
      const r = await this.getRep(kind, w);
      if (r) out[w] = r;
    }
    return out;
  }
  async getToken(mint) {
    return this.store.get(`mem:token:${mint}`);
  }
  async stats() {
    const toks = await this.store.keys('mem:token:');
    const ws = await this.store.keys('mem:wallet:');
    const reps = await this.store.keys('mem:rep:');
    return { tokens: toks.length, wallets: ws.length, reputations: reps.length };
  }
  async clear() {
    for (const k of await this.store.keys('mem:')) await this.store.remove(k);
  }
  async export() {
    const out = { tokens: {}, wallets: {} };
    for (const k of await this.store.keys('mem:token:')) out.tokens[k.slice(10)] = await this.store.get(k);
    for (const k of await this.store.keys('mem:wallet:')) out.wallets[k.slice(11)] = await this.store.get(k);
    return out;
  }
}
