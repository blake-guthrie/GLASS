// Dev profile (pump.fun creator record) — counting, archetypes, and the call/confidence layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { creatorProfile, summarise, classifyArchetype, toPriorLaunches, normaliseCoin, detectLaunchpad, fetchCoin } from '../src/lib/scan/devprofile.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { rateOperator } from '../src/lib/scan/operator.js';
import { callFor, computeScore } from '../src/lib/scan/score.js';

const CREATOR = 'GJNLXhQPe3pb5uQfPQLiHicZzEPRAruGsUUYCvbZBCtN';
const NOW = 1792386160000;

// Three real rows from pump.fun's API (Oct 2026) + synthetic ones in the same shape
function coin(i, over = {}) {
  return {
    mint: `Mint${String(i).padStart(40, '0')}pump`,
    name: `coin ${i}`,
    symbol: `C${i}`,
    creator: CREATOR,
    created_timestamp: NOW - i * 3600_000,
    complete: false,
    usd_market_cap: 2900,
    market_cap: 28,
    ath_market_cap: 5000,
    ath_market_cap_timestamp: NOW - i * 3600_000,
    last_trade_timestamp: NOW,
    reply_count: 0,
    program: 'pump',
    ...over,
  };
}
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/pumpfun-creator.json', import.meta.url), 'utf8'));
const REAL = FX.rows.map((r) => Object.fromEntries(FX.keep.map((k, i) => [k, r[i]])));

/** Fake pump.fun: `all` coins newest-first; honours offset/limit/order like the real API (max 70 per page). */
function stubFetch(all) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Math.min(70, Number(u.searchParams.get('limit') || 70));
    const order = u.searchParams.get('order') || 'DESC';
    const list = order === 'ASC' ? [...all].reverse() : all;
    // like the real API: nothing past offset 1000, in either direction
    const body = JSON.stringify(offset > 1000 ? [] : list.slice(offset, offset + limit));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('normaliseCoin: USD ATH, graduation, minutes to peak', () => {
  const c = normaliseCoin(REAL.find((x) => x.symbol === 'BOTTLE'));
  assert.equal(c.graduated, true);
  assert.equal(Math.round(c.athMcapUsd), 382919);
  assert.equal(c.minutesToPeak, 96.23); // fractional minutes (96 min 14 s)
  assert.equal(c.url, 'https://pump.fun/coin/rc5QqCeRy58gCa4x3KMXiZNY9b86Z3YF3c3M8JLpump');
});

test('creatorProfile: small creator — exact count, current token separated from the sample', async () => {
  const calls = stubFetch(REAL);
  const p = await creatorProfile(CREATOR, { currentMint: REAL[0].mint });
  assert.equal(p.available, true);
  assert.equal(p.totalCreated, 16);
  assert.equal(p.exact, true);
  assert.equal(p.sample.length, 15);
  assert.equal(p.current.athMcapUsd > 30000, true);
  assert.equal(p.archetype.kind, 'serial');
  assert.equal(calls.length, 1, 'one request for a creator with < 70 coins');
  assert.equal(p.stats.graduated, 8);
  assert.equal(Math.round(p.stats.best.athMcapUsd / 1000), 1585);
  const rating = rateOperator(toPriorLaunches(p, CREATOR), { marketCapUsd: 3000, profile: p });
  assert.equal(rating.rated, 15);
  assert.match(rating.reasons[0], /16 tokens/);
  assert.ok(rating.score >= 30 && rating.score < 65, `8/15 graduated but every launch went back to the floor → bearish/mixed, got ${rating.score}`);
});

test('creatorProfile: token farm — count found by probing, archetype farm, rating capped', async () => {
  const FARM = 'FarmWallet1111111111111111111111111111111111';
  const all = [];
  for (let i = 0; i < 1234; i++) all.push(coin(i, { creator: FARM, created_timestamp: NOW - i * 120_000, ath_market_cap: 4000 + (i % 7) * 300, ath_market_cap_timestamp: NOW - i * 120_000 }));
  const calls = stubFetch(all);
  const p = await creatorProfile(FARM, { currentMint: 'none' });
  assert.equal(p.available, true);
  assert.equal(p.totalCreated, 1234);
  assert.equal(p.exact, true);
  assert.equal(p.sampleFull, true);
  assert.equal(p.archetype.kind, 'farm');
  assert.ok(p.perDay > 100);
  assert.ok(calls.length < 25, `expected a handful of probe requests, got ${calls.length}`);
  const launches = toPriorLaunches(p, FARM);
  assert.equal(launches.length, 210, 'three pages of the newest launches');
  const rating = rateOperator(launches, { marketCapUsd: 5000, profile: p });
  assert.equal(rating.label, 'Token farm');
  assert.ok(rating.score <= 12);
  assert.match(rating.reasons[0], /1,234 tokens/);
  assert.equal(rating.profile.totalCreated, 1234);
});

