import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runScan } from '../src/lib/scan/pipeline.js';
import { analysePriorLaunches } from '../src/lib/scan/operator.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';

const f = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-quote-events.json', import.meta.url)));
const buy = f.cases[4].tx;
const sell = structuredClone(f.cases[0].tx);
const event = sell.meta.innerInstructions[0].instructions[0];
const bytes = decodeBase58(event.data);
bytes[16 + 32 + 8 + 8] = 0;
event.data = encodeBase58(bytes);
sell.blockTime = 1010;
const creationSig = { signature: 'create', slot: 100, blockTime: 1000 };
const sellSig = { signature: 'sell', slot: 110, blockTime: 1010 };
const rpc = {
  totalCalls: 0, totalDegraded: 0, url: 'offline-fixture',
  async getAccountInfo() { return { value: { data: { parsed: { type: 'mint' } } } }; },
  async getMintInfo() { return { supply: 1e9, tokenProgram: PROGRAMS.TOKEN_2022 }; },
  async getSignaturesForAddress(address) { return address === f.user ? [] : address === 'offline-ata' ? [sellSig] : [creationSig]; },
  async getTransaction(sig) { return sig === 'sell' ? sell : buy; },
  async getTransactions(sigs) { return sigs.map(sig => sig === 'sell' ? sell : buy); },
  async getBlockAccounts() { return { transactions: [] }; },
  async pageSignatures() { return { sigs: [], exhausted: true }; },
  async ataFor() { return 'offline-ata'; },
  async getTokenBalances(owners) { return owners.map(owner => ({ owner, amount: 0 })); },
};

function offlineFetch(t) {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /^https:\/\/(api\.dexscreener\.com|api\.geckoterminal\.com|frontend-api-v3\.pump\.fun)\//);
    return new Response(JSON.stringify({ pairs: [], data: [] }), { status: 200 });
  });
}

test('USDC full scan keeps paid and received amounts with live and operator stages enabled', async t => {
  offlineFetch(t);
  const report = await runScan(rpc, f.mint, { hintIsMint: true, settings: { slotWindow: 0, earlyWindowSec: 0, maxWalletProfiles: 0, operatorHistory: true, liveTracking: true, jitoLookup: false } });
  assert.deepEqual(report.errors, []);
  assert.equal(Object.values(report.stages).filter(s => s.status === 'done').length, 7);
  assert.equal(report.market.marketCapUsd, 25e6);
  assert.equal(report.launch.creatorDevBuy.quotes.usdc, 1.5);
  assert.equal(report.live.summary.clusterSoldQuotes.usdc, 1.5);
  assert.equal(report.live.summary.clusterSoldQuotes.sol, 0);
  assert.equal(report.operator.disabled, undefined);
});

test('prior-launch on-chain outcome prices USDC even without SOL market data', async t => {
  offlineFetch(t);
  const client = { ...rpc, async getSignaturesForAddress() { return [sellSig]; } };
  const [out] = await analysePriorLaunches(client, [{ mint: f.mint, creator: f.user, createdAt: 1000000, launchBuyers: [], clusterWallets: [] }], [], new Map());
  assert.equal(out.source, 'on-chain');
  assert.equal(out.peakMcapUsd, 25e6);
  assert.equal(out.nowMcapUsd, 25e6);
  assert.equal(out.clusterExit.mcapAtFirstSellUsd, 25e6);
  assert.equal(out.clusterExit.quotesOut.usdc, 1.5);
});
