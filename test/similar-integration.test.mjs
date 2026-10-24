import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { DEFAULTS,PROGRAMS } from '../src/lib/constants.js';
import { INDEX_ENGINE,publicSnapshot,snapshotReport } from '../src/lib/shared-index.js';
import { lookupSimilarLaunches,validateSimilar } from '../src/lib/similar-index.js';
import { extractLaunchRecord,compareLaunches } from '../src/lib/scan/similar.js';
import { WorkerStore } from '../worker/store.mjs';
import { LaunchHistory } from '../worker/history.mjs';
import { PrescanWorker } from '../worker/worker.mjs';
import { indexServer } from '../worker/server.mjs';
import { mintAuthority } from '../worker/feed.mjs';
import { runScan } from '../src/lib/scan/pipeline.js';
import { derivePumpAccounts } from '../src/lib/scan/launch.js';
import { temporaryStore,address,captured,signature } from './helpers/worker-fixtures.mjs';
import { report,record,price,exit,NOW,DAY } from './helpers/similar-fixtures.mjs';

test('worker report ingestion → disk → restart → real HTTP → background → actual panel, with local fallback/cache/force',async(t)=>{
  const store=await temporaryStore(t),target=report(10,NOW-120_000),prior=record(1,NOW-DAY);
  prior.observations=[price(prior,prior.launchAt+60_000,1),price(prior,prior.launchAt+600_000,4),exit(prior,.6)];
  const worker=new PrescanWorker({store,rpc:{},scan:async()=>target,now:()=>NOW});await worker.initialize();
  await worker.history.importBatch({records:[prior]});
  store.state.jobs[target.mint]={mint:target.mint,quoteMint:PROGRAMS.WSOL,status:'queued',attempts:0,nextAt:0};
  await worker.scanNext();assert.equal(store.state.jobs[target.mint].status,'published');assert.equal(worker.status().historyRecords,2);
  const raw=await fs.readFile(worker.history.file,'utf8');assert.doesNotMatch(raw,/DO-NOT-PUBLISH|api-key|rpc|settings/);
  await store.close();const restarted=await new WorkerStore(store.directory).open();t.after(()=>restarted.close());
  const resumed=new PrescanWorker({store:restarted,rpc:{},now:()=>NOW});await resumed.initialize();
  const server=indexServer(restarted,()=>resumed.status());await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise((r)=>server.close(r));});
  const settings={...DEFAULTS,sharedIndexEnabled:true,sharedIndexUrl:`http://127.0.0.1:${server.address().port}/`,rpcUrl:'SECRET'};
  const history=await lookupSimilarLaunches(target.mint,settings,{now:NOW});assert.ok(history);assert.equal(history.matches[0].mint,prior.mint);
  assert.equal(history.summary.medianObservedPeakMultiple,4);assert.equal(history.summary.rapidDumpFraction,1);
  assert.equal(history.matches[0].exactWalletEvidence.sharedLaunchBuyers,0);
  assert.equal((await fetch(`${settings.sharedIndexUrl}v1/similar/${address(99)}`)).status,404);
  assert.equal((await fetch(`${settings.sharedIndexUrl}v1/similar/${target.mint}`,{method:'POST'})).status,405);
  const source=await fs.readFile(new URL('../src/background.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async function startScan('),source.indexOf('const watchers ='));
  let scans=0,lookups=0,cached=null,shared=true,cancel=false;const messages=[],writes=[],inflight=new Map();
  const context={inflight,getSettings:async()=>settings,reportCache:{get:async()=>cached,set:async(k,r)=>writes.push(r)},makeRpc:()=>({}),
    broadcast:(job,msg)=>messages.push(msg),setInterval:()=>1,clearInterval:()=>{},snapshotReport,
    lookupSharedSnapshot:async()=>shared?{snapshot:publicSnapshot(target),origin:settings.sharedIndexUrl}:null,
    lookupSimilarLaunches:async(m,s,options)=>{lookups++;if(cancel)options.signal.aborted=true;return lookupSimilarLaunches(m,s,{...options,now:NOW});},
    runScan:async()=>{scans++;return target;},memory:{},trimReport:(r)=>r,evictOldReports:()=>{},DEFAULTS,console};
  vm.createContext(context);vm.runInContext(`${body}\nglobalThis.start=startScan;`,context);const port={postMessage:(m)=>messages.push(m)};
  await context.start(target.mint,target.mint,true,port,false);assert.equal(scans,0);assert.ok(messages.at(-1).report.similarLaunches);
  shared=false;await context.start(target.mint,target.mint,true,port,false);assert.equal(scans,1);assert.ok(messages.at(-1).report.similarLaunches);
  assert.ok(writes.every((r)=>!r.similarLaunches));
  const before=lookups;await context.start(target.mint,target.mint,true,port,true);assert.equal(scans,2);assert.equal(lookups,before);
  cached={...target,finishedAt:Date.now()};await context.start(target.mint,target.mint,true,port,false);assert.equal(scans,2);assert.ok(messages.at(-1).report.similarLaunches);
  cached=null;cancel=true;messages.length=0;await context.start(target.mint,target.mint,true,port,false);assert.equal(inflight.size,0);assert.ok(messages.every((m)=>!m.report?.similarLaunches));
  settings.sharedIndexEnabled=false;const calls=lookups;await context.start(target.mint,target.mint,true,port,false);assert.equal(lookups,calls);
  const content=await fs.readFile(new URL('../src/content.js',import.meta.url),'utf8');
  const method=content.slice(content.indexOf('    renderSimilarLaunches('),content.indexOf('    renderSharedSnapshot('));
  const esc=(s)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const render=new Function('esc','link',`return ({${method}}).renderSimilarLaunches;`)(esc,esc);
  const html=render({...history,origin:'https://operator.invalid/<bad>'});
  assert.match(html,/4.00×/);assert.match(html,/1\/1 \(100%\)/);assert.match(html,/not ATH/);assert.match(html,/does not establish identity/);
  assert.match(html,/transaction: 100.0/);assert.match(html,/funding: 100.0/);assert.doesNotMatch(html,/<bad>/);assert.match(html,/&lt;bad&gt;/);
  assert.match(content,/renderSharedSnapshot\(r.sharedIndex\) \+ this.renderSimilarLaunches/);
  assert.match(content,/parts.push\(this.renderSimilarLaunches\(r.similarLaunches\)\)/);
});

