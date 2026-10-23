import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, PROGRAMS } from '../src/lib/constants.js';
import { publicSnapshot, validateSnapshot, lookupSharedSnapshot, snapshotReport, indexEndpoint } from '../src/lib/shared-index.js';
import { PrescanWorker } from '../worker/worker.mjs';
import { WorkerStore } from '../worker/store.mjs';
import { indexServer } from '../worker/server.mjs';
import { mintAuthority } from '../worker/feed.mjs';
import { runScan } from '../src/lib/scan/pipeline.js';
import { derivePumpAccounts } from '../src/lib/scan/launch.js';
import { captured, address, signature, row, completeReport, temporaryStore } from './helpers/worker-fixtures.mjs';

test('captured launch: feed → actual seven-stage engine → durable index → HTTP consumer → restart', async(t)=>{
  const store=await temporaryStore(t), authority=await mintAuthority(), accounts=await derivePumpAccounts(captured.mint);
  const raws=Object.values(captured.txs), bySig=new Map(raws.map((tx)=>[tx.transaction.signatures[0],tx]));
  const infos=raws.map((tx)=>({signature:tx.transaction.signatures[0],slot:tx.slot,blockTime:tx.blockTime,err:null})).sort((a,b)=>a.slot-b.slot);
  let feedCalls=0, scans=0, stages=[];
  // Captured create/trade bytes stay unchanged. Empty surrounding wallet/API histories,
  // balances, block envelopes and the signature feed are explicit synthetic transport fixtures.
  const rpc={url:'https://fixture.invalid/?api-key=DO-NOT-PUBLISH',totalCalls:0,totalDegraded:0,profile:{name:'fixture'},
    getSignaturesForAddress:async(a)=>{rpc.totalCalls++;if(a===authority){feedCalls++;return [row(captured.sigs.create),row(signature(90))];}if(a===accounts.metadata)return[infos.find((r)=>r.signature===captured.sigs.create)];return[];},
    getTransaction:async(s)=>bySig.get(s)||null, getTransactions:async(ss)=>ss.map((s)=>bySig.get(s)||null),
    getAccountInfo:async()=>({value:{data:{parsed:{type:'mint'}},owner:PROGRAMS.TOKEN_2022}}),
    getMintInfo:async()=>({supply:1e9,tokenProgram:PROGRAMS.TOKEN_2022}),
    getBlockAccounts:async(slot)=>({transactions:raws.filter((tx)=>tx.slot===slot).map((tx)=>({meta:{err:null},transaction:{accountKeys:tx.transaction.message.accountKeys,signatures:tx.transaction.signatures}}))}),
    pageSignatures:async(a)=>{assert.equal(a,accounts.bondingCurve);return{sigs:infos,exhausted:true};},
    historyStart:async()=>0,forSlot:async()=>rpc,
    getTokenBalances:async(owners)=>owners.map((owner)=>({owner,amount:0})),ataFor:async()=>address(29)};
  const originalFetch=globalThis.fetch, requested=[];
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url);requested.push(u.href);
    if(u.hostname==='127.0.0.1')return originalFetch(url,opts);
    if(u.hostname==='api.dexscreener.com')return Response.json({pairs:[]});
    if(u.hostname==='frontend-api-v3.pump.fun')return Response.json([]);
    if(u.hostname==='bundles.jito.wtf')return Response.json({bundles:[]});
    throw Error(`unexpected fixture request ${u.origin}`);
  };
  t.after(()=>{globalThis.fetch=originalFetch;});
  const worker=new PrescanWorker({rpc,store,config:{startSignature:signature(90),pageSize:10},scan:async(...args)=>{
    scans++;const report=await runScan(...args);stages=Object.entries(report.stages).map(([s,v])=>[s,v.status]);
    assert.deepEqual(report.errors,[]);assert.ok(report.launch.creatorDevBuy.pct>7);return report;
  }});
  await worker.initialize();await worker.tick();
  assert.equal(feedCalls,1);assert.equal(scans,1);assert.equal(worker.status().published,1);
  assert.equal(stages.length,7);assert.ok(stages.every(([,s])=>s==='done'));
  const disk=await fs.readFile(store.reportPath(captured.mint),'utf8');assert.doesNotMatch(disk,/DO-NOT-PUBLISH|rpc|api-key|settings/);
  const server=indexServer(store,()=>worker.status(),worker.settings);
  await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise((r)=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}/`;
  const hit=await lookupSharedSnapshot(captured.mint,{...DEFAULTS,sharedIndexEnabled:true,sharedIndexUrl:base,rpcUrl:'DO-NOT-UPLOAD'});
  assert.ok(hit);assert.equal(hit.snapshot.launch.blocks,4);assert.ok(hit.snapshot.launch.devPct>7);
  assert.equal(snapshotReport(hit).sharedIndex.origin,base.slice(0,-1));assert.equal(snapshotReport(hit).launch,undefined);
  assert.equal((await originalFetch(`${base}v1/status`)).status,200);
  assert.equal((await originalFetch(`${base}v1/reports/${address(30)}`)).status,404);
  store.state.jobs[address(31)]={mint:address(31),status:'unsupported-quote',reason:'engine-requires-SOL-quote'};
  const blocked=await originalFetch(`${base}v1/reports/${address(31)}`);assert.equal(blocked.status,202);assert.equal((await blocked.json()).reason,'engine-requires-SOL-quote');
  assert.equal((await originalFetch(`${base}v1/reports/${captured.mint}`,{method:'POST',body:'bad'})).status,405);
  assert.ok(requested.every((u)=>!u.includes('DO-NOT-UPLOAD')));
  await store.close();const again=await new WorkerStore(store.directory).open();t.after(()=>again.close());
  const restarted=new PrescanWorker({rpc,store:again,scan:()=>{throw Error('must not rescan');}});await restarted.initialize();await restarted.scanNext();
  assert.equal(restarted.status().published,1);assert.deepEqual(await again.readReport(captured.mint),JSON.parse(disk));
});

test('public projection rejects incomplete stages/windows and never carries private report fields',()=>{
  const good=publicSnapshot(completeReport());assert.ok(validateSnapshot(good,{mint:good.mint}));
  assert.equal(good.launch.bundlePct,null);assert.equal(good.history.totalCreated,2);
  const extra=validateSnapshot({...good,rpcUrl:'secret',nested:{secret:'secret'}},{mint:good.mint});assert.equal(extra.rpcUrl,undefined);
  for(const mutate of [(r)=>r.errors.push({message:'private'}),(r)=>r.stages.live.status='error',(r)=>r.launch.partialEarly=true,(r)=>r.launch.blocksRead=3]){
    const r=completeReport();mutate(r);assert.throws(()=>publicSnapshot(r));
  }
  for(const mutate of [(s)=>s.schema=2,(s)=>s.engine='another-engine',(s)=>s.profile='wrong',(s)=>s.scannedAt-=120001,(s)=>s.scannedAt+=6000,(s)=>s.risk.score=101,(s)=>s.history.totalCreated=-1,(s)=>s.flow.enabled='true',(s)=>s.launch=null]){
    const s=structuredClone(good);mutate(s);assert.equal(validateSnapshot(s,{mint:good.mint,now:good.scannedAt}),null);
  }
  assert.equal(validateSnapshot(good,{mint:address(9)}),null);
  assert.equal(validateSnapshot(good,{mint:good.mint,settings:{slotWindow:4}}),null);
});

test('index lookup is opt-in, bounded, anonymous and rejects stale/invalid/error responses',async()=>{
  const s=publicSnapshot(completeReport()),settings={sharedIndexEnabled:true,sharedIndexUrl:'https://index.invalid/base/',rpcUrl:'SECRET'};
  let calls=0;const ok=async(url,opts)=>{calls++;assert.equal(url,`https://index.invalid/base/v1/reports/${s.mint}`);assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');assert.equal(opts.referrerPolicy,'no-referrer');assert.equal(opts.body,undefined);assert.doesNotMatch(JSON.stringify(opts),/SECRET/);return Response.json(s);};
  assert.equal(await lookupSharedSnapshot(s.mint,{...settings,sharedIndexEnabled:false},{fetcher:ok}),null);assert.equal(calls,0);
  assert.ok(await lookupSharedSnapshot(s.mint,settings,{fetcher:ok}));
  for(const response of [Response.json(s,{status:404}),Response.json({...s,scannedAt:s.scannedAt-120001}),new Response('invalid',{headers:{'content-type':'application/json'}}),new Response('x'.repeat(32769),{headers:{'content-type':'application/json'}}),new Response('{}')]){
    assert.equal(await lookupSharedSnapshot(s.mint,settings,{fetcher:async()=>response,now:s.scannedAt}),null);
  }
  assert.equal(await lookupSharedSnapshot(s.mint,settings,{fetcher:async()=>{throw Error('offline');}}),null);
  const abort=new AbortController();abort.abort();assert.equal(await lookupSharedSnapshot(s.mint,settings,{fetcher:ok,signal:abort.signal}),null);
  for(const url of ['http://remote.invalid','https://u:p@index.invalid','https://index.invalid/?key=secret','https://index.invalid/#x','file:///tmp'])assert.equal(indexEndpoint(url),null);
  assert.ok(indexEndpoint('http://127.0.0.1:8788'));assert.ok(indexEndpoint('https://index.invalid/path'));
});

