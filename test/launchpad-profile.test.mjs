import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { RpcClient } from '../src/lib/rpc.js';
import { rateOperator, profileSummary } from '../src/lib/scan/operator.js';
import { fixture, key, rpcFixture } from './helpers/launchpad-fixture.mjs';
// The same three API regressions run against the unmodified original module in CI.
const root = process.env.GLASS_BASELINE_ROOT ? pathToFileURL(`${process.env.GLASS_BASELINE_ROOT}/`) : new URL('../', import.meta.url);
const { creatorProfile, toPriorLaunches } = await import(new URL('src/lib/scan/devprofile.js', root));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

for (const [index, family] of ['bonk', 'raydium-launchlab', 'meteora-dbc'].entries()) {
  test(`regression: creatorProfile exposes ${family} via existing RPC transport`, async () => {
    const creator = key(10 + index), tx = fixture({ creator, family, id: 10 + index });
    const wire = [];
    globalThis.fetch = async (url, opts) => {
      if (new URL(url).hostname === 'frontend-api-v3.pump.fun') return json([]);
      assert.equal(url, 'https://fixture.invalid');
      const request = JSON.parse(opts.body); wire.push(request);
      assert.ok(['getSignaturesForAddress', 'getTransaction'].includes(request.method));
      if (request.method === 'getSignaturesForAddress') {
        assert.equal(request.params[0], creator);
        return json({ result: [{ signature: tx.transaction.signatures[0], err: null }] });
      }
      assert.equal(request.params[1].encoding, 'jsonParsed');
      return json({ result: tx });
    };
    const rpc = new RpcClient('https://fixture.invalid', { fallbacks: [], archives: [] });
    const p = await creatorProfile(creator, { rpc, currentMint: key(240) });
    assert.equal(p.sample.length, 1, 'non-pump initialization must be exposed by creatorProfile');
    const prior = toPriorLaunches(p, creator);
    assert.equal(prior[0].source, family);
    assert.equal(prior[0].creator, creator);
    assert.equal(prior[0].createdAt, tx.blockTime * 1000);
    assert.equal(prior[0].outcome, 'unknown');
    assert.equal(prior[0].graduated, null);
    assert.equal(prior[0].peakMcapUsd, null);
    assert.equal(prior[0].dexId, null);
    assert.equal(prior[0].historyAvailable, false);
    assert.equal(p.exact, false);
    assert.equal(p.coverage[family].status, 'partial');
    const rating = rateOperator(prior, { profile: p });
    assert.match(rating.reasons[0], /1 prior launches found/);
    assert.doesNotMatch(rating.reasons[0], /First token/);
    assert.deepEqual(wire.map((r) => r.method), ['getSignaturesForAddress', 'getTransaction']);
  });
}

test('pump failure does not discard all three protocol histories; summary/rating preserves unknowns', async () => {
  const creator = key(20);
  globalThis.fetch = async () => json({}, 403);
  const rpc = rpcFixture(['bonk', 'raydium-launchlab', 'meteora-dbc'].map((family, i) => fixture({ creator, family, id: i + 30 })));
  const p = await creatorProfile(creator, { rpc });
  assert.equal(p.available, true); assert.equal(p.totalCreated, 3);
  assert.equal(p.firstCreatedAt, null); assert.equal(p.perDay, null);
  assert.equal(p.coverage['pump.fun'].status, 'unavailable');
  assert.equal(profileSummary(p).coverage['meteora-dbc'].observed, 1);
  const rating = rateOperator(toPriorLaunches(p, creator), { profile: p });
  assert.equal(rating.score, null); assert.equal(rating.rated, 0);
  assert.match(rating.reasons[0], /3 prior launches.*unavailable/);
  assert.equal(p.archetype.kind, 'partial');
});

test('pump record, current-mint separation, dedup and client-scoped cache survive merging', async () => {
  const creator = key(21), tx = fixture({ creator, id: 40 });
  const mint = tx.transaction.message.instructions[0].accounts[6];
  const pumpMint = key(222);
  globalThis.fetch = async () => json([{ creator, mint: pumpMint, complete: true, created_timestamp: 1700000000000, ath_market_cap: 100000 }]);
  const rpc = rpcFixture([tx, tx]);
  const a = await creatorProfile(creator, { rpc, currentMint: mint });
  assert.equal(a.totalCreated, 2); assert.equal(a.sample.length, 1); assert.equal(a.current.mint, mint);
  assert.equal(a.pumpProfile.stats.graduated, 1);
  const callCount = rpc.calls.length;
  const b = await creatorProfile(creator, { rpc, currentMint: pumpMint });
  assert.equal(b.current.mint, pumpMint); assert.equal(b.sample[0].mint, mint);
  assert.equal(rpc.calls.length, callCount);
  assert.equal(b.stats.n, 0, 'do not apply pump outcome buckets across protocols');
  const emptyClient = rpcFixture([]);
  const c = await creatorProfile(creator, { rpc: emptyClient, currentMint: pumpMint });
  assert.equal(c.source, 'pump.fun'); assert.equal(c.exact, true); assert.equal(c.sample.length, 0);
});

test('unavailable non-pump RPC preserves pump totals and exposes each source failure', async () => {
  const creator = key(22);
  globalThis.fetch = async () => json([{ creator, mint: key(230), complete: false }]);
  const p = await creatorProfile(creator, { rpc: rpcFixture([], { errorPage: 0 }) });
  assert.equal(p.totalCreated, 1); assert.equal(p.source, 'pump.fun');
  for (const source of ['bonk', 'raydium-launchlab', 'meteora-dbc']) assert.equal(p.coverage[source].status, 'unavailable');
});