test('history response validation rejects incompatible, stale, future, impossible denominator and untrusted extra fields',async(t)=>{
  const store=await temporaryStore(t),h=await new LaunchHistory(store.directory,{},()=>NOW).open();const target=record(10,NOW-120_000),past=record(1);
  await h.importBatch({records:[target,past]});const good=h.query(target.mint);assert.ok(validateSimilar(good,{mint:target.mint,now:NOW}));
  for(const mutate of [(v)=>v.method='unknown',(v)=>v.engine='unknown',(v)=>v.profile='other',(v)=>v.generatedAt-=120001,
    (v)=>v.cutoff++,(v)=>v.windowStart++,(v)=>v.summary.knownPeaks=1,(v)=>v.summary.rapidDumpFraction=0,
    (v)=>v.matches[0].observedAt=v.cutoff+1,(v)=>v.matches[0].mint=target.mint,(v)=>v.matches[0].coverage.funding=.5,
    (v)=>v.matches[0].score=90,(v)=>v.coverage.matchedLaunches=9000,(v)=>v.matches[0].outcome.evidence=['javascript:bad']]){
    const value=structuredClone(good);mutate(value);assert.equal(validateSimilar(value,{mint:target.mint,now:NOW}),null);
  }
  good.private='SECRET';good.matches[0].rpc='SECRET';assert.doesNotMatch(JSON.stringify(validateSimilar(good,{mint:target.mint,now:NOW})),/SECRET/);
  let calls=0;const settings={sharedIndexEnabled:true,sharedIndexUrl:'https://index.invalid/base/',rpcUrl:'SECRET'};
  const fetcher=async(url,options)=>{calls++;assert.equal(url,`https://index.invalid/base/v1/similar/${target.mint}`);assert.equal(options.body,undefined);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');return Response.json(good);};
  assert.equal(await lookupSimilarLaunches(target.mint,{...settings,sharedIndexEnabled:false},{fetcher}),null);assert.equal(calls,0);
  assert.ok(await lookupSimilarLaunches(target.mint,settings,{fetcher,now:NOW}));
  for(const response of [new Response('{}'),Response.json(good,{status:503}),new Response('x'.repeat(32769),{headers:{'content-type':'application/json'}}),Response.json({...good,generatedAt:NOW-120001})]){
    assert.equal(await lookupSimilarLaunches(target.mint,settings,{fetcher:async()=>response,now:NOW}),null);
  }
  assert.equal(await lookupSimilarLaunches(target.mint,settings,{fetcher:async()=>{throw Error('offline');}}),null);
  const controller=new AbortController();controller.abort();assert.equal(await lookupSimilarLaunches(target.mint,settings,{fetcher,signal:controller.signal}),null);
});

test('actual offline import command bootstraps full report provenance and later complete outcome updates, using exclusive lock',async(t)=>{
  const store=await temporaryStore(t),r=report(1),record1=extractLaunchRecord(r,{source:'owned-capture'});
  const config=path.join(store.directory,'config.json'),input=path.join(store.directory,'import.json');
  await fs.writeFile(config,JSON.stringify({dataDir:store.directory}));
  await fs.writeFile(input,JSON.stringify({schema:1,engine:INDEX_ENGINE,reports:[{report:r,settings:{},source:'owned-capture',quoteMint:PROGRAMS.WSOL}],updates:[]}));
  const cli=new URL('../worker/import-history.mjs',import.meta.url);const invoke=()=>spawnSync(process.execPath,[cli.pathname.replace(/^\/(\w:)/,'$1'),'--config',config,'--input',input],{encoding:'utf8'});
  assert.equal(invoke().status,1);await store.close();assert.equal(invoke().status,0);
  await fs.writeFile(input,JSON.stringify({schema:1,engine:INDEX_ENGINE,reports:[],updates:[{mint:r.mint,profile:record1.profile,source:record1.source,observations:[price(record1,r.creation.createdAt+60_000,1),price(record1,r.creation.createdAt+600_000,3),exit(record1,.7)]}]}));
  const result=invoke();assert.equal(result.status,0,result.stderr);const h=await new LaunchHistory(store.directory).open();assert.equal(Object.values(h.state.records)[0].observations.length,3);
  const before=await fs.readFile(h.file,'utf8');assert.equal(invoke().status,0);assert.equal(await fs.readFile(h.file,'utf8'),before); // idempotent
});

test('unchanged captured create/trade bytes through the real engine archive genuine available features without inventing history/outcomes',async(t)=>{
  const store=await temporaryStore(t),authority=await mintAuthority(),accounts=await derivePumpAccounts(captured.mint);
  const raws=Object.values(captured.txs),bySig=new Map(raws.map((tx)=>[tx.transaction.signatures[0],tx]));
  const infos=raws.map((tx)=>({signature:tx.transaction.signatures[0],slot:tx.slot,blockTime:tx.blockTime,err:null})).sort((a,b)=>a.slot-b.slot);
  const rpc={totalCalls:0,totalDegraded:0,profile:{name:'fixture'},getSignaturesForAddress:async(a)=>a===accounts.metadata?[infos.find((r)=>r.signature===captured.sigs.create)]:[],
    getTransaction:async(s)=>bySig.get(s)||null,getTransactions:async(ss)=>ss.map((s)=>bySig.get(s)||null),
    getAccountInfo:async()=>({value:{data:{parsed:{type:'mint'}},owner:PROGRAMS.TOKEN_2022}}),getMintInfo:async()=>({supply:1e9,tokenProgram:PROGRAMS.TOKEN_2022}),
    getBlockAccounts:async(slot)=>({transactions:raws.filter((tx)=>tx.slot===slot).map((tx)=>({meta:{err:null},transaction:{accountKeys:tx.transaction.message.accountKeys,signatures:tx.transaction.signatures}}))}),
    pageSignatures:async()=>({sigs:infos,exhausted:true}),historyStart:async()=>0,forSlot:async()=>rpc,
    getTokenBalances:async(owners)=>owners.map((owner)=>({owner,amount:0})),ataFor:async()=>address(29)};
  const original=globalThis.fetch;globalThis.fetch=async(url)=>{
    const host=new URL(url).hostname;if(host==='api.dexscreener.com')return Response.json({pairs:[]});
    if(host==='frontend-api-v3.pump.fun')return Response.json([]);if(host==='bundles.jito.wtf')return Response.json({bundles:[]});throw Error('unexpected fixture request');
  };t.after(()=>{globalThis.fetch=original;});
  const worker=new PrescanWorker({rpc,store,scan:runScan});await worker.initialize();
  store.state.jobs[captured.mint]={mint:captured.mint,quoteMint:PROGRAMS.WSOL,status:'queued',attempts:0,nextAt:0};
  await worker.scanNext();assert.equal(store.state.jobs[captured.mint].status,'published');assert.equal(worker.status().historyRecords,1);
  const archived=Object.values(worker.history.state.records)[0];assert.equal(archived.launchAt,captured.txs.create.blockTime*1000);
  assert.ok(archived.sample.capturedBuyers>0);assert.ok(archived.features.transaction.groups.compute.coverage>0);
  assert.equal(archived.observations.length,0);assert.equal(compareLaunches(archived,archived).accepted,false);
  const query=worker.history.query(captured.mint);assert.equal(query.matches.length,0);assert.equal(query.summary.rapidDumpFraction,null);
});
