import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTx, classifyForMint } from '../src/lib/txparse.js';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';
import { trackCluster } from '../src/lib/scan/live.js';
import { devExitOnLaunch, clusterExitOnLaunch } from '../src/lib/scan/operator.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';

const f = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-quote-events.json', import.meta.url)));
const sellTx = structuredClone(f.cases[0].tx);
const ev = sellTx.meta.innerInstructions[0].instructions[0];
const bytes = decodeBase58(ev.data);
bytes[16 + 32 + 8 + 8] = 0; // Anchor CPI + event discriminator + mint + legacy amounts, then is_buy.
ev.data = encodeBase58(bytes);
sellTx.blockTime = 1010;
const launch = { mint: f.mint, creator: f.user, createdAt: 1000 * 1000, launchBuyers: [], clusterWallets: [] };
const rpc = {
  async ataFor() { return 'offline-ata'; },
  async getSignaturesForAddress() { return [{ signature: 'offline-sell', blockTime: 1010 }]; },
  async getTransactions() { return [sellTx]; },
  async getTokenBalances() { return [{ owner: f.user, amount: 0 }]; },
};

test('parsed trade and wallet classifier retain USDC units', () => {
  const rec = parseTx(sellTx);
  const trade = rec.pumpEvents.find(e => e.type === 'trade');
  assert.equal(trade.quoteAmount, 1.5);
  assert.equal(trade.priceQuote, 0.025);
  const c = classifyForMint(rec, f.mint, f.user);
  assert.equal(c.quoteMint, PROGRAMS.USDC);
  assert.equal(c.quoteAmount, 1.5);
  assert.equal(c.sol, null);
});

test('live cluster activity retains the matching trader quote', async () => {
  const r = await trackCluster(rpc, f.mint, [{ wallet: f.user, tokens: 60 }], { launchTimeSec: 1000, supply: 1e9 });
  const e = r.events.find(e => e.side === 'sell');
  assert.equal(e.quoteMint, PROGRAMS.USDC);
  assert.equal(e.quoteAmount, 1.5);
  assert.equal(e.priceQuote, 0.025);
  assert.equal(e.sol, null);
});

for (const solPrice of [null, 250]) {
  test(`USDC dev and cluster exit caps do not require or multiply SOL price (${solPrice})`, async () => {
    const dev = await devExitOnLaunch(rpc, f.user, launch, 1e9, solPrice);
    const cluster = await clusterExitOnLaunch(rpc, launch, [], new Map(), null, 1e9, solPrice);
    assert.equal(dev.mcapAtFirstSellUsd, 25e6);
    assert.equal(cluster.mcapAtFirstSellUsd, 25e6);
    assert.equal(dev.sellsDetail[0].quoteMint, PROGRAMS.USDC);
    assert.equal(cluster.sellsDetail[0].quoteMint, PROGRAMS.USDC);
  });
}

test('USDC balance fallback uses token deltas rather than network fees', () => {
  for (const side of ['buy', 'sell']) {
    const rec = parseTx(f.cases[0].tx);
    rec.pumpEvents = [];
    rec.pumpIxs[0].kind = side;
    rec.tokenDeltas = [
      { owner: f.user, mint: f.mint, delta: side === 'buy' ? 60 : -60 },
      { owner: f.user, mint: PROGRAMS.USDC, delta: side === 'buy' ? -1.5 : 1.5 },
    ];
    for (const result of [classifyForMint(rec, f.mint, f.user), extractLaunchEvents([rec], f.mint, { record: rec, bondingCurve: f.curve })[0]]) {
      assert.equal(result.quoteMint, PROGRAMS.USDC);
      assert.equal(result.quoteAmount, 1.5);
      assert.equal(result.sol, null);
    }
    rec.tokenDeltas.pop();
    const missing = classifyForMint(rec, f.mint, f.user);
    assert.equal(missing.quoteAmount, null);
    assert.equal(missing.sol, null);
  }
});

test('SOL exit conversion retains SOL units and unknown quote stays unpriced', async () => {
  for (const [quoteMint, expected] of [[PROGRAMS.WSOL, 6.25e6], [PROGRAMS.TOKEN, null]]) {
    const tx = structuredClone(sellTx);
    const event = tx.meta.innerInstructions[0].instructions[0];
    const data = decodeBase58(event.data);
    // The fixture has 56 quote bytes followed by 24 extra IDL fields.
    data.set(decodeBase58(quoteMint), data.length - 56 - 24);
    event.data = encodeBase58(data);
    const client = { ...rpc, async getTransactions() { return [tx]; } };
    const dev = await devExitOnLaunch(client, f.user, launch, 1e9, 250);
    const cluster = await clusterExitOnLaunch(client, launch, [], new Map(), null, 1e9, 250);
    assert.equal(dev.mcapAtFirstSellUsd, expected);
    assert.equal(cluster.mcapAtFirstSellUsd, expected);
  }
});


