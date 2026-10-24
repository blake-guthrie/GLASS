import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mintAuthority, creationMints } from '../worker/feed.mjs';
import { PrescanWorker } from '../worker/worker.mjs';
import { WorkerStore } from '../worker/store.mjs';
import { publicSnapshot } from '../src/lib/shared-index.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { captured, address, signature, row, creation, completeReport, temporaryStore } from './helpers/worker-fixtures.mjs';
const authority = await mintAuthority();
const config = { pageSize: 2, pagesPerTick: 1, signaturesPerTick: 2, scanDelayMs: 0, startSignature: signature(90), retryMs: 1 };

test('official mint-authority PDA and captured create_v2 discover the original mint', () => {
  assert.equal(authority, 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
  assert.deepEqual(creationMints(captured.txs.create, authority).map((x) => [x.mint,x.supportedQuote]), [[captured.mint,true]]);
  assert.deepEqual(creationMints(captured.txs.buy, authority), []);
});

test('legacy/v2, explicit SOL and unsupported quote are differentiated; false authority and failed transactions excluded', () => {
  for (const options of [{v2:false},{v2:true},{quote:PROGRAMS.WSOL}]) assert.equal(creationMints(creation(authority, options), authority)[0].supportedQuote, true);
  const other = creationMints(creation(authority, {quote:address(9)}), authority)[0];
  assert.equal(other.supportedQuote, false); assert.equal(other.quoteMint,address(9));
  assert.deepEqual(creationMints(creation(address(9)), authority), []);
  const failed=creation(authority); failed.meta.err={InstructionError:[0,'fixture']};
  assert.deepEqual(creationMints(failed,authority),[]);
});

test('CPI creation requires complete successful ancestry, including caught-parent rollback', () => {
  assert.equal(creationMints(creation(authority,{inner:true}),authority).length,1);
  for(const options of [{failed:true},{ancestorFailed:true}]) assert.deepEqual(creationMints(creation(authority,{inner:true,...options}),authority),[]);
  const missing=creation(authority,{inner:true}); missing.meta.logMessages=[];
  assert.deepEqual(creationMints(missing,authority),[]);
  const depth=creation(authority,{inner:true}); depth.meta.innerInstructions[0].instructions[1].stackHeight=2;
  assert.deepEqual(creationMints(depth,authority),[]);
});

test('compiled loaded-address instructions and repeated mint creation records deduplicate',()=>{
  const tx=creation(authority),ix=tx.transaction.message.instructions[0],accounts=ix.accounts;
  tx.transaction.message.accountKeys=[PROGRAMS.PUMP];tx.meta.loadedAddresses={writable:accounts,readonly:[]};
  ix.programIdIndex=0;delete ix.programId;ix.accounts=accounts.map((a,i)=>i+1);
  tx.transaction.message.instructions.push({...ix});
  assert.deepEqual(creationMints(tx,authority).map((v)=>v.mint),[address(1)]);
});

test('burst pagination saves an unfinished cursor; restart resumes it and deduplicates new arrivals', async (t) => {
  const store=await temporaryStore(t), calls=[];
  const pages=new Map([[null,[4,3]], [signature(3),[2,90]]]);
  const rpc={getSignaturesForAddress:async(a,o)=>{assert.equal(a,authority);calls.push(o.before||null);return pages.get(o.before||null).map((n)=>row(signature(n)));}};
  let worker=new PrescanWorker({rpc,store,config}); await worker.initialize(); await worker.poll();
  assert.equal(store.state.checkpoint,signature(90)); assert.equal(store.state.cycle.before,signature(3));
  await store.close(); const reopened=await new WorkerStore(store.directory).open(); t.after(()=>reopened.close());
  worker=new PrescanWorker({rpc,store:reopened,config});await worker.initialize();await worker.poll();
  assert.equal(reopened.state.checkpoint,signature(4)); assert.equal(reopened.state.cycle,null);
  assert.equal(Object.keys(reopened.state.pending).length,3); assert.deepEqual(calls,[null,signature(3)]);
  pages.set(null,[5,4]);await worker.poll();assert.equal(Object.keys(reopened.state.pending).length,4);
  const transactions=new Map([2,3,4,5].map((n)=>[signature(n),creation(authority,{sig:signature(n),mint:address(n)})]));
  rpc.getTransaction=async(sig)=>transactions.get(sig);await worker.discover();await worker.discover();
  assert.deepEqual(Object.keys(reopened.state.jobs).sort(),[2,3,4,5].map(address).sort());assert.equal(Object.keys(reopened.state.pending).length,0);
});

test('start-now boundary, visible checkpoint gaps and bounded backpressure are honest', async (t) => {
  const store=await temporaryStore(t);let calls=0;
  const rpc={getSignaturesForAddress:async(a,o)=>{calls++;return o.limit===1?[row(signature(90))]:[row(signature(1))];}};
  const worker=new PrescanWorker({rpc,store,config:{pageSize:2,maxPending:2}});await worker.initialize();await worker.poll();
  assert.equal(Object.keys(store.state.pending).length,0);
  await worker.poll();assert.equal(worker.status().cursorGaps,1);assert.match(worker.status().lastError,/possibly-pruned/);
  await worker.poll();assert.equal(calls,2);assert.equal(worker.status().lastError,'backpressure');
});

test('discovery retries unavailable transactions, retains failed jobs and resumes explicit retry', async (t) => {
  const store=await temporaryStore(t); let time=1000, available=false;
  store.state.pending[signature(1)]={signature:signature(1),status:'queued',attempts:0,nextAt:0};
  const worker=new PrescanWorker({store,rpc:{getTransaction:async()=>available?creation(authority):null},config:{...config,maxAttempts:2},now:()=>time});
  await worker.initialize();await worker.discover();time+=10;await worker.discover();
  assert.equal(worker.status().failedSignatures,1);assert.equal(Object.keys(store.state.jobs).length,0);
  available=true;await worker.retryFailed();await worker.discover();assert.equal(store.state.jobs[address(1)].status,'queued');
  assert.equal(worker.status().failedSignatures,0);
});

test('unsupported quote mints remain durable and unscanned; retry cannot force bad valuations', async (t) => {
  const store=await temporaryStore(t);store.state.pending[signature(1)]={signature:signature(1),status:'queued',attempts:0,nextAt:0};
  let scans=0;const worker=new PrescanWorker({store,rpc:{getTransaction:async()=>creation(authority,{quote:address(9)})},config,scan:async()=>{scans++;}});
  await worker.initialize();await worker.discover();await worker.retryFailed();await worker.scanNext();
  assert.equal(worker.status().unsupportedQuotes,1);assert.equal(scans,0);assert.equal(await store.readReport(address(1)),null);
  const state=JSON.parse(await fs.readFile(`${store.directory}/state.json`));assert.equal(state.jobs[address(1)].reason,'engine-requires-SOL-quote');
});

test('mint dedup, delayed maturity and capacity retain undispatched signatures', async (t) => {
  const store=await temporaryStore(t),time=1000;
  for(const n of [1,2])store.state.pending[signature(n)]={signature:signature(n),status:'queued',attempts:0,nextAt:0};
  const worker=new PrescanWorker({store,rpc:{getTransaction:async(s)=>creation(authority,{sig:s})},config,now:()=>time});
  await worker.initialize();await worker.discover();assert.equal(Object.keys(store.state.jobs).length,1);
  assert.equal(store.state.jobs[address(1)].nextAt,61_000);assert.equal(Object.keys(store.state.pending).length,0);
  store.state.pending[signature(3)]={signature:signature(3),status:'queued',attempts:0,nextAt:0};
  worker.rpc.getTransaction=async(s)=>creation(authority,{sig:s,mint:address(3)});worker.config.maxJobs=1;
  await worker.discover();assert.ok(store.state.pending[signature(3)]);assert.equal(worker.status().lastError,'backpressure');
});

test('failed scans retry, cancellation never publishes, crash-after-publish recovers without rescanning', async (t) => {
  const store=await temporaryStore(t);let scans=0;
  store.state.jobs[address(1)]={mint:address(1),status:'queued',attempts:0,nextAt:0,discoveredAt:Date.now()};
  const worker=new PrescanWorker({store,rpc:{},config,scan:async()=>{scans++;throw Error('private provider error');}});await worker.initialize();
  await worker.scanNext();assert.equal(store.state.jobs[address(1)].attempts,1);assert.equal(await store.readReport(address(1)),null);
  store.state.jobs[address(1)].nextAt=0;const abort=new AbortController();
  worker.scan=async()=>{abort.abort();return completeReport();};await worker.scanNext(abort.signal);
  assert.equal(store.state.jobs[address(1)].status,'queued');assert.equal(await store.readReport(address(1)),null);
  const snapshot=publicSnapshot(completeReport());await store.writeReport(snapshot);store.state.jobs[address(1)].status='running';await store.save();
  await worker.initialize();await worker.scanNext();assert.equal(scans,1);assert.equal(store.state.jobs[address(1)].status,'published');assert.equal(store.state.jobs[address(1)].publishedAt,snapshot.scannedAt);
});

test('published retention and process lock protect persistence; invalid configuration is rejected', async(t)=>{
  const store=await temporaryStore(t);await assert.rejects(new WorkerStore(store.directory).open(),/already-running/);
  const snapshot=publicSnapshot(completeReport());await store.writeReport(snapshot);
  store.state.jobs[address(1)]={status:'published',publishedAt:1};
  const worker=new PrescanWorker({store,rpc:{getSignaturesForAddress:async()=>[]},config:{...config,retentionMs:1}});await worker.initialize();await worker.tick();
  assert.equal(await store.readReport(address(1)),null);
  for(const settings of [{slotWindow:-1},{maxWalletProfiles:101},{liveTracking:'false'},{rpcUrl:'private'}])assert.throws(()=>new PrescanWorker({store,rpc:{},settings}));
  assert.throws(()=>new PrescanWorker({store,rpc:{},config:{pageSize:1001}}));
});

test('documented CLI runs with real RpcClient over loopback and persists the start boundary',async(t)=>{
  const store=await temporaryStore(t);await store.close();let requests=0;
  const rpc=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const call=JSON.parse(body);
    assert.equal(call.method,'getSignaturesForAddress');assert.equal(call.params[0],authority);requests++;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result:[]}));
  });
  await new Promise((r)=>rpc.listen(0,'127.0.0.1',r));t.after(async()=>{rpc.closeAllConnections();await new Promise((r)=>rpc.close(r));});
  const file=`${store.directory}/config.json`;await fs.writeFile(file,JSON.stringify({dataDir:store.directory,host:'127.0.0.1',port:0,scan:{},worker:{}}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../worker/main.mjs',import.meta.url)),'--config',file,'--once'],{
    env:{...process.env,GLASS_WORKER_RPC:`http://127.0.0.1:${rpc.address().port}/?key=PRIVATE-FIXTURE`},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',(c)=>output+=c);child.stderr.on('data',(c)=>output+=c);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,output);assert.equal(requests,1);assert.doesNotMatch(output,/PRIVATE-FIXTURE/);
  const state=JSON.parse(await fs.readFile(`${store.directory}/state.json`,'utf8'));assert.equal(state.initialized,true);assert.equal(state.authority,authority);
});
