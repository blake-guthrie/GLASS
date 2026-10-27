import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROGRAMS } from '../src/lib/constants.js';
import { decodeBase58, encodeBase58 } from '../src/lib/base58.js';
import { decodePumpEvent, parseTx } from '../src/lib/txparse.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { runScan } from '../src/lib/scan/pipeline.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-quote-events.json', import.meta.url)));
const historical = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url)));
const { mint, user, curve, cases } = fixture;

test('explicit TradeEvent quotes survive missing or conflicting instructions', () => {
  for (const c of cases.slice(0, 3)) {
    const rec = parseTx(c.tx);
    const [e] = extractLaunchEvents([rec], mint, { record: rec, bondingCurve: curve });
    assert.equal(e.wallet, user, c.name);
    assert.equal(e.quoteMint, PROGRAMS.USDC, c.name);
    assert.equal(e.quoteAmount, 1.5, c.name);
    assert.equal(e.priceQuote, 0.025, c.name);
  }
});

test('partial quote extensions never produce an invented price', () => {
  for (const [c, quoteBytes, trailingBytes] of [[cases[0], 56, 24], [cases[3], 40, 10]]) {
    const event = c.tx.meta.innerInstructions[0].instructions[0];
    const full = decodeBase58(event.data);
    const start = full.length - quoteBytes - trailingBytes;
    for (let n = 1; n < quoteBytes; n++) {
      const tx = structuredClone(c.tx);
      tx.meta.innerInstructions[0].instructions[0].data = encodeBase58(full.subarray(0, start + n));
      const rec = parseTx(tx);
      assert.equal(rec.pumpEvents[0].quoteFieldsInvalid, true, `${c.name}: ${n}`);
      if (quoteBytes === 56) {
        const [e] = extractLaunchEvents([rec], mint, { record: rec, bondingCurve: curve });
        assert.equal(e.priceQuote, null);
        assert.equal(e.quoteAmount, null);
      }
    }
    assert.equal(decodePumpEvent({ ...event, data: encodeBase58(full.subarray(0, start)) }).quoteFieldsInvalid, undefined);
  }
});

test('ambiguous events without quote metadata remain unknown and the SOL fixture stays priced', () => {
  const rec = parseTx(historical.txs.create);
  const t = rec.pumpEvents.find(e => e.type === 'trade');
  const ambiguous = {
    ...rec,
    pumpEvents: rec.pumpEvents.map(e => ({ ...e, quoteMint: undefined })),
    pumpIxs: [PROGRAMS.USDC, PROGRAMS.WSOL].map(quoteMint => ({ kind: 'buy', mint, user: t.user, quoteMint })),
  };
  const [unknown] = extractLaunchEvents([ambiguous], mint, { record: ambiguous, bondingCurve: curve });
  assert.equal(unknown.priceQuote, null);
  const [sol] = extractLaunchEvents([rec], mint, { record: rec, bondingCurve: curve });
  assert.equal(sol.quoteMint, PROGRAMS.WSOL);
  assert.ok(sol.priceQuote > 0);
  assert.equal(rec.pumpIxs.find(ix => ix.kind === 'create').user, user);
});

test('scan prices synthetic USDC and SOL launches with offline transports', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(String(url).startsWith('https://api.dexscreener.com/'));
    const pairs = String(url).endsWith(PROGRAMS.WSOL) ? [{ chainId: 'solana', baseToken: { address: PROGRAMS.WSOL }, quoteToken: { symbol: 'USDC' }, priceUsd: '250' }] : [];
    return new Response(JSON.stringify({ pairs }), { status: 200 });
  });
  for (const c of cases.slice(3)) {
    const rpc = {
      totalCalls: 0, totalDegraded: 0, url: 'offline-fixture',
      async getAccountInfo() { return { value: { data: { parsed: { type: 'mint' } } } }; },
      async getMintInfo() { return { supply: 1e9, tokenProgram: PROGRAMS.TOKEN_2022 }; },
      async getSignaturesForAddress() { return [{ signature: 'offline-idl-fixture', slot: 100, blockTime: 1000 }]; },
      async getTransaction() { return c.tx; },
      async getBlockAccounts() { return { transactions: [] }; },
      async pageSignatures() { return { sigs: [], exhausted: true }; },
    };
    const report = await runScan(rpc, mint, { hintIsMint: true, settings: { slotWindow: 0, earlyWindowSec: 0, maxWalletProfiles: 0, operatorHistory: false, liveTracking: false, jitoLookup: false } });
    assert.deepEqual(report.errors, [], c.name);
    assert.equal(Object.values(report.stages).filter(s => s.status === 'done').length, 7, c.name);
    assert.equal(report.market.priceUsd ?? null, c.expected, c.name);
    assert.equal(report.market.marketCapUsd ?? null, c.expected == null ? null : c.expected * 1e9, c.name);
  }
});
