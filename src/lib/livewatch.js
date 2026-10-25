// Real-time watcher: one WebSocket to the RPC, accountSubscribe on every cluster wallet's token
// account for the mint (balance changes = buys / sells / transfers, sub-second) and on the pump.fun
// bonding curve (live price / market cap from its virtual reserves). No polling, no page scraping.
import { PROGRAMS } from './constants.js';
import { decodeBase58, encodeBase58 } from './base58.js';
import { findProgramAddress } from './pda.js';
import { normaliseQuoteMint, quoteScale, quotePriceUsd } from './quote.js';

const LAMPORTS = 1e9;

export function wsUrlFor(httpUrl) {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    return u.toString();
  } catch {
    return null;
  }
}

async function ataFor(owner, mint, tokenProgram) {
  const { address } = await findProgramAddress([decodeBase58(owner), decodeBase58(tokenProgram), decodeBase58(mint)], PROGRAMS.ATA);
  return address;
}

function readU64(bytes, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return Number(v);
}

/** pump.fun BondingCurve account: 8 disc | vTok u64 | vSol u64 | rTok u64 | rSol u64 | supply u64 | complete u8 */
export function decodeCurve(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 49) return null;
    const vTok = readU64(bytes, 8) / 1e6;
    const vSol = readU64(bytes, 16) / LAMPORTS;
    const rTok = readU64(bytes, 24) / 1e6;
    const rSol = readU64(bytes, 32) / LAMPORTS;
    const supply = readU64(bytes, 40) / 1e6;
    const complete = bytes[48] === 1;
    // creator (32), mayhem (1), cashback (1), then quote_mint (32).
    const quoteMint = normaliseQuoteMint(bytes.length >= 115 ? encodeBase58(bytes.subarray(83, 115)) : null);
    const scale = quoteScale(quoteMint);
    const vQuote = scale ? readU64(bytes, 16) / scale : null;
    const rQuote = scale ? readU64(bytes, 32) / scale : null;
    const priceQuote = scale && vTok > 0 ? vQuote / vTok : null;
    return { vTok, vSol, rTok, rSol, vQuote, rQuote, quoteMint, supply, complete, priceQuote,
      priceSol: quoteMint === PROGRAMS.WSOL ? priceQuote : null };
  } catch {
    return null;
  }
}

export class LiveWatcher {
  /**
   * @param opts { wsUrl, mint, tokenProgram, wallets:[{wallet, kind}], curve, supply, solUsd, onEvent(ev), onStatus(s), log }
   */
  constructor(opts) {
    this.o = opts;
    this.ws = null;
    this.subs = new Map(); // subscription id → { kind:'ata'|'curve', wallet }
    this.pending = new Map(); // request id → { kind, wallet }
    this.last = new Map(); // wallet → last known amount
    this.nextId = 1;
    this.closed = false;
    this.retries = 0;
    this.pingTimer = null;
  }
  async start() {
    const { wsUrl, mint, tokenProgram = PROGRAMS.TOKEN, wallets, curve } = this.o;
    this.atas = [];
    for (const w of wallets.slice(0, 40)) this.atas.push({ wallet: w.wallet, kind: w.kind, ata: await ataFor(w.wallet, mint, tokenProgram) });
    this.curve = curve || null;
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const url = this.o.wsUrl;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.o.onStatus?.({ state: 'error', message: e.message });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.o.onStatus?.({ state: 'open', subs: this.atas.length + (this.curve ? 1 : 0) });
      for (const a of this.atas) this.subscribe(a.ata, { kind: 'ata', wallet: a.wallet, walletKind: a.kind }, 'jsonParsed');
      if (this.curve) this.subscribe(this.curve, { kind: 'curve' }, 'base64');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        // keep the socket (and the service worker) alive
        try {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'getHealth' }));
        } catch {
          /* closing */
        }
      }, 25_000);
    };
    ws.onmessage = (m) => this.onMessage(m);
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.subs.clear();
      this.pending.clear();
      if (this.closed) return;
      const wait = Math.min(30_000, 1000 * 2 ** this.retries++);
      this.o.onStatus?.({ state: 'reconnecting', inMs: wait });
      setTimeout(() => this.connect(), wait);
    };
  }
  subscribe(account, meta, encoding) {
    const id = this.nextId++;
    this.pending.set(id, meta);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [account, { encoding, commitment: 'confirmed' }] }));
  }
  onMessage(m) {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const meta = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.result != null) this.subs.set(msg.result, meta);
      else this.o.log?.(`subscribe failed: ${JSON.stringify(msg.error || msg).slice(0, 120)}`);
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const meta = this.subs.get(msg.params?.subscription);
    if (!meta) return;
    const value = msg.params.result?.value;
    const slot = msg.params.result?.context?.slot;
    const at = Date.now();
    if (meta.kind === 'curve') {
      const data = Array.isArray(value?.data) ? value.data[0] : null;
      const c = data ? decodeCurve(data) : null;
      if (c) {
        const priceUsd = quotePriceUsd(c.priceQuote, c.quoteMint, this.o.solUsd);
        this.o.onEvent?.({ type: 'curve', at, slot, ...c, mcapUsd: priceUsd ? priceUsd * (this.o.supply || c.supply) : null });
      }
      return;
    }
    // token account: value null = account closed (sold everything and closed the ATA)
    const amount = value ? Number(value.data?.parsed?.info?.tokenAmount?.uiAmount || 0) : 0;
    const prev = this.last.get(meta.wallet);
    this.last.set(meta.wallet, amount);
    const delta = prev == null ? null : amount - prev;
    this.o.onEvent?.({ type: 'balance', at, slot, wallet: meta.wallet, walletKind: meta.walletKind, amount, prev: prev ?? null, delta, closed: !value });
  }
  prime(balances) {
    // seed "previous" balances from the scan so the first notification yields a delta
    for (const b of balances || []) if (b.now != null) this.last.set(b.wallet, b.now);
  }
  stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