test('actual background startScan uses shared hit, local fallback/force, existing cache and cancellation',async()=>{
  const source=await fs.readFile(new URL('../src/background.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async function startScan('),source.indexOf('const watchers ='));
  let scans=0,writes=0,lookups=0,cached=null,hit={snapshot:publicSnapshot(completeReport()),origin:'https://index.invalid'},cancel=false;
  const messages=[],inflight=new Map();
  const context={inflight,getSettings:async()=>DEFAULTS,reportCache:{get:async()=>cached,set:async()=>{writes++;}},makeRpc:()=>({}),
    broadcast:(job,msg)=>messages.push(msg),setInterval:()=>1,clearInterval:()=>{},snapshotReport,
    lookupSharedSnapshot:async(m,s,{signal})=>{lookups++;if(cancel)signal.aborted=true;return hit;},
    runScan:async()=>{scans++;return completeReport();},memory:{},trimReport:(x)=>x,evictOldReports:()=>{},DEFAULTS,console};
  vm.createContext(context);vm.runInContext(`${body}\nglobalThis.start=startScan;`,context);
  const port={postMessage:(m)=>messages.push(m)};
  await context.start(address(1),address(1),true,port,false);assert.equal(scans,0);assert.equal(writes,0);assert.equal(messages.at(-1).shared,true);assert.equal(inflight.size,0);
  hit=null;await context.start(address(1),address(1),true,port,false);assert.equal(scans,1);assert.equal(writes,1);
  await context.start(address(1),address(1),true,port,true);assert.equal(scans,2);assert.equal(lookups,2);
  cached=completeReport();await context.start(address(1),address(1),true,port,false);assert.equal(scans,2);assert.equal(messages.at(-1).cached,true);
  cached=null;cancel=true;await context.start(address(1),address(1),true,port,false);assert.equal(scans,2);assert.equal(inflight.size,0);
});