test('launch and classified aggregates preserve quote units and missing amounts', async () => {
  const { analyseLaunch, applyWalletKinds } = await import('../src/lib/scan/fingerprint.js');
  const event = { wallet: 'buyer', side: 'buy', tokens: 10, slotOffset: 0, secOffset: 0, quoteMint: PROGRAMS.USDC, quoteAmount: 1.5, sol: null };
  const a = analyseLaunch([event, { ...event, quoteAmount: 2 }, { ...event, side: 'sell', quoteAmount: 0.5, tokens: 2 },
    { ...event, wallet: 'dev', isCreator: true }, { ...event, wallet: 'sol', quoteMint: PROGRAMS.WSOL, quoteAmount: 3, sol: 3 },
    { ...event, wallet: 'missing', quoteAmount: null }]);
  assert.deepEqual(a.window.quotes, { sol: 3, usdc: 3.5, unknown: 1 });
  assert.deepEqual(a.creatorDevBuy.quotes, { sol: 0, usdc: 1.5, unknown: 0 });
  const buyer = a.buyers.find(b => b.wallet === 'buyer');
  assert.equal(buyer.quotes.usdc, 3.5);
  assert.equal(buyer.quotesOut.usdc, 0.5);
  assert.equal(buyer.tokens, 18);
  applyWalletKinds(a, []);
  assert.deepEqual(a.bundle.quotes, a.window.quotes);
});

test('live and historical sell totals preserve USDC proceeds', async () => {
  const live = await trackCluster(rpc, f.mint, [{ wallet: f.user, tokens: 60 }], { launchTimeSec: 1000, supply: 1e9 });
  assert.deepEqual(live.summary.clusterSoldQuotes, { sol: 0, usdc: 1.5, unknown: 0 });
  const dev = await devExitOnLaunch(rpc, f.user, launch, 1e9, null);
  assert.deepEqual(dev.quotesOut, { sol: 0, usdc: 1.5, unknown: 0 });
});


test('captured mainnet SOL buy and sell retain legacy units', () => {
  const live = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-mainnet-sol.json', import.meta.url)));
  for (const [i, expected] of [[0, 0.005432098], [1, 0.003416834]]) {
    const rec = parseTx(live.cases[i].tx, live.cases[i].signature);
    assert.equal(rec.err, null);
    const e = rec.pumpEvents.find(e => e.type === 'trade');
    assert.equal(e.quoteMint, PROGRAMS.WSOL);
    assert.equal(e.quoteAmount, expected);
    assert.equal(e.isBuy, i === 0);
    const c = classifyForMint(rec, e.mint, e.user);
    assert.equal(c.sol, expected);
    assert.equal(c.quoteAmount, expected);
  }
});


test('captured mainnet USDC buy and sell preserve six-decimal quotes through classification', () => {
  const live = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-mainnet-usdc.json', import.meta.url)));
  for (const [i, amount, virtualQuote, virtualTokens] of [[0, 0.100966, 4.012647, 1498400562.720224], [1, 0.202025, 3.810622, 1577840216.899361]]) {
    const rec = parseTx(live.cases[i].tx, live.cases[i].signature);
    assert.equal(rec.err, null);
    const e = rec.pumpEvents.find(e => e.type === 'trade');
    assert.equal(e.quoteMint, PROGRAMS.USDC);
    assert.equal(e.quoteAmount, amount);
    assert.equal(e.priceQuote, virtualQuote / virtualTokens);
    assert.equal(e.isBuy, i === 0);
    const classified = classifyForMint(rec, live.mint, live.user);
    const [launch] = extractLaunchEvents([rec], live.mint, { record: rec, bondingCurve: live.curve.pubkey });
    for (const c of [classified, launch]) {
      assert.equal(c.quoteMint, PROGRAMS.USDC);
      assert.equal(c.quoteAmount, amount);
      assert.equal(c.sol, null);
      assert.equal(c.priceQuote, e.priceQuote);
    }
  }
});
