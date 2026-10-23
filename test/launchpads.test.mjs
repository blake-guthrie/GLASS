import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBase58 } from '../src/lib/base58.js';
import { launchesFromTransaction, fetchLaunchpadHistory } from '../src/lib/scan/launchpads.js';
import { fixture, key, signature, rpcFixture } from './helpers/launchpad-fixture.mjs';

for (const variant of ['rayLegacy', 'ray', 'ray2022', 'dbc', 'dbc2022', 'dbcHook']) {
  test(`official layout: ${variant} direct, CPI and v0 account references`, () => {
    for (const mode of [{}, { inner: true }, { raw: true }, { inner: true, raw: true }]) {
      const tx = fixture({ variant, ...mode });
      const [coin] = launchesFromTransaction(tx, key(9));
      assert.ok(coin); assert.equal(coin.name, 'Fixture token'); assert.equal(coin.symbol, 'FIX');
      assert.equal(coin.mint, key(101)); assert.equal(coin.creator, key(9));
      assert.equal(coin.source, variant.startsWith('ray') ? 'bonk' : 'meteora-dbc');
    }
  });
}

test('designated creator is distinct from payer/fee authority; never accepts creator transfer as creation', () => {
  const tx = fixture();
  assert.deepEqual(launchesFromTransaction(tx, key(50)), []);
  assert.deepEqual(launchesFromTransaction(tx, key(88)), []);
  const transfer = fixture({ family: 'meteora-dbc' });
  transfer.transaction.message.instructions[0].data = encodeBase58([20,7,169,33,58,147,166,33]);
  assert.deepEqual(launchesFromTransaction(transfer, key(9)), []);
});

test('Bonk identity is exact platform address; unknown platforms remain unbranded LaunchLab', () => {
  const [known] = launchesFromTransaction(fixture({ family: 'raydium-launchlab' }), key(9));
  assert.equal(known.source, 'raydium-launchlab'); assert.equal(known.platformName, 'Raydium');
  const [unknown] = launchesFromTransaction(fixture({ platform: key(99) }), key(9));
  assert.equal(unknown.source, 'raydium-launchlab'); assert.equal(unknown.platformName, null);
});

test('failed, absent-meta, wrong-program, short-account and malformed-data transactions are ignored', () => {
  const edits = [
    (t) => { t.meta.err = { InstructionError: [0, 'Custom'] }; },
    (t) => { t.meta = null; },
    (t) => { t.transaction.message.instructions[0].programId = key(1); },
    (t) => { t.transaction.message.instructions[0].accounts.length = 7; },
    (t) => { t.transaction.message.instructions[0].data = '0!'; },
    (t) => { t.transaction.message.instructions[0].data = encodeBase58([67,153,175,39,218,16,38,32,6,255,255,255,255]); },
    (t) => { t.transaction.message.instructions[0].accounts[6] = 'invalid'; },
  ];
  for (const edit of edits) { const tx = fixture(); edit(tx); assert.deepEqual(launchesFromTransaction(tx, key(9)), []); }
});

test('unknown date and market outcomes remain null; CPI duplicates deduplicate by mint', () => {
  const tx = fixture(); tx.blockTime = null; tx.slot = null;
  tx.meta.innerInstructions = [{ index: 0, instructions: tx.transaction.message.instructions }];
  const coins = launchesFromTransaction(tx, key(9));
  assert.equal(coins.length, 1);
  for (const field of ['createdAt', 'createdSlot', 'graduated', 'athMcapUsd', 'nowMcapUsd']) assert.equal(coins[0][field], null);
});

test('caught failed CPI and missing/truncated success logs do not fabricate a launch', () => {
  for (const family of ['bonk', 'meteora-dbc']) {
    const tx = fixture({ family, inner: true });
    const program = tx.meta.innerInstructions[0].instructions[0].programId;
    tx.meta.logMessages[2] = `Program ${program} failed: custom program error: 0x1`;
    assert.deepEqual(launchesFromTransaction(tx, key(9)), []);
    tx.meta.logMessages = null;
    assert.deepEqual(launchesFromTransaction(tx, key(9)), []);
    tx.meta.logMessages = [`Program ${program} invoke [2]`];
    assert.deepEqual(launchesFromTransaction(tx, key(9)), []);
  }
});

test('bounded history paginates and exposes a continuation, never claims all-time completeness', async () => {
  const txs = [fixture({ id: 3 }), fixture({ id: 2 }), fixture({ id: 1 })];
  const rpc = rpcFixture(txs);
  const first = await fetchLaunchpadHistory(rpc, key(9), { pageSize: 1, maxPages: 2 });
  assert.equal(first.coins.length, 2); assert.equal(first.coverage.bonk.nextBefore, signature(2));
  assert.equal(first.coverage.bonk.endpointExhausted, false);
  const next = await fetchLaunchpadHistory(rpc, key(9), { pageSize: 1, maxPages: 2, before: first.coverage.bonk.nextBefore });
  assert.equal(next.coins.length, 1); assert.equal(next.coverage.bonk.endpointExhausted, true);
  assert.equal(next.coverage.bonk.status, 'partial'); assert.equal(next.coverage.bonk.exact, false);
});

test('partial RPC failure preserves earlier launches; missing/failed transactions are counted', async () => {
  const txs = [fixture({ id: 4 }), fixture({ id: 5 }), fixture({ id: 6 })];
  txs[2].meta.err = { failed: true };
  const rpc = rpcFixture(txs, { missing: new Set([signature(5)]), errorPage: 1 });
  const p = await fetchLaunchpadHistory(rpc, key(9), { pageSize: 3, maxPages: 2 });
  assert.equal(p.coins.length, 1); assert.equal(p.coverage.bonk.missingTransactions, 1);
  assert.equal(p.coverage.bonk.failedTransactions, 1); assert.match(p.coverage.bonk.reason, /Request stopped/);
});

test('cache reuses success, expires after 90 seconds and does not cache failed requests', async () => {
  const rpc = rpcFixture([fixture()]);
  const clock = Date.now; let now = clock(); Date.now = () => now;
  try {
    await fetchLaunchpadHistory(rpc, key(9)); const n = rpc.calls.length;
    await fetchLaunchpadHistory(rpc, key(9)); assert.equal(rpc.calls.length, n);
    now += 90_001; await fetchLaunchpadHistory(rpc, key(9)); assert.ok(rpc.calls.length > n);
  } finally { Date.now = clock; }
  const broken = rpcFixture([], { errorPage: 0 });
  await fetchLaunchpadHistory(broken, key(9)); await fetchLaunchpadHistory(broken, key(9));
  assert.equal(broken.calls.length, 2);
});

test('non-advancing/malformed pages stop honestly; bad bounds fail before transport', async () => {
  const tx = fixture(), row = { signature: signature(1), err: null };
  const repeated = rpcFixture([tx], { pages: [[row], [row]] });
  const out = await fetchLaunchpadHistory(repeated, key(9), { pageSize: 1, maxPages: 3 });
  assert.equal(out.coins.length, 1); assert.match(out.coverage.bonk.reason, /did not advance/);
  const malformed = rpcFixture([], { pages: [[{ signature: 'bad' }]] });
  assert.equal((await fetchLaunchpadHistory(malformed, key(9))).coverage.bonk.status, 'unavailable');
  for (const options of [{ maxPages: 0 }, { pageSize: 101 }, { before: 'bad' }]) await assert.rejects(fetchLaunchpadHistory(malformed, key(9), options));
  assert.equal((await fetchLaunchpadHistory(null, key(9))).coverage.bonk.status, 'unavailable');
});
