// Synthetic mathematical curves, not captured trades or a real launch library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTrajectories } from '../src/lib/scan/trajectory.js';

const options = { asOf: 10_900, horizonSeconds: 300 };
const point = (t, price = 1, volume = 0, buyers = 0) => ({ t, price, volume, buyers });
const record = (id, changes = {}) => ({
  id, launchedAt: id === 'target' ? 10_000 : 1_000, quoteUnit: 'solana:SOL',
  completeThrough: 900, samples: [point(0)], source: 'synthetic algorithm fixture', ...changes,
});
const compare = (target, library, extra = {}) => compareTrajectories(target, library, { ...options, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('identical complete three-channel curves produce a hand-computable exact match', () => {
  const samples = [point(0), point(60, 2, 10, 2), point(240, 1, 40, 8)];
  const result = compare(record('target', { samples }), [record('past', { samples })]);
  assert.equal(result.status, 'ok'); assert.equal(result.matches[0].similarity, 100);
  assert.deepEqual(result.matches[0].components, { price: 0, volume: 0, buyers: 0 });
  assert.equal(result.provenance, 'caller-supplied, not independently verified');
});

test('time-weighted channel differences have transparent hand-computable values', () => {
  const result = compare(record('target'), [record('past', { samples: [point(0), point(150, 2, 10, 2)] })]);
  const match = result.matches[0];
  close(match.components.price, 0.25); close(match.components.volume, 0.5); close(match.components.buyers, 0.5);
  close(match.distance, 5 / 12); close(match.similarity, 100 * 7 / 12);
});

test('every required channel independently changes the result', () => {
  for (const key of ['price', 'volume', 'buyers']) {
    const changed = point(150); changed[key] = key === 'price' ? 2 : 10;
    const match = compare(record('target'), [record('past', { samples: [point(0), changed] })]).matches[0];
    assert.ok(match.components[key] > 0); assert.ok(match.similarity < 100);
    for (const other of ['price', 'volume', 'buyers'].filter((x) => x !== key)) assert.equal(match.components[other], 0);
  }
});

test('paths with identical endpoints differ and retain volume/buyer scale', () => {
  const early = record('target', { samples: [point(0), point(60, 1, 10, 2)] });
  const late = record('late', { samples: [point(0), point(240, 1, 10, 2)] });
  const larger = record('larger', { samples: [point(0), point(60, 1, 20, 4)] });
  const result = compare(early, [late, larger]);
  const a = result.matches.find((m) => m.id === 'late'), b = result.matches.find((m) => m.id === 'larger');
  close(a.components.volume, 0.6); close(a.components.buyers, 0.6);
  close(b.components.volume, 0.4); close(b.components.buyers, 0.4);
});

test('price denomination is normalized while relative movement amplitude remains meaningful', () => {
  const target = record('target', { samples: [point(0, 2), point(150, 4)] });
  const scaled = record('scaled', { samples: [point(0, 20), point(150, 40)] });
  const biggerMove = record('bigger', { samples: [point(0, 2), point(150, 8)] });
  const result = compare(target, [scaled, biggerMove]);
  assert.equal(result.matches[0].id, 'scaled'); assert.equal(result.matches[0].similarity, 100);
  assert.ok(result.matches[1].components.price > 0);
});

test('irregular step samples use elapsed-time duration, not sample count or a fixed grid', () => {
  const target = record('target', { samples: [point(0), point(1, 2, 3, 1), point(299, 1, 3, 1)] });
  const same = record('past', { samples: [point(0), point(1, 2, 3, 1), point(7, 2, 3, 1), point(90, 2, 3, 1), point(299, 1, 3, 1)] });
  assert.equal(compare(target, [same]).matches[0].similarity, 100);
  const flat = compare(target, [record('flat')]).matches[0];
  close(flat.components.price, 298 / 600);
});

test('the half-open horizon excludes samples at and after its boundary', () => {
  const target = record('target');
  const future = record('past', { samples: [point(0), point(300, 1e20, 1e20, 100), point(600, 2, 1e30, 200)] });
  assert.equal(compare(target, [future]).matches[0].similarity, 100);
  assert.ok(compare(target, [future], { horizonSeconds: 420 }).matches[0].similarity < 100);
});

test('a variable common horizon between five and fifteen minutes is supported', () => {
  for (const horizonSeconds of [300, 420, 600, 900]) {
    const result = compare(record('target'), [record('past')], { horizonSeconds });
    assert.equal(result.horizonSeconds, horizonSeconds); assert.equal(result.matches[0].similarity, 100);
  }
});

test('immature target, incomplete coverage, missing origin and declared gaps remain unavailable', () => {
  for (const [changes, extra, code] of [
    [{}, { asOf: 10_299 }, 'immature'],
    [{ completeThrough: 299 }, {}, 'incomplete-coverage'],
    [{ samples: [point(1)] }, {}, 'missing-origin'],
    [{ gaps: [{ from: 50, to: 51 }] }, {}, 'coverage-gap'],
    [{ samples: [point(0, null)] }, {}, 'invalid-sample'],
  ]) {
    const result = compare(record('target', changes), [record('past')], extra);
    assert.equal(result.status, 'unavailable'); assert.equal(result.targetIssue.code, code); assert.deepEqual(result.matches, []);
  }
});

test('known sparse inactivity is valid but missing coverage is never invented', () => {
  assert.equal(compare(record('target'), [record('past')]).matches[0].similarity, 100);
  const result = compare(record('target'), [record('past', { completeThrough: 10 })]);
  assert.equal(result.status, 'no-comparable-history'); assert.equal(result.excluded[0].code, 'incomplete-coverage');
});

test('malformed, nonfinite, out-of-order and decreasing cumulative samples are excluded', () => {
  const cases = [
    [point(0, NaN)], [point(0, Infinity)], [point(0, 0)], [point(0, -1)],
    [point(0, 1, -1)], [point(0, 1, null)], [point(0, 1, 0, 0.5)],
    [point(0), point(0)], [point(0), point(-1)],
    [point(0, 1, 10, 2), point(1, 1, 9, 2)],
    [point(0, 1, 10, 2), point(1, 1, 10, 1)],
    [point(0, Number.MIN_VALUE), point(1, Number.MAX_VALUE)],
  ];
  const result = compare(record('target'), cases.map((samples, i) => record(`bad-${i}`, { samples })));
  assert.equal(result.matches.length, 0); assert.equal(result.excluded.length, cases.length);
});

test('quote units must match exactly and are never implicitly converted', () => {
  const result = compare(record('target'), [record('usdc', { quoteUnit: 'solana:USDC' }), record('usd', { quoteUnit: 'USD' }), record('sol')]);
  assert.deepEqual(result.matches.map((m) => m.id), ['sol']);
  assert.ok(result.excluded.every((e) => e.code === 'incompatible-quote'));
});

test('self, duplicate IDs and launches not older than the target cannot inflate the cohort', () => {
  const result = compare(record('target'), [record('target'), record('dup'), record('dup'), record('future', { launchedAt: 10_001 }), record('same-time', { launchedAt: 10_000 }), record('valid')]);
  assert.deepEqual(result.matches.map((m) => m.id), ['valid']);
  assert.equal(result.excluded.filter((e) => e.code === 'duplicate-id').length, 2);
  assert.equal(result.cohorts.eligible.count, 1);
});

test('outcomes are observed labels, cutoff-aware, never inputs to similarity', () => {
  const library = [
    record('yes', { outcome: { graduated: true, observedAt: 2_000, source: 'synthetic label' } }),
    record('no', { outcome: { graduated: false, observedAt: 2_000 } }),
    record('future-label', { outcome: { graduated: true, observedAt: 10_901 } }),
    record('unknown'), record('unproven-time', { outcome: { graduated: true } }),
  ];
  const result = compare(record('target'), library, { limit: 10 });
  assert.ok(result.matches.every((m) => m.similarity === 100));
  assert.equal(result.cohorts.eligible.graduated, 1); assert.equal(result.cohorts.eligible.notGraduated, 1);
  assert.equal(result.cohorts.eligible.unknown, 3); assert.equal(result.cohorts.eligible.graduatedMeanSimilarity, 100);
});

test('cohort counts distinguish the entire eligible library from returned matches', () => {
  const result = compare(record('target'), [record('a', { outcome: { graduated: true, observedAt: 2_000 } }), record('b')], { limit: 1 });
  assert.equal(result.librarySize, 2); assert.equal(result.cohorts.eligible.count, 2);
  assert.equal(result.cohorts.returned.count, 1); assert.equal(result.cohorts.returned.graduated, 1);
  assert.equal(result.cohorts.eligible.oldestLaunch, 1_000); assert.equal(result.cohorts.eligible.newestLaunch, 1_000);
});

test('ranking and ties are deterministic under library permutations', () => {
  const a = record('a'), z = record('z'), worse = record('worse', { samples: [point(0), point(150, 3, 9, 2)] });
  const first = compare(record('target'), [z, worse, a]);
  const second = compare(record('target'), [a, z, worse]);
  assert.deepEqual(first.matches, second.matches); assert.deepEqual(first.matches.map((m) => m.id), ['a', 'z', 'worse']);
});

test('weights are positive for all three channels and their normalization is stable', () => {
  const target = record('target'), past = record('past', { samples: [point(0), point(150, 2, 10, 2)] });
  const result = compare(target, [past], { weights: { price: 2, volume: 1, buyers: 1 } });
  close(result.matches[0].distance, 0.375);
  const huge = compare(target, [past], { weights: { price: 1e308, volume: 1e308, buyers: 1e308 } });
  close(huge.matches[0].distance, 5 / 12);
  for (const weights of [{ price: 0, volume: 1, buyers: 1 }, { price: 1 }, { price: NaN, volume: 1, buyers: 1 }, { price: Number.MIN_VALUE, volume: Number.MAX_VALUE, buyers: 1 }]) assert.throws(() => compare(target, [past], { weights }), TypeError);
});

test('malformed record metadata and coverage declarations produce explicit exclusions', () => {
  const records = [null, {}, record(' bad '), record('missing-quote', { quoteUnit: '' }),
    record('bad-time', { launchedAt: NaN }), record('bad-coverage', { completeThrough: Infinity }),
    record('bad-gaps', { gaps: null }), record('reversed-gap', { gaps: [{ from: 20, to: 10 }] }),
    record('no-origin', { samples: [] }), record('bad-timestamp', { samples: [point(NaN)] })];
  const result = compare(record('target'), records);
  assert.equal(result.matches.length, 0); assert.equal(result.excluded.length, records.length);
  assert.ok(result.excluded.every((e) => typeof e.code === 'string' && e.detail.length > 0));
  assert.equal(compare(null, []).status, 'unavailable');
  assert.equal(compare(record('target', { gaps: [{ from: 300, to: 400 }] }), [record('past')]).status, 'ok');
});

test('invalid request options fail explicitly and an empty library is honest', () => {
  for (const extra of [{ horizonSeconds: 299 }, { horizonSeconds: 901 }, { horizonSeconds: NaN }, { asOf: undefined }, { limit: 0 }, { limit: 1.5 }]) assert.throws(() => compare(record('target'), [], extra), TypeError);
  assert.throws(() => compare(record('target'), null), TypeError);
  const result = compare(record('target'), []); assert.equal(result.status, 'no-comparable-history');
  assert.equal(result.cohorts.eligible.count, 0); assert.equal(result.cohorts.eligible.graduatedMeanSimilarity, null);
});

test('large finite amounts remain bounded and the function does not mutate frozen input', () => {
  const target = record('target', { samples: [point(0, 1, 1e308, 10)] });
  const past = record('past', { samples: [point(0, 1, 5e307, 5)] });
  const freeze = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
  freeze(target); freeze(past); const library = freeze([past]);
  const before = JSON.stringify([target, library]);
  const result = compare(target, library); close(result.matches[0].components.volume, 0.5);
  assert.equal(JSON.stringify([target, library]), before); assert.ok(Number.isFinite(result.matches[0].similarity));
});
