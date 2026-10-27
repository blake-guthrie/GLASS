import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyseLaunch } from '../src/lib/scan/fingerprint.js';
import { PROGRAMS } from '../src/lib/constants.js';

// Exercise the actual panel methods without starting a browser session or changing production exports.
const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const context = vm.createContext({ chrome: { runtime: { getURL: x => x } }, document: { addEventListener() {} }, clearTimeout() {}, setTimeout() {} });
vm.runInContext(source.replace('let panel = null;', 'globalThis.TestPanel = Panel; let panel = null; globalThis.testLive = (p, ev) => { panel = p; onLiveEvent(ev); };'), context);
const panel = Object.create(context.TestPanel.prototype);
panel.sec = (_id, _title, _subtitle, html) => html;
const event = { wallet: 'buyer', side: 'buy', tokens: 1e6, slotOffset: 0, secOffset: 0, quoteMint: PROGRAMS.USDC, quoteAmount: 1.5, sol: null };

for (const [name, events, expected] of [
  ['USDC', [event], /1\.50 USDC/],
  ['SOL', [{ ...event, quoteMint: PROGRAMS.WSOL, quoteAmount: 2, sol: 2 }], /2\.00◎/],
  ['mixed', [event, { ...event, quoteMint: PROGRAMS.WSOL, quoteAmount: 2, sol: 2 }], /2\.00◎ \+ 1\.50 USDC/],
  ['missing', [{ ...event, quoteAmount: null }], /— spent/],
]) {
  test(`launch and receipt panels render ${name} amounts in their own units`, () => {
    const report = { launch: analyseLaunch(events), supply: 1e9 };
    const launch = panel.secLaunch(report);
    assert.match(launch, expected);
    const receipts = panel.secReceipts(report);
    assert.match(receipts, /Quote currency the wallet spent on its launch buys/);
    assert.doesNotMatch(receipts, /SOL paid/);
    if (name === 'USDC') {
      assert.match(receipts, /1\.50 USDC/);
      assert.doesNotMatch(receipts, /0\.000◎/);
    }
  });
}

test('activity panel retains USDC sell proceeds and coordinated totals', () => {
  const report = { supply: 1e9, live: {
    events: [{ ...event, side: 'sell', t: Date.now(), quotes: { sol: 0, usdc: 1.5, unknown: 0 } }],
    exitEvents: [{ wallets: 2, pct: 1, minutesAfterLaunch: 2, quotes: { sol: 0, usdc: 3, unknown: 0 }, sol: 0 }],
  } };
  const html = panel.activityFeed(report);
  assert.match(html, /for 1\.50 USDC/);
  assert.match(html, /3\.00 USDC/);
  assert.doesNotMatch(html, /0\.000◎/);
});

test('prior launch panel keeps USDC exit proceeds separate from SOL', () => {
  const report = { operator: { launches: [{
    mint: 'prior-launch', symbol: 'PRIOR', url: 'https://example.com/prior',
    source: 'pump.fun', relation: 'created',
    clusterExit: { sells: 1, soldShare: 0.5, firstSellSec: 30, firstSellMin: 0.5,
      solOut: 0, quotesOut: { sol: 0, usdc: 12.5, unknown: 0 } },
  }] } };
  const html = panel.secOperator(report);
  assert.match(html, /sold 50% of their bag for 12\.50 USDC/);
  assert.match(html, /\+30s/);
  assert.doesNotMatch(html, /for [\d.]+ SOL/);
  report.operator.launches[0].clusterExit.quotesOut = { sol: 2, usdc: 12.5, unknown: 0 };
  assert.match(panel.secOperator(report), /for 2\.00◎ \+ 12\.50 USDC/);
});


test('live price updates convert USDC and SOL independently', () => {
  for (const [quoteSymbol, expected] of [['USDC', 25e6], ['SOL', 6250e6], [null, null]]) {
    const p = { report: { supply: 1e9, solUsd: 250, market: {} } };
    context.testLive(p, { type: 'curve', quoteSymbol, priceQuote: 0.025 });
    assert.equal(p.liveState.curve.mcapUsd, expected);
  }
});
