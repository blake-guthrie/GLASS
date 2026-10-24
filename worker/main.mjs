#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { RpcClient } from '../src/lib/rpc.js';
import { WorkerStore } from './store.mjs';
import { PrescanWorker } from './worker.mjs';
import { indexServer } from './server.mjs';

export async function main(args = process.argv.slice(2)) {
  const at = args.indexOf('--config');
  if (at < 0 || !args[at+1]) throw new Error('usage: node worker/main.mjs --config worker/config.json [--once] [--retry-failed]');
  const config = JSON.parse(await fs.readFile(args[at+1], 'utf8'));
  const rpcUrl = process.env.GLASS_WORKER_RPC;
  let parsed;
  try { parsed = new URL(rpcUrl); } catch { throw new Error('GLASS_WORKER_RPC must contain the operator RPC URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('RPC must use HTTP(S)');
  if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw new Error('dataDir must be an absolute operator-owned directory');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('invalid listen port');
  const store = await new WorkerStore(config.dataDir).open();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let server;
  try {
    // No automatic RPC failover to somebody else's endpoint.
    const rpc = new RpcClient(rpcUrl, { fallbacks: [], archives: [] });
    const worker = new PrescanWorker({ rpc, store, config: config.worker, settings: config.scan });
    await worker.initialize();
    if (args.includes('--retry-failed')) await worker.retryFailed();
    server = indexServer(store, () => worker.status(), worker.settings);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host || '127.0.0.1', resolve); });
    console.log(`GLASS read-only index listening on port ${server.address().port}`);
    do {
      await worker.tick(abort.signal);
      if (args.includes('--once') || abort.signal.aborted) break;
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, worker.config.pollMs);
        abort.signal.addEventListener('abort', finish, { once: true });
      });
    } while (!abort.signal.aborted);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await store.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Worker stopped: check configuration/state/provider; no credentials are printed.'); process.exitCode = 1; });
}
