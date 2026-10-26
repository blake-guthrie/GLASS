import { address,completeReport } from './worker-fixtures.mjs';
import { PROGRAMS } from '../../src/lib/constants.js';
import { extractLaunchRecord } from '../../src/lib/scan/similar.js';
export const NOW = Date.now(), DAY = 86_400_000;
// Synthetic algorithm cases, not invented chain history. Wallet rotation changes no behavioral input.
export function report(n = 1, launchAt = NOW-DAY*2) {
  const r = completeReport(address(n),launchAt+65_000);
  r.creation.createdAt = launchAt; r.creation.creator = address(n+30);
  r.launch.classified = true; r.launch.window.count = 4;
  r.launch.buyers = [0,1,2,3].map((i) => ({ wallet:address(n*4+i+50),firstSlotOffset:i % 2,
    boughtPct:5,cuLimit:200000,cuPrice:1000,tip:0,route:PROGRAMS.PUMP,
    fingerprint:'200000|1000|0|pump|5|10',kind:i === 3 ? 'organic' : 'bundle' }));
  r.wallets = { profiles:r.launch.buyers.map((b) => ({ wallet:b.wallet,fundingMethod:'transfer',fundingKind:'linked',historyTruncated:false })) };
  return r;
}
export const record = (n = 1,launchAt = NOW-DAY*2,source = 'fixture') => extractLaunchRecord(report(n,launchAt),{source});
export const price = (r,at,priceUsd,source = 'fixture-price') => ({kind:'price',at,priceUsd,source,evidence:`https://evidence.invalid/${r.mint}`});
export const exit = (r,soldFraction,complete = true,source = 'fixture-exit') => ({kind:'exit-window',at:r.launchAt+90*60_000,source,evidence:`https://evidence.invalid/${r.mint}`,
  basis:'initial-launch-cluster',windowStart:r.launchAt,windowEnd:r.launchAt+90*60_000,complete,soldFraction,
  initialTokens:100,soldTokens:soldFraction*100,cohortWallets:[...r.identity.cluster]});
