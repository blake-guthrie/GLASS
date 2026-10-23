import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeBase58 } from '../../src/lib/base58.js';
import { DEFAULTS, PROGRAMS, PUMP_IX } from '../../src/lib/constants.js';
import { WorkerStore } from '../../worker/store.mjs';
export const captured = JSON.parse(await fs.readFile(new URL('../fixtures/pump-txs.json', import.meta.url), 'utf8'));
export const address = (n) => encodeBase58(new Uint8Array(32).fill(n));
export const signature = (n) => encodeBase58(new Uint8Array(64).fill(n));
export const row = (sig) => ({ signature: sig, err: null, slot: 1, blockTime: 1 });
export async function temporaryStore(t) {
  const root = path.resolve(process.env.GLASS_TEST_TMP || '../test-runtime');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'worker-'));
  const store = await new WorkerStore(dir).open();
  t.after(async () => { await store.close(); });
  return store;
}
// Schema-built synthetic instructions: never claimed to be captured chain history.
export function creation(authority, { mint = address(1), sig = signature(1), v2 = true, quote, inner = false, failed = false, ancestorFailed = false } = {}) {
  const str = (s) => { const bytes=Buffer.from(s),size=Buffer.alloc(4);size.writeUInt32LE(bytes.length);return Buffer.concat([size,bytes]); };
  const data=Buffer.concat([Buffer.from(v2 ? PUMP_IX.create_v2 : PUMP_IX.create),str('Fixture'),str('FIX'),str('https://fixture.invalid/meta'),Buffer.alloc(32,3),...(v2?[Buffer.from([0])]:[])]);
  const ix = { programId: PROGRAMS.PUMP, accounts: [mint, authority, ...Array(v2 ? 14 : 12).fill(address(2))],
    data: encodeBase58(data), stackHeight: inner ? 3 : 1 };
  if (quote) ix.accounts.push(quote,address(5),PROGRAMS.TOKEN);
  const root = address(7), parent = address(8);
  const logs = inner ? [`Program ${root} invoke [1]`, `Program ${parent} invoke [2]`, `Program ${PROGRAMS.PUMP} invoke [3]`,
    `Program ${PROGRAMS.PUMP} ${failed ? 'failed: fixture' : 'success'}`, `Program ${parent} ${ancestorFailed ? 'failed: fixture' : 'success'}`, `Program ${root} success`]
    : [`Program ${PROGRAMS.PUMP} invoke [1]`, `Program ${PROGRAMS.PUMP} success`];
  return { slot: 1, blockTime: 1, transaction: { signatures: [sig], message: { accountKeys: [root], instructions: inner ? [{ programId: root }] : [ix] } },
    meta: { err: null, logMessages: logs, innerInstructions: inner ? [{ index: 0, instructions: [{ programId: parent, stackHeight: 2 }, ix] }] : [] } };
}
export function completeReport(mint = address(1), now = Date.now()) {
  return { mint, finishedAt: now, errors: [], rpc: { url: 'https://rpc.invalid/?api-key=DO-NOT-PUBLISH' }, settings: { private: 'DO-NOT-PUBLISH' },
    stages: Object.fromEntries(['resolve','creation','launch','wallets','live','operator','score'].map((s) => [s, { status: 'done' }])),
    score: { score: 42, verdict: { headline: 'Fixture risk' }, call: { word: 'Caution', confidence: 'low' } },
    launch: { blocksRead: DEFAULTS.slotWindow + 1, txsRead: 3, partialEarly: false, classified: false, creatorDevBuy: { pct: 10 }, window: { pct: 20 } },
    creation: { creator: address(4), createdAt: now-60_000, tokenName: '<img src=x onerror=bad()>', symbol: 'TEST' },
    operator: { profile: { totalCreated: 2, atLeast: true }, rating: { rated: 1, score: 30, label: 'thin history' } },
    live: { summary: { clusterBoughtPct: 20, clusterHoldsPct: 15, clusterSoldPct: 5 } }, degraded: 0 };
}
