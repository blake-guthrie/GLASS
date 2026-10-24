import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractLaunchRecord,validLaunchRecord,compareLaunches,observedOutcome,summarizeOutcomes,validateObservation } from '../src/lib/scan/similar.js';
import { LaunchHistory } from '../worker/history.mjs';
import { address,temporaryStore } from './helpers/worker-fixtures.mjs';
import { report,record,price,exit,NOW,DAY } from './helpers/similar-fixtures.mjs';

test('all four behavioral dimensions match rotated wallets; exact wallet evidence stays separate',()=>{
  const a=record(1),b=record(2);assert.ok(validLaunchRecord(a));assert.ok(validLaunchRecord(b));
  const c=compareLaunches(a,b);assert.equal(c.accepted,true);assert.equal(c.score,100);
  assert.deepEqual(c.components,{transaction:100,funding:100,sniper:100,shape:100});
  assert.deepEqual(c.exactWalletEvidence,{sameReportedCreator:false,sharedLaunchBuyers:0});
  const same=compareLaunches(a,a);assert.equal(same.exactWalletEvidence.sharedLaunchBuyers,4);
  const raw=report();raw.rpc.url='PRIVATE';assert.doesNotMatch(JSON.stringify(extractLaunchRecord(raw)),/PRIVATE|settings|rpc/);
});

test('conflicting transaction, funding, sniper and slot-shape controls each reject',()=>{
  const a=record();
  for(const dimension of ['transaction','funding','sniper','shape']){
    const b=record(2);for(const g of Object.values(b.features[dimension].groups))g.bins={different:1};
    const c=compareLaunches(a,b);assert.equal(c.accepted,false,dimension);assert.equal(c.components[dimension],0);
    assert.ok(c.reasons.includes('conflicting-dimension'));
  }
});

test('common infrastructure, sparse samples, truncated funding and missing classification cannot imply identity',()=>{
  const a=record();
  for(const mutate of [(r)=>r.genericShare=.7,(r)=>r.sample.capturedBuyers=2,(r)=>r.features.funding.samples=2,
    (r)=>Object.values(r.features.funding.groups).forEach((g)=>{g.coverage=0;g.bins={};})]){
    const b=record(2);mutate(b);assert.equal(compareLaunches(a,b).accepted,false);
  }
  const r=report(3);r.wallets.profiles.forEach((p)=>p.historyTruncated=true);r.launch.classified=false;
  const extracted=extractLaunchRecord(r);assert.equal(extracted.features.funding.samples,0);assert.equal(extracted.features.sniper.groups.mix.coverage,0);
  assert.equal(compareLaunches(a,extracted).accepted,false);
  for(const mark of [(r)=>r.launch.buyers.forEach((b)=>b.kind='sniper'),
    (r)=>r.launch.sharedFeeRecipients=[{platform:true,wallets:r.launch.buyers.map((b)=>b.wallet)}],
    (r)=>r.wallets.profiles.forEach((p)=>p.fundingKind='exchange')]){
    const common=report(4);mark(common);const feature=extractLaunchRecord(common);assert.equal(feature.genericShare,1);
    assert.ok(compareLaunches(a,feature).reasons.includes('common-infrastructure'));
  }
});

test('threshold, per-dimension floor and coverage boundary are explicit and deterministic',()=>{
  const a=record(),b=record(2);
  for(const g of Object.values(b.features.transaction.groups))g.bins=Object.fromEntries([...Object.entries(g.bins).map(([k,v])=>[k,v*.4]),['other',.6]]);
  assert.equal(compareLaunches(a,b).score,85);assert.equal(compareLaunches(a,b).accepted,false); // 40 fails dimension floor
  const c=record(3);for(const d of ['transaction','funding','sniper','shape'])for(const g of Object.values(c.features[d].groups)){
    g.bins=Object.fromEntries([...Object.entries(g.bins).map(([k,v])=>[k,v*.85]),['other',.15]]);g.coverage=.6;
  }
  assert.ok(Math.abs(compareLaunches(a,c).score-85)<1e-10);assert.equal(compareLaunches(a,c).accepted,true);
  c.features.sniper.groups.mix.coverage=.599;assert.equal(compareLaunches(a,c).accepted,false);
});

test('normalization preserves launch-slot scale, token allocation and sample coverage',()=>{
  const a=record(),r=report(2);r.launch.buyers.forEach((b)=>{b.firstSlotOffset=3;b.boughtPct=.1;});
  const b=extractLaunchRecord(r);assert.ok(compareLaunches(a,b).components.shape<60);
  r.launch.window.count=20;const sparse=extractLaunchRecord(r);assert.equal(sparse.features.shape.groups.slots.coverage,.2);
  assert.equal(compareLaunches(a,sparse).accepted,false);
});

test('observed peak median and dump fractions use genuine known denominators; unknown stays null',()=>{
  const a=record(1),b=record(2),c=record(3);
  a.observations=[price(a,a.launchAt+60_000,2),price(a,a.launchAt+600_000,8),exit(a,.5)];
  b.observations=[price(b,b.launchAt+60_000,2),price(b,b.launchAt+600_000,4),exit(b,.4)];
  c.observations=[exit(c,1,false)];
  const summary=summarizeOutcomes([a,b,c],NOW);assert.equal(summary.medianObservedPeakMultiple,3);
  assert.equal(summary.knownPeaks,2);assert.equal(summary.unknownPeaks,1);assert.equal(summary.knownExitWindows,2);
  assert.equal(summary.unknownExitWindows,1);assert.equal(summary.rapidDumpFraction,.5);
  const empty=summarizeOutcomes([record(4)],NOW);assert.equal(empty.medianObservedPeakMultiple,null);assert.equal(empty.rapidDumpFraction,null);
  assert.equal(observedOutcome(a,NOW).baselineUsd,2);assert.equal(observedOutcome(a,NOW).peakUsd,8);
});

