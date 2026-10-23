// Test-only network substitutes. Never included in a distributable build.
// The production scan engine, storage, background and ports run unchanged.
export const mint = '11111111111111111111111111111112';
export const creator = '11111111111111111111111111111113';
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fixture = globalThis.__glassFixture = { requests: [], sockets: [], unknown: [], starts: Date.now() };
const now = Math.floor(Date.now() / 1000);
const tx = {
  slot: 9000, blockTime: now, version: 0,
  transaction: { signatures: ['synthetic-create'], message: {
    accountKeys: [{ pubkey: creator, signer: true, writable: true }, { pubkey: mint, signer: false, writable: true }],
    instructions: [{ program: 'spl-token', programId: tokenProgram, parsed: { type: 'initializeMint2', info: { mint, decimals: 6, mintAuthority: creator } } }],
  } },
  meta: { err: null, fee: 5000, preBalances: [10000000, 0], postBalances: [9995000, 0], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [] },
};
function rpc(request) {
  const { method, params = [] } = request;
  let result;
  switch (method) {
    case 'getSlot': result = 10000; break;
    case 'getFirstAvailableBlock': result = 0; break;
    case 'getBlockTime': result = now - Math.round((10000 - params[0]) * 0.4); break;
    case 'getAccountInfo': result = { value: params[0] === mint ? { owner: tokenProgram, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000' } } } } : null }; break;
    case 'getSignaturesForAddress': result = params[1]?.before ? [] : [{ signature: 'synthetic-create', slot: 9000, blockTime: now, err: null }]; break;
    case 'getTransaction': result = tx; break;
    case 'getBlock': result = { blockTime: now, transactions: [] }; break;
    case 'getMultipleAccounts': result = { value: params[0].map(() => null) }; break;
    case 'getTokenAccountsByOwner': result = { value: [] }; break;
    case 'getBalance': result = { value: 0 }; break;
    case 'getHealth': result = 'ok'; break;
    default: fixture.unknown.push(method); throw new Error(`Unmocked RPC: ${method}`);
  }
  return { jsonrpc: '2.0', id: request.id, result };
}
globalThis.fetch = async (url, options = {}) => {
  fixture.requests.push({ url: String(url), method: options.method || 'GET' });
  let result;
  if (options.body) {
    const request = JSON.parse(options.body);
    result = Array.isArray(request) ? request.map(rpc) : rpc(request);
  } else if (String(url).startsWith('https://api.dexscreener.com/')) {
    result = { pairs: [{ chainId: 'solana', dexId: 'pumpfun', pairAddress: mint, baseToken: { address: mint, name: 'Fixture Token', symbol: 'FIX' }, priceUsd: '0.0001', priceNative: '0.000001', marketCap: 100000 }] };
  } else {
    fixture.unknown.push(String(url)); throw new Error(`Unmocked URL: ${url}`);
  }
  // Yield so streaming is exercised across real extension event turns.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
};
globalThis.WebSocket = class FixtureSocket {
  constructor(url) {
    this.url = url; this.closed = false; this.sent = []; this.readyState = 0;
    fixture.sockets.push(this);
    setTimeout(() => { if (!this.closed) { this.readyState = 1; this.onopen?.(); } }, 5);
  }
  send(text) {
    if (this.closed) throw new Error('closed fixture socket');
    const message = JSON.parse(text); this.sent.push(message);
    if (message.method === 'accountSubscribe') {
      setTimeout(() => {
        if (this.closed) return;
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.id }) });
        if (message.params[1].encoding === 'jsonParsed') this.onmessage?.({ data: JSON.stringify({
          jsonrpc: '2.0', method: 'accountNotification', params: { subscription: message.id, result: { context: { slot: 10001 }, value: { data: { parsed: { info: { tokenAmount: { uiAmount: 25 } } } } } } },
        }) });
      }, 5);
    }
  }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.(); }
};

const api = globalThis.browser ?? globalThis.chrome;
api.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type !== 'fixture') return false;
  if (msg.action === 'closeSockets') for (const socket of fixture.sockets) socket.close();
  respond({ requests: fixture.requests, unknown: fixture.unknown, starts: fixture.starts,
    sockets: fixture.sockets.map((s) => ({ url: s.url, closed: s.closed, subscriptions: s.sent.filter((m) => m.method === 'accountSubscribe').length })) });
  return false;
});
