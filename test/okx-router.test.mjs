import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import known from '../src/data/known.js';
import { PROGRAMS } from '../src/lib/constants.js';
import { parseTx } from '../src/lib/txparse.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { analyseLaunch, routeLabel, explainFingerprint } from '../src/lib/scan/fingerprint.js';
import { fmtUsd } from '../src/lib/scan/operator.js';
import { fmtPct } from '../src/lib/scan/score.js';

const OKX = 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u';
const CEX = '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD';
const MAESTRO = 'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36';
const BUYER = 'CYZrW8pkoNFFvGo3ee2kyTbzzQX1n9dB4DmFHzkYAGrH';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIG = '4S5wKiPqsusdLYXRm8UPtto3EhbnnEwVfDRpXxh9iwWZzkxrE8aKwTWP4Ur7HW4GknS4rnoJtymY2p9AugD2HGYJ';
const bytes = readFileSync(new URL('./fixtures/okx-router-mainnet.json', import.meta.url));
const captured = JSON.parse(bytes).result;
const okxEvidence = (tx) => parseTx(tx).routeEvidence.filter((e) => e.address === OKX);
function reportFor(tx) {
  const record = parseTx(tx);
  record.order = record.slot * 1000000;
  // Synthetic analysis context around an unchanged swap, not a real token-creation claim.
  const creation = { record: { slot: record.slot, blockTime: record.blockTime,
    feePayer: PROGRAMS.PUMPSWAP, sig: 'synthetic-creation-context' }, generic: true };
  const events = extractLaunchEvents([record], MINT, creation);
  return { mint: MINT, launch: analyseLaunch(events) };
}
function panelHtml(report) {
  const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
  const marker = '  // ---------- live refresh';
  assert.ok(source.includes(marker));
  const context = vm.createContext({});
  vm.runInContext(source.replace(marker, '  globalThis.TestPanel = Panel; return;\n' + marker), context);
  return context.TestPanel.prototype.secReceipts.call({ sec: (_id, _title, _count, html) => html }, report);
}
function cliOutput(report) {
  const source = readFileSync(new URL('../cli/scan.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('// ---- pretty print ----');
  const end = source.indexOf('if (report.wallets?.summary)');
  assert.ok(start >= 0 && end > start);
  const lines = [];
  // Execute the existing formatter, without starting the network-enabled CLI scan entrypoint.
  vm.runInNewContext(source.slice(start, end), { report, fmtUsd, fmtPct,
    console: { log: (line) => lines.push(line) } });
  return lines.join('\n');
}

// Synthetic instruction trees exercise boundaries; their addresses are not additional receipts.
const node = (programId, children = [], parsed, failed = false) => ({ programId, children, parsed, failed });
const move = () => node(PROGRAMS.TOKEN, [], { type: 'transferChecked', info: {
  source: PROGRAMS.WSOL, destination: PROGRAMS.ATA, mint: MINT, authority: PROGRAMS.PUMPSWAP,
  tokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
} });
const fee = () => node(PROGRAMS.SYSTEM, [], { type: 'transfer', info: { source: BUYER, destination: MAESTRO, lamports: 1000000 } });
function synthetic(children) {
  const instructions = [], logs = [];
  const walk = (n, depth) => {
    instructions.push({ programId: n.programId, stackHeight: depth, ...(n.parsed ? { parsed: n.parsed,
      program: n.programId === PROGRAMS.SYSTEM ? 'system' : 'spl-token' } : {}) });
    logs.push(`Program ${n.programId} invoke [${depth}]`);
    n.children.forEach((c) => walk(c, depth + 1));
    logs.push(`Program ${n.programId} ${n.failed ? 'failed: synthetic caught failure' : 'success'}`);
  };
  walk(node(PROGRAMS.JUPITER_V6, children), 1);
  const top = instructions.shift();
  const bal = (accountIndex, owner, uiAmount) => ({ accountIndex, mint: MINT, owner,
    uiTokenAmount: { amount: String(uiAmount * 1e6), decimals: 6, uiAmount } });
  return { slot: 100, blockTime: 1000, transaction: { signatures: ['synthetic-receipt'], message: {
    instructions: [top], accountKeys: [{ pubkey: BUYER, signer: true }, { pubkey: PROGRAMS.WSOL },
      { pubkey: PROGRAMS.ATA }, { pubkey: OKX }] } },
    meta: { err: null, fee: 5000, logMessages: logs, innerInstructions: [{ index: 0, instructions }],
      preBalances: [1000000000, 0, 0, 0], postBalances: [900000000, 0, 0, 0],
      preTokenBalances: [bal(1, PROGRAMS.PUMPSWAP, 1), bal(2, BUYER, 0)],
      postTokenBalances: [bal(1, PROGRAMS.PUMPSWAP, 0), bal(2, BUYER, 1)] } };
}

test('captured finalized OKX router execution produces exact program evidence', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '8bf9aa5688dbf2bb396fb80290e657a05249127ff12e5b68c3826fac80ccbf5b');
  assert.equal(captured.transaction.signatures[0], SIG);
  assert.equal(captured.slot, 460777709);
  assert.equal(captured.version, 0);
  assert.equal(captured.meta.err, null);
  const record = parseTx(captured);
  assert.equal(record.entryProgram, OKX);
  const evidence = record.routeEvidence.find((e) => e.address === OKX && e.wallet === BUYER && e.mint === MINT);
  assert.ok(evidence, 'successful captured router must be labelled on the wallet token path');
  assert.equal(evidence.kind, 'program');
  assert.equal(evidence.label, 'OKX DEX router');
  assert.equal(evidence.outerIndex, 6);
  assert.equal(evidence.instructionIndex, 0);
  assert.equal(evidence.signature, SIG);
});