test('creatorProfile: unreachable API → available:false, nothing thrown', async () => {
  globalThis.fetch = async () => new Response('<html>Just a moment', { status: 403 });
  const p = await creatorProfile('Unreach111111111111111111111111111111111111', { currentMint: 'x' });
  assert.equal(p.available, false);
  assert.ok(p.reason);
});

test('summarise + classifyArchetype thresholds', () => {
  const sample = [1, 2, 3, 4, 5].map((i) => normaliseCoin(coin(i, { ath_market_cap: i * 20_000, complete: i >= 4 })));
  const st = summarise(sample);
  assert.equal(st.n, 5);
  assert.equal(st.medianAthUsd, 60_000);
  assert.equal(st.graduated, 2);
  assert.equal(st.deadRate, 0);
  assert.equal(classifyArchetype({ total: 1, spanDays: 1, last24h: 1, stats: st }).kind, 'first');
  assert.equal(classifyArchetype({ total: 12, spanDays: 60, last24h: 1, stats: st }).kind, 'serial');
  assert.equal(classifyArchetype({ total: 80, spanDays: 2, last24h: 30, stats: { n: 10, ranRate: 0 } }).kind, 'farm');
  assert.equal(classifyArchetype({ total: 80, spanDays: 2, last24h: 30, stats: { n: 10, ranRate: 0.6 } }).kind, 'serial', 'a prolific dev whose launches run is not a farm');
});

function launch({ bundle = 0, bundleCount = 0, snipers = 0, organic = 0, dev = 0, classified = true } = {}) {
  return {
    classified,
    bundle: { pct: bundle, count: bundleCount, wallets: [] },
    snipers: { pct: snipers, count: 0 },
    organic: { pct: organic, count: 0 },
    window: { pct: bundle + snipers + organic, count: bundleCount, slotWindow: 3 },
    slot0: { pct: 0, count: 0 },
    creatorDevBuy: { pct: dev },
    fingerprints: { uniformity: 0 },
    jito: {},
    launchToolPattern: { detected: false, reasons: [] },
  };
}

test('callFor: the four levels and confidence', () => {
  // token farm → avoid regardless of this launch's shape
  let c = callFor({ score: 10, launch: launch({ organic: 60 }), wallets: {}, live: null, operator: { rated: 5, score: 8 }, ctx: { profile: { archetype: { kind: 'farm' }, totalCreated: 5092, stats: { ranRate: 0.01 } }, operatorDone: true } });
  assert.equal(c.level, 'avoid');
  assert.match(c.why[0], /5,092 tokens/);
  // dumping now → avoid
  c = callFor({ score: 50, launch: launch({ bundle: 12, bundleCount: 9, dev: 58 }), wallets: {}, live: { summary: { dumpingNow: 12, clusterSoldShare: 0.88 } }, operator: { rated: 3, score: 34 }, ctx: { operatorDone: true } });
  assert.equal(c.level, 'avoid');
  // bundled, bullish operator → interesting
  c = callFor({ score: 40, launch: launch({ bundle: 12, bundleCount: 5 }), wallets: {}, live: { summary: {} }, operator: { rated: 6, score: 72 }, ctx: { operatorDone: true } });
  assert.equal(c.level, 'interesting');
  // bundled, unknown history → caution, confidence drops
  c = callFor({ score: 40, launch: launch({ bundle: 13, bundleCount: 5, dev: 3 }), wallets: {}, live: { summary: {} }, operator: { rated: 0, score: null }, ctx: { operatorDone: true } });
  assert.equal(c.level, 'caution');
  assert.equal(c.confidence, 'medium');
  // clean → interesting, high confidence
  c = callFor({ score: 8, launch: launch({ organic: 70, snipers: 4, dev: 1 }), wallets: {}, live: { summary: {} }, operator: { rated: 0, score: null }, ctx: { operatorDone: true } });
  assert.equal(c.level, 'interesting');
  assert.equal(c.confidence, 'high');
  // snipers heavy → caution
  c = callFor({ score: 20, launch: launch({ organic: 10, snipers: 35 }), wallets: {}, live: { summary: {} }, operator: { rated: 0, score: null }, ctx: { operatorDone: true } });
  assert.equal(c.level, 'caution');
  // nothing yet → low confidence
  c = callFor({ score: 0, launch: null, wallets: null, live: null, operator: null, ctx: {} });
  assert.equal(c.confidence, 'low');
});