test('outcomes exclude future observations, late baselines, mismatched sources and incomplete or conflicting windows',()=>{
  const r=record();r.observations=[price(r,r.launchAt+60_000,2),price(r,r.launchAt+600_000,8),exit(r,1)];
  assert.equal(observedOutcome(r,r.launchAt+120_000).observedPeakMultiple,null);assert.equal(observedOutcome(r,r.launchAt+120_000).rapidDump,null);
  r.observations[1].source='different-provider';assert.equal(observedOutcome(r,NOW).observedPeakMultiple,null);
  r.observations[0].at=r.launchAt+301_000;assert.equal(observedOutcome(r,NOW).observedPeakMultiple,null);
  r.observations.push(exit(r,0,true,'other-exit'));assert.equal(observedOutcome(r,NOW).rapidDump,null);
  for(const o of [{...exit(r,1),windowEnd:r.launchAt+1},{...exit(r,1),soldFraction:2},price(r,NOW+1,2),{...price(r,NOW,2),evidence:'https://x.invalid/?token=secret'}])assert.throws(()=>validateObservation(o,r,NOW));
  const raw=report();raw.market={priceUsd:2,athMcapUsd:900,pairAddress:address(90),mcapSource:'curve estimate'};
  assert.equal(extractLaunchRecord(raw).observations.length,0);
});

test('history disk restart, mint/source/profile dedup, cutoff, window boundary, ties and future exclusions',async(t)=>{
  const store=await temporaryStore(t),h=await new LaunchHistory(store.directory,{},()=>NOW).open();
  const target=record(10,NOW-120_000),a=record(1,target.launchAt-DAY),b=record(2,target.launchAt-DAY),boundary=record(3,target.launchAt-30*DAY);
  const old=record(4,boundary.launchAt-1),future=record(5,target.launchAt+1),late=record(6,target.launchAt-DAY);
  late.observedAt=target.launchAt+1;const duplicate={...a,source:'zduplicate'},incompatible={...record(7),profile:'different'};
  a.observations=[price(a,a.launchAt+60_000,2),price(a,target.launchAt+1,500)];
  await h.importBatch({records:[target,a,b,boundary,old,future,late,duplicate,incompatible]});
  const result=h.query(target.mint);assert.equal(result.coverage.eligibleLaunches,3);assert.equal(result.matches.length,3);
  assert.equal(result.coverage.duplicateRecords,1);assert.equal(result.summary.knownPeaks,0);
  const tied=[a.mint,b.mint].sort();assert.deepEqual(result.matches.slice(0,2).map((m)=>m.mint),tied);
  const again=await new LaunchHistory(store.directory,{},()=>NOW).open();assert.deepEqual(again.query(target.mint),result);
  const earlier={...a,observedAt:a.observedAt+1};await again.importBatch({records:[earlier]});assert.equal(again.query(target.mint).coverage.storedRecords,9);
  assert.equal(again.query(address(99)),null);
});

test('history imports reject invalid/conflicting batches atomically and retain explicit eviction counts',async(t)=>{
  const store=await temporaryStore(t),h=await new LaunchHistory(store.directory,{maxRecords:2},()=>NOW).open();
  const a=record(1),b=record(2),c=record(3);await h.importBatch({records:[a,b]});
  const before=await fs.readFile(h.file,'utf8');await assert.rejects(h.importBatch({records:[c,{...a,launchAt:a.launchAt-1}]}));
  assert.equal(await fs.readFile(h.file,'utf8'),before);
  await assert.rejects(h.importBatch({updates:[{...a,observations:[price(a,NOW+1,1)]}]}));
  await h.importBatch({records:[c]});assert.equal(h.state.evictedCapacity,1);assert.equal(Object.keys(h.state.records).length,2);
  await h.importBatch({records:[record(4,NOW-91*DAY)]});assert.equal(h.state.evictedRetention,1);
  await fs.writeFile(h.file,'{"version":999}');await assert.rejects(new LaunchHistory(store.directory).open());
  assert.equal(await fs.readFile(h.file,'utf8'),'{"version":999}');
});

test('extraction rejects invalid/incomplete/unsupported reports and record schemas',()=>{
  for(const mutate of [(r)=>r.creation.createdAt=1.5,(r)=>r.creation.createdAt=NOW+1,(r)=>r.launch.blocksRead=1,(r)=>r.errors.push('incomplete')]){
    const r=report();mutate(r);assert.throws(()=>extractLaunchRecord(r));
  }
  assert.throws(()=>extractLaunchRecord(report(),{quoteMint:address(90)}));
  for(const mutate of [(r)=>r.version=2,(r)=>r.engine='wrong',(r)=>r.genericShare=2,(r)=>r.features.funding.groups.kind.bins={x:2},(r)=>r.features.shape.groups.slots.coverage=2]){
    const r=record();mutate(r);assert.equal(validLaunchRecord(r),false);
  }
});

test('complete exit evidence must identify the exact covered launch cohort and token denominator',()=>{
  const r=record(),good=exit(r,.5);assert.equal(validateObservation(good,r,NOW).soldFraction,.5);
  for(const mutate of [(o)=>o.cohortWallets=[address(99)],(o)=>o.initialTokens=0,(o)=>o.soldTokens=40]){
    const o=structuredClone(good);mutate(o);assert.throws(()=>validateObservation(o,r,NOW));
  }
  r.identity.clusterComplete=false;assert.throws(()=>validateObservation(good,r,NOW));
  assert.equal(validateObservation({...good,complete:false},r,NOW).complete,false);
});
