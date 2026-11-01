import { test } from 'node:test';
import assert from 'node:assert/strict';
import known from '../src/data/known.js';
import { ROUTER_LABELS } from '../src/lib/constants.js';
import { routeLabel, toolPatternReasons } from '../src/lib/scan/fingerprint.js';
import { annotateFeeWallets } from '../src/lib/scan/feewallets.js';

test('known launchers: resolves Rapid Launch dedicated fee collectors', () => {
  const currentCollector = 'rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ';
  const legacyCollector = 'feesEi65EDHZ7jVMPUicJtnCyTnsoqnQB93GHqLZ6BC';

  assert.equal(known.launchers[currentCollector], 'Rapid Launch');
  assert.equal(known.launchers[legacyCollector], 'Rapid Launch (Legacy)');
});

test('known programs and routers: resolves Rapid Launch deployment program ID', () => {
  const rapidProgram = 'rapidV5DAKtecYzetwCNoxXWHpezjeg4hGt9BGiVcGW';

  assert.equal(known.programs[rapidProgram], 'Rapid Launch');
  assert.equal(ROUTER_LABELS[rapidProgram], 'Rapid Launch');
  assert.equal(routeLabel(rapidProgram), 'Rapid Launch');
});

test('annotateFeeWallets: labels confirmed launcher fee account without network RPC overhead', async () => {
  const mockRpc = {
    getSignaturesForAddress: () => {
      throw new Error('RPC should not be called for known launcher fee wallets');
    },
  };

  const analysis = {
    sharedFeeRecipients: [
      {
        address: 'rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ',
        wallets: ['WalletA11111111111111111111111111111111111', 'WalletB11111111111111111111111111111111111'],
      },
    ],
  };

  const result = await annotateFeeWallets(mockRpc, analysis);
  assert.equal(result.length, 1);
  assert.equal(result[0].launcher, 'Rapid Launch');
  assert.equal(result[0].platform, false);
  assert.equal(result[0].label, 'launched with Rapid Launch (confirmed fee account)');
});

test('toolPatternReasons: formats coordination signal with launcher label when present', () => {
  const analysis = {
    slot0Count: 3,
    sharedFeeRecipients: [
      {
        address: 'rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ',
        wallets: ['W1', 'W2', 'W3'],
        launcher: 'Rapid Launch',
        platform: false,
      },
    ],
  };

  const reasons = toolPatternReasons(analysis);
  assert.ok(reasons.some((r) => r.includes('paid the same non-protocol fee wallet (Rapid Launch) (rapi…)')));
});
