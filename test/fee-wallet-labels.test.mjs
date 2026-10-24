import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateFeeWallets } from '../src/lib/scan/feewallets.js';

const MAESTRO = 'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36';

test('official fee label takes precedence without consulting cached or remote history', async () => {
  let historyReads = 0;
  const unavailable = async () => { historyReads++; throw new Error('history must not be consulted'); };
  const analysis = { sharedFeeRecipients: [{ address: MAESTRO }] };
  await annotateFeeWallets({ getSignaturesForAddress: unavailable }, analysis, {
    memory: { getRep: unavailable },
  });
  const fee = analysis.sharedFeeRecipients[0];
  assert.equal(fee.label, 'Maestro fee account (official label; shared use does not identify an operator)');
  assert.equal(fee.platform, true);
  assert.equal(fee.payersSeen, null);
  assert.equal(fee.mintsSeen, null);
  assert.equal(historyReads, 0);
});

// Synthetic cached classification records exercise the public annotation path. They are not
// additional on-chain receipts or labels for real accounts. Each address has its own memo entry.
const cases = [
  ['singular', 1, 1, false,
    'only 1 payer in its recent history, across 1 token — private launch-tool or operator fee wallet'],
  ['plural', 3, 2, false,
    'only 3 payers in its recent history, across 2 tokens — private launch-tool or operator fee wallet'],
  ['zero-mints', 1, 0, false,
    'only 1 payer in its recent history — private launch-tool or operator fee wallet'],
  ['unknown-mints', 2, null, false,
    'only 2 payers in its recent history — private launch-tool or operator fee wallet'],
  ['empty-history', 0, 0, false,
    'only 0 payers in its recent history — private launch-tool or operator fee wallet'],
  ['unknown-payers', null, null, false, 'unclassified fee wallet'],
  ['shared-platform', 8, 3, true,
    'trading bot / terminal fee account (many unrelated traders pay it)'],
];

for (const [name, payers, mints, platform, expected] of cases) {
  test(`fee annotation retains upstream fallback wording: ${name}`, async () => {
    const address = `synthetic-fee-label-${name}`;
    let memoryReads = 0, remoteReads = 0;
    const memory = { async getRep(kind, wallet) {
      memoryReads++;
      assert.equal(kind, 'fee');
      assert.equal(wallet, address);
      return { platform, platformPayers: payers, platformMints: mints,
        platformPerMinute: 1, platformCheckedAt: Date.now() };
    } };
    const analysis = { sharedFeeRecipients: [{ address }] };
    await annotateFeeWallets({ async getSignaturesForAddress() {
      remoteReads++; throw new Error('fresh cached history must not request RPC');
    } }, analysis, { memory });
    const fee = analysis.sharedFeeRecipients[0];
    assert.equal(fee.label, expected);
    assert.equal(fee.platform, platform);
    assert.equal(fee.payersSeen, payers);
    assert.equal(fee.mintsSeen, mints);
    assert.equal(memoryReads, 1);
    assert.equal(remoteReads, 0);
  });
}

test('unavailable fee history remains unclassified instead of inventing payer or mint counts', async () => {
  let requests = 0;
  const address = 'synthetic-fee-label-unavailable';
  const analysis = { sharedFeeRecipients: [{ address }] };
  await annotateFeeWallets({ async getSignaturesForAddress(wallet) {
    requests++; assert.equal(wallet, address); throw new Error('synthetic unavailable history');
  } }, analysis);
  const fee = analysis.sharedFeeRecipients[0];
  assert.equal(fee.label, 'unclassified fee wallet');
  assert.equal(fee.platform, false);
  assert.equal(fee.payersSeen, null);
  assert.equal(fee.mintsSeen, null);
  assert.equal(requests, 1);
});