test('computeScore carries the call', () => {
  const s = computeScore({ launch: launch({ organic: 70, snipers: 4 }), wallets: {}, live: null, operator: null, ctx: { operatorDone: true } });
  assert.ok(s.call);
  assert.equal(s.call.word, 'Interesting');
});

function farm(n, wallet) {
  const t0 = Date.now(); // the minting-rate maths runs against the real clock
  const all = [];
  for (let i = 0; i < n; i++) all.push(coin(i, { creator: wallet, mint: `M${wallet.slice(0, 4)}${String(i).padStart(38, '0')}`, created_timestamp: t0 - i * 120_000, ath_market_cap: 4000, ath_market_cap_timestamp: t0 - i * 120_000 }));
  return all;
}

test('creatorProfile: 1,500 coins — past the API offset cap, still counted exactly from both ends', async () => {
  const W = 'FarmWallet2222222222222222222222222222222222';
  stubFetch(farm(1500, W));
  const p = await creatorProfile(W, { currentMint: 'none' });
  assert.equal(p.totalCreated, 1500);
  assert.equal(p.exact, true);
  assert.equal(p.atLeast, false);
});

test('creatorProfile: 5,202 coins — API cannot list them all, so "2,000+" and the recent minting rate', async () => {
  const W = 'FarmWallet3333333333333333333333333333333333';
  stubFetch(farm(5202, W));
  const p = await creatorProfile(W, { currentMint: 'none' });
  assert.equal(p.totalCreated, 2000);
  assert.equal(p.atLeast, true);
  assert.equal(p.countCapped, true);
  assert.equal(p.perDayRecent, true);
  assert.ok(Math.abs(p.perDay - 720) < 5, `one coin every 2 min ≈ 720/day, got ${p.perDay}`);
  assert.equal(p.archetype.kind, 'farm');
  const rating = rateOperator(toPriorLaunches(p, W), { marketCapUsd: 5000, profile: p });
  assert.match(rating.reasons[0], /2,000\+ tokens/);
  assert.match(rating.reasons[0], /per day lately/);
});

test('creatorProfile: Bonk (letsbonk.fun) creator history via Raydium LaunchLab', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('launch-mint-v1.raydium.io/get/by/user')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            rows: [
              {
                mint: 'BonkMint11111111111111111111111111111111bonk',
                name: 'Bonk Doge',
                symbol: 'BDOGE',
                creator: 'BonkCreator111',
                createAt: 1760000000000,
                athAt: 1760000900000,
                marketCap: 42000,
                athMarketCap: 120000,
                finishingRate: 100,
                migrateAmmId: 'RayPool111111111111111111111111111111111111',
                platformInfo: { name: 'LetsBonk.fun', pubKey: PROGRAMS.BONK_PLATFORM_CONFIG },
              },
              {
                mint: 'BonkMint22222222222222222222222222222222bonk',
                name: 'Bonk Cat',
                symbol: 'BCAT',
                creator: 'BonkCreator111',
                createAt: 1759900000000,
                marketCap: 4500,
                athMarketCap: 6200,
                finishingRate: 12,
                platformInfo: { name: 'LetsBonk.fun', pubKey: PROGRAMS.BONK_PLATFORM_CONFIG },
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('[]', { status: 200 });
  };
  const p = await creatorProfile('BonkCreator111', {
    currentMint: 'BonkMint11111111111111111111111111111111bonk',
    launchpad: 'bonk',
  });
  assert.equal(p.available, true);
  assert.equal(p.source, 'bonk');
  assert.equal(p.totalCreated, 2);
  assert.equal(p.current.symbol, 'BDOGE');
  assert.equal(p.current.graduated, true);
  assert.equal(p.current.url, 'https://letsbonk.fun/token/BonkMint11111111111111111111111111111111bonk');
  assert.equal(p.sample.length, 1);
  assert.equal(p.sample[0].symbol, 'BCAT');
  const prior = toPriorLaunches(p, 'BonkCreator111');
  assert.equal(prior.length, 1);
  assert.equal(prior[0].source, 'bonk');
  assert.ok(prior[0].linkedBy[0].how.includes('bonk record'));
  const rating = rateOperator(prior, { profile: p });
  assert.ok(rating.reasons.some((r) => r.includes('Bonk')));
});