test('actual panel snapshot renderer escapes operator data and explains trust, coverage and local receipts',async()=>{
  const source=await fs.readFile(new URL('../src/content.js',import.meta.url),'utf8');
  const method=source.slice(source.indexOf('    renderSharedSnapshot('),source.indexOf('    secMarket('));
  const esc=(s)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const render=new Function('esc','ago','fmtPct','link',`return ({${method}}).renderSharedSnapshot;`)(esc,()=> '1s ago',(x)=>x==null?'unknown':`${x}%`,esc);
  const html=render({snapshot:publicSnapshot(completeReport()),origin:'https://index.invalid/<x>'});
  assert.doesNotMatch(html,/<img|<x>/);assert.match(html,/&lt;img/);assert.match(html,/not independently verified/);assert.match(html,/full receipts/);assert.match(html,/2\+ launches/);assert.match(html,/4 blocks/);
});

test('popup requests all optional hosts synchronously in the user gesture, then persists settings',async()=>{
  const source=await fs.readFile(new URL('../src/popup.js',import.meta.url),'utf8');
  const nodes=new Map();const node=(id)=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,style:{},addEventListener(type,fn){this[type]=fn;}});return nodes.get(id);};
  let active=false, saved=null, requested=null;
  const context={document:{getElementById:node},DEFAULTS,indexEndpoint,URL,console,setTimeout:()=>{},chrome:{
    storage:{sync:{get:async()=>({settings:{sharedIndexEnabled:true,sharedIndexUrl:'https://index.invalid'}}),set:async(v)=>{saved=v;}}},
    permissions:{request:({origins})=>{assert.equal(active,true);requested=origins;return Promise.resolve(true);}},runtime:{sendMessage:async()=>({memory:{},cachedReports:0})}}};
  vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?\n/gm,''),context);
  await new Promise((r)=>setImmediate(r));for(const n of nodes.values())n.value=String(n.value);active=true;const promise=node('save').click();active=false;await promise;
  assert.ok(requested.includes('https://index.invalid/*'));assert.ok(requested.includes(new URL(DEFAULTS.rpcUrl).origin+'/*'));
  assert.equal(saved.settings.sharedIndexEnabled,true);assert.equal(saved.settings.sharedIndexUrl,'https://index.invalid');
  node('sharedIndexUrl').value='http://127.0.0.1:8788/';active=true;const local=node('save').click();active=false;await local;
  assert.ok(requested.includes('http://127.0.0.1/*'));
});