test('captured route reaches fingerprints, serialized report, panel and CLI output', () => {
  const report = JSON.parse(JSON.stringify(reportFor(captured)));
  const buyer = report.launch.buyers.find((b) => b.wallet === BUYER);
  assert.ok(buyer);
  assert.equal(buyer.route, OKX);
  assert.equal(buyer.routeLabel, 'OKX DEX router');
  assert.ok(explainFingerprint(buyer.fingerprint).some((p) => p.k === 'route' && p.v === 'OKX DEX router'));
  assert.match(report.launch.fingerprints.groups.find((g) => g.wallets.includes(BUYER)).label, /OKX DEX router/);
  assert.match(panelHtml(report), /OKX DEX router/);
  const cli = cliOutput(report);
  assert.match(cli, /OKX DEX router program/);
  assert.ok(cli.includes(BUYER));
  assert.ok(!buyer.routeEvidence.some((e) => e.kind === 'fee' && e.address === OKX));
});

test('router label stays distinct from OKX exchange wallet, Maestro fee and unknown programs', () => {
  assert.equal(routeLabel(OKX), 'OKX DEX router');
  assert.equal(known.exchanges[CEX], 'OKX');
  assert.equal(known.exchanges[OKX], undefined);
  assert.equal(known.programs[CEX], undefined);
  assert.equal(known.botFees[OKX], undefined);
  assert.equal(known.botFees[MAESTRO].label, 'Maestro');
  assert.equal(routeLabel(CEX), '5VCw…NmcD');
  assert.equal(routeLabel('unknown-program'), 'unkn…gram');
  assert.equal(routeLabel(PROGRAMS.JUPITER_V6), 'Jupiter');
});

test('nested OKX path and Maestro payment preserve the entry router and independent labels', () => {
  const report = reportFor(synthetic([node(OKX, [move()]), fee()]));
  const buyer = report.launch.buyers.find((b) => b.wallet === BUYER);
  assert.equal(buyer.routeLabel, 'Jupiter');
  assert.deepEqual(buyer.routeEvidence.map((e) => [e.kind, e.label]),
    [['program', 'Jupiter'], ['program', 'OKX DEX router'], ['fee', 'Maestro']]);
  const html = panelHtml(report);
  assert.match(html, /OKX DEX router program/);
  assert.match(html, /Maestro fee payment/);
  assert.match(html, /Jupiter/);
});

test('program presence, unrelated nested invocation and unknown router do not label the trade', () => {
  for (const tx of [synthetic([move()]), synthetic([node(OKX), move()]),
    synthetic([node(PROGRAMS.PUMPSWAP, [move()]), node(OKX)])]) {
    assert.deepEqual(okxEvidence(tx), []);
    assert.ok(!panelHtml(reportFor(tx)).includes('OKX DEX router'));
  }
  const unknown = structuredClone(captured);
  const replacement = 'MaestroAAe9ge5HTc64VbBQZ6fP77pwvrhM8i1XWSAx';
  // A deliberately renamed program is synthetic; do not infer a label from the original receipt.
  const renamed = JSON.parse(JSON.stringify(unknown).replaceAll(OKX, replacement));
  const record = parseTx(renamed);
  assert.equal(record.entryProgram, replacement);
  assert.ok(!record.routeEvidence.some((e) => e.address === replacement));
  assert.equal(routeLabel(replacement), 'Maes…WSAx');
});

test('failed transaction, caught failed router subtree and missing logs suppress program evidence', () => {
  const failed = structuredClone(captured); failed.meta.err = { InstructionError: [6, 'synthetic'] };
  const missing = structuredClone(captured); missing.meta.logMessages = [];
  const caught = synthetic([node(OKX, [move()], undefined, true)]);
  for (const tx of [failed, missing, caught]) assert.deepEqual(okxEvidence(tx), []);
  assert.deepEqual(reportFor(failed).launch.buyers, []);
  assert.ok(!panelHtml(reportFor(caught)).includes('OKX DEX router'));
});