test('creatorProfile: Raydium LaunchLab creator history via launchProgram detection', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('launch-mint-v1.raydium.io/get/by/user')) {
      return new Response(
        JSON.stringify({
          data: {
            rows: [
              {
                mint: 'LLMint11111111111111111111111111111111111111',
                name: 'Ray Lab One',
                symbol: 'RLAB1',
                creator: 'LaunchLabCreator222',
                createAt: 1760100000,
                athAt: 1760101800,
                marketCap: 88000,
                athMarketCap: 310000,
                complete: true,
                migrateAmmId: 'RayCpmmPool11111111111111111111111111111111',
                platformInfo: { name: 'Raydium LaunchLab', pubKey: 'RayPlat111111111111111111111111111111111111' },
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('[]', { status: 200 });
  };
  const p = await creatorProfile('LaunchLabCreator222', {
    currentMint: 'other',
    launchProgram: PROGRAMS.RAYDIUM_LAUNCHLAB,
  });
  assert.equal(p.available, true);
  assert.equal(p.source, 'launchlab');
  assert.equal(p.totalCreated, 1);
  assert.equal(p.sample[0].symbol, 'RLAB1');
  assert.equal(p.sample[0].graduated, true);
  assert.equal(p.sample[0].minutesToPeak, 30);
  const rating = rateOperator(toPriorLaunches(p, 'LaunchLabCreator222'), { profile: p });
  assert.ok(rating.reasons.some((r) => r.includes('Raydium LaunchLab')));
});

test('creatorProfile: Meteora DBC creator history + automatic fallback when pump.fun has 0 coins', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('dbc-api.meteora.ag/pools')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              baseMint: 'MetMint1111111111111111111111111111111111111',
              poolAddress: 'MetPool1111111111111111111111111111111111111',
              name: 'Meteora Comet',
              symbol: 'MCOMET',
              creator: 'MeteoraCreator333',
              createdAt: 1760200000000,
              athAt: 1760203600000,
              marketCap: 95000,
              athMarketCap: 410000,
              isMigrated: true,
            },
            {
              baseMint: 'MetMint2222222222222222222222222222222222222',
              poolAddress: 'MetPool2222222222222222222222222222222222222',
              name: 'Meteora Dust',
              symbol: 'MDUST',
              creator: 'MeteoraCreator333',
              createdAt: 1760150000000,
              marketCap: 3200,
              athMarketCap: 5100,
              isMigrated: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = await creatorProfile('MeteoraCreator333', {
    currentMint: 'MetMint1111111111111111111111111111111111111',
  });
  assert.equal(p.available, true);
  assert.equal(p.source, 'meteora');
  assert.equal(p.totalCreated, 2);
  assert.equal(p.current.symbol, 'MCOMET');
  assert.equal(p.current.graduated, true);
  assert.equal(p.sample.length, 1);
  assert.equal(p.sample[0].symbol, 'MDUST');
  assert.equal(p.sample[0].dexId, 'meteora-dbc');
  const rating = rateOperator(toPriorLaunches(p, 'MeteoraCreator333'), { profile: p });
  assert.ok(rating.reasons.some((r) => r.includes('Meteora')));
});

test('fetchCoin & detectLaunchpad: falls back to LaunchLab and Meteora when mint is not on pump.fun', async () => {
  globalThis.fetch = async (url) => {
    if (url.includes('launch-mint-v1.raydium.io/get/by/mints')) {
      return new Response(
        JSON.stringify({
          data: {
            rows: [
              {
                mint: 'LLSingleMint999',
                name: 'Single Lab Coin',
                symbol: 'SLAB',
                createAt: 1760300000000,
                marketCap: 50000,
                athMarketCap: 150000,
                complete: true,
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  };
  assert.equal(detectLaunchpad({ launchProgram: PROGRAMS.RAYDIUM_LAUNCHLAB }), 'launchlab');
  assert.equal(detectLaunchpad({ launchProgram: PROGRAMS.METEORA_DBC }), 'meteora');
  assert.equal(detectLaunchpad({ platformInfo: { name: 'LetsBonk.fun' } }), 'bonk');
  const c = await fetchCoin('LLSingleMint999');
  assert.ok(c);
  assert.equal(c.symbol, 'SLAB');
  assert.equal(c.source, 'launchlab');
  assert.equal(c.athMcapUsd, 150000);
});
