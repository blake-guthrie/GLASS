import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import known from '../src/data/known.js';
import { PROGRAMS, JITO_TIP_ACCOUNTS } from '../src/lib/constants.js';
import { parseTx } from '../src/lib/txparse.js';
import { extractLaunchEvents } from '../src/lib/scan/launch.js';
import { analyseLaunch, routeLabel, explainFingerprint } from '../src/lib/scan/fingerprint.js';
import { classifyFeeWallet, annotateFeeWallets } from '../src/lib/scan/feewallets.js';

const FEE = 'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36';
const OBSERVED_PROGRAM = 'MaestroAAe9ge5HTc64VbBQZ6fP77pwvrhM8i1XWSAx';
const BUYER = 'EDNPGnPKEkvyBjn5YrcrxXDkJZyHfn46XhkQprchBWYg';
const MINT = '3w67qwokqjcS6KbZhzNonhmFNGjYbWneB7g5HTXwpump';
const SIG = '238hniW3yhcpUB2k2eah8Kmdmb3W4MJQjVFVwqV2Gj7NWs5W9j2vSsvx7gpxC7MG6GkuigrpifvbpDdbbyNfdbEf';
const fixtureBytes = readFileSync(new URL('./fixtures/maestro-fee-mainnet.json', import.meta.url));
const captured = JSON.parse(fixtureBytes).response.result;
const evidence = (tx) => parseTx(tx)?.routeEvidence || [];
const fees = (tx) => evidence(tx).filter((e) => e.kind === 'fee');

// These are synthetic instruction trees, not additional chain receipts. Reused public addresses
// only provide valid key shapes; no ownership or program attribution is inferred from these cases.
const POOL = PROGRAMS.PUMPSWAP, SOURCE = PROGRAMS.WSOL, DEST = PROGRAMS.ATA;
const node = (programId, parsed, children = [], failed = false) => ({ programId, parsed, children, failed });
const move = (over = {}, failed = false) => node(PROGRAMS.TOKEN, { type: 'transferChecked', info: {
  source: SOURCE, destination: DEST, authority: POOL, mint: MINT,
  tokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 }, ...over,
} }, [], failed);
const fee = (over = {}, failed = false) => node(PROGRAMS.SYSTEM, { type: 'transfer', info: {
  source: BUYER, destination: FEE, lamports: 2000000, ...over,
} }, [], failed);
const group = (children, program = PROGRAMS.JUPITER_V6, failed = false) => node(program, undefined, children, failed);
function synthetic(roots = [group([move(), fee()])]) {
  const innerInstructions = [], logMessages = [], instructions = [];
  const visit = (n, depth, flat) => {
    const ix = { programId: n.programId, stackHeight: depth, ...(n.parsed ? { parsed: n.parsed,
      program: n.programId === PROGRAMS.SYSTEM ? 'system' : 'spl-token' } : {}) };
    flat.push(ix);
    logMessages.push(`Program ${n.programId} invoke [${depth}]`);
    for (const child of n.children) visit(child, depth + 1, flat);
    logMessages.push(`Program ${n.programId} ${n.failed ? 'failed: synthetic caught failure' : 'success'}`);
  };
  roots.forEach((root, index) => {
    const flat = [];
    visit(root, 1, flat);
    instructions.push(flat.shift());
    if (flat.length) innerInstructions.push({ index, instructions: flat });
  });
  const balance = (accountIndex, owner, uiAmount) => ({ accountIndex, owner, mint: MINT,
    uiTokenAmount: { amount: String(uiAmount * 1e6), decimals: 6, uiAmount } });
  return { slot: 100, blockTime: 1000, version: 0,
    transaction: { signatures: ['synthetic-receipt'], message: { instructions,
      accountKeys: [{ pubkey: BUYER, signer: true }, { pubkey: SOURCE }, { pubkey: DEST }, { pubkey: FEE }] } },
    meta: { err: null, fee: 5000, innerInstructions, logMessages,
      preBalances: [1000000000, 0, 0, 0], postBalances: [998000000, 0, 0, 2000000],
      preTokenBalances: [balance(1, POOL, 1), balance(2, BUYER, 0)],
      postTokenBalances: [balance(1, POOL, 0), balance(2, BUYER, 1)] } };
}
function launch(tx, creator = POOL) {
  const record = parseTx(tx);
  record.order = record.slot * 1000000;
  // Synthetic launch context, NOT a claim that the captured swap was a token's creation.
  const creation = { record: { slot: record.slot, blockTime: record.blockTime, feePayer: creator,
    sig: 'synthetic-creation-context' }, generic: true, bondingCurve: null };
  const events = extractLaunchEvents([record], MINT, creation);
  return { record, events, analysis: analyseLaunch(events) };
}
function panelHtml(report) {
  const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
  const marker = '  // ---------- live refresh';
  assert.ok(source.includes(marker), 'expose the existing Panel after its declaration, before page side effects');
  const context = vm.createContext({});
  vm.runInContext(source.replace(marker, '  globalThis.TestPanel = Panel; return;\n' + marker), context);
  return context.TestPanel.prototype.secReceipts.call({ sec: (_id, _title, _count, html) => html },
    JSON.parse(JSON.stringify(report)));
}

test('captured mainnet receipt is unchanged and maps the published native fee role', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), 'c47b5496f0bf325cc61322a603f4b348de4cd1c8ededecfda331b287e246991e');
  assert.equal(captured.transaction.signatures[0], SIG);
  assert.equal(captured.meta.err, null);
  assert.equal(captured.slot, 460759094);
  assert.equal(captured.version, 1);
  const f = fees(captured).find((e) => e.wallet === BUYER && e.mint === MINT);
  assert.ok(f, 'the real successful recipient payment must reach parsed route evidence');
  assert.equal(f.address, FEE);
  assert.equal(f.label, 'Maestro');
  assert.equal(f.lamports, 2000000);
  assert.equal(f.outerIndex, 2);
  assert.equal(f.signature, SIG);
  assert.equal(f.source, 'https://docs.maestrobots.com/sniper/monetization');
  assert.equal(known.programs[OBSERVED_PROGRAM], undefined, 'observed association is not official program attribution');
});

test('captured receipt reaches launch analysis, serialized report and actual panel renderer', () => {
  const { record, analysis } = launch(captured);
  const buyer = analysis.buyers.find((b) => b.wallet === BUYER);
  assert.ok(buyer);
  assert.equal(buyer.route, OBSERVED_PROGRAM, 'do not replace the actual entry program with a fee label');
  assert.equal(buyer.routeLabel, routeLabel(record.entryProgram));
  assert.ok(buyer.routeEvidence?.some((e) => e.kind === 'fee' && e.address === FEE));
  assert.ok(buyer.routeEvidence.some((e) => e.kind === 'program' && e.label === 'PumpSwap'));
  const html = panelHtml({ launch: analysis });
  assert.match(html, /Maestro fee payment/);
  assert.match(html, /PumpSwap program/);
  assert.ok(html.includes(`https://solscan.io/tx/${SIG}`));
  assert.match(html, /not proof of program ownership or operator identity/);
  assert.ok(html.includes(OBSERVED_PROGRAM), 'unlabelled entry program is retained in tooltip');
});

test('registry programs reach route labels, fingerprints and buyer reports without replacing builtins', () => {
  known.programs[OBSERVED_PROGRAM] = 'Synthetic registry router';
  const previous = known.programs[PROGRAMS.JUPITER_V6];
  known.programs[PROGRAMS.JUPITER_V6] = 'Must not override builtin';
  try {
    assert.equal(routeLabel(OBSERVED_PROGRAM), 'Synthetic registry router');
    assert.equal(routeLabel(PROGRAMS.JUPITER_V6), 'Jupiter');
    assert.equal(routeLabel(null), 'unknown');
    assert.equal(routeLabel(FEE), 'Maes…HE36', 'fee recipient is not an executable program');
    const { analysis } = launch(synthetic([group([move(), fee()], OBSERVED_PROGRAM)]));
    const b = analysis.buyers.find((x) => x.wallet === BUYER);
    assert.equal(b.routeLabel, 'Synthetic registry router');
    assert.match(analysis.fingerprints.dominant.label, /Synthetic registry router/);
    assert.ok(JSON.stringify(explainFingerprint(b.fingerprint)).includes('Synthetic registry router'));
  } finally {
    delete known.programs[OBSERVED_PROGRAM];
    if (previous === undefined) delete known.programs[PROGRAMS.JUPITER_V6]; else known.programs[PROGRAMS.JUPITER_V6] = previous;
  }
});

test('mixed nested programs and fee labels remain separate and deduplicate repeated event evidence', () => {
  const tx = synthetic([group([group([move()], PROGRAMS.PUMPSWAP), fee()])]);
  const { events, analysis } = launch(tx);
  const b = analysis.buyers.find((x) => x.wallet === BUYER);
  assert.equal(b.routeLabel, 'Jupiter');
  assert.ok(Array.isArray(b.routeEvidence), 'report exposes separate observed route evidence');
  assert.deepEqual(b.routeEvidence.map((e) => e.label), ['Jupiter', 'PumpSwap', 'Maestro']);
  const doubled = analyseLaunch([...events, ...events]).buyers.find((x) => x.wallet === BUYER);
  assert.equal(doubled.routeEvidence.length, b.routeEvidence.length);
  const withoutFee = launch(synthetic([group([group([move()], PROGRAMS.PUMPSWAP)])])).analysis.buyers.find((x) => x.wallet === BUYER);
  assert.equal(b.fingerprint, withoutFee.fingerprint, 'bot fee is not an operator identity/fingerprint key');
});

test('no bot attribution from mere address presence, standalone gift or unrelated nested fee branch', () => {
  for (const tx of [synthetic([group([move()])]), synthetic([group([move()]), fee()]),
    synthetic([group([group([move()], PROGRAMS.PUMPSWAP), group([fee()], PROGRAMS.RAYDIUM_AMM)])])]) {
    assert.deepEqual(fees(tx), []);
  }
});

test('multiple registered recipients retain independent evidence and repeated fees retain amounts', () => {
  // Temporary test-only registry entry; it is removed and never shipped as an attribution.
  const registry = known.botFees;
  assert.ok(registry, 'native fee registry exists');
  registry[PROGRAMS.WSOL] = { label: 'Synthetic fee service', role: 'native-sol-fee-recipient',
    source: 'https://example.invalid/synthetic', verifiedAt: '2026-10-24' };
  try {
    const tx = synthetic([group([move(), fee(), fee({ lamports: 1 }), fee({ destination: PROGRAMS.WSOL, lamports: 2 })])]);
    const result = fees(tx);
    assert.deepEqual(result.map((e) => [e.label, e.lamports]), [['Maestro', 2000000], ['Maestro', 1], ['Synthetic fee service', 2]]);
    assert.equal(new Set(result.map((e) => e.instructionIndex)).size, 3);
    const html = panelHtml({ launch: launch(tx).analysis });
    assert.equal((html.match(/Maestro fee payment/g) || []).length, 1);
    assert.match(html, /Synthetic fee service fee payment/);
  } finally { delete registry[PROGRAMS.WSOL]; }
});

test('parsed Token-2022 and newly initialized recipient metadata support the same native fee rule', () => {
  const transfer = move(); transfer.programId = PROGRAMS.TOKEN_2022;
  const init = node(PROGRAMS.TOKEN_2022, { type: 'initializeAccount3', info: { account: DEST, mint: MINT, owner: BUYER } });
  const tx = synthetic([group([init, transfer, fee()])]);
  tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b) => b.accountIndex !== 2);
  tx.meta.postTokenBalances = tx.meta.postTokenBalances.filter((b) => b.accountIndex !== 2);
  assert.equal(fees(tx).find((e) => e.wallet === BUYER)?.label, 'Maestro');
});

test('strict system transfer role, source and positive integer amount are required', () => {
  const wrongType = fee(); wrongType.parsed.type = 'createAccount';
  const wrongProgram = fee(); wrongProgram.programId = PROGRAMS.TOKEN;
  const invalid = [wrongType, wrongProgram, fee({ source: POOL }), fee({ source: FEE }),
    ...[0, -1, 0.5, NaN, Infinity, 'NaN', '1e6', '', null, true, Number.MAX_SAFE_INTEGER + 1].map((lamports) => fee({ lamports }))];
  for (const f of invalid) assert.deepEqual(fees(synthetic([group([move(), f])])).filter((e) => e.wallet === BUYER), []);
  assert.equal(fees(synthetic([group([move(), fee({ lamports: '2000000' })])])).length, 1);
  const seeded = fee(); seeded.parsed.type = 'transferWithSeed';
  assert.equal(fees(synthetic([group([move(), seeded])])).length, 1);
});

test('unknown fee addresses and Jito tips remain unlabelled as bots', () => {
  for (const destination of [POOL, [...JITO_TIP_ACCOUNTS][0]]) assert.deepEqual(fees(synthetic([group([move(), fee({ destination })])])), []);
  const tx = synthetic([group([move(), fee({ destination: [...JITO_TIP_ACCOUNTS][0] })])]);
  assert.equal(parseTx(tx).jitoTip, 2000000, 'existing tip detection is preserved');
});

test('failed transactions, failed fee CPI and rolled-back successful descendants do not label', () => {
  const failedTx = synthetic(); failedTx.meta.err = { InstructionError: [0, 'synthetic'] };
  const failedFee = synthetic([group([move(), fee({}, true)])]);
  const caughtParent = synthetic([group([group([move(), fee()], PROGRAMS.PUMPSWAP, true)])]);
  for (const tx of [failedTx, failedFee, caughtParent]) assert.deepEqual(fees(tx), []);
  assert.deepEqual(evidence(caughtParent), [], 'rolled-back token movement also cannot establish program evidence');
  const caughtSibling = synthetic([group([group([fee()], PROGRAMS.PUMPSWAP, true), move(), fee()])]);
  assert.equal(fees(caughtSibling).length, 1, 'successful sibling evidence remains usable after a caught failure');
});

test('missing, truncated, inconsistent or spoofed log paths do not establish new attribution', () => {
  const noLogs = synthetic(); delete noLogs.meta.logMessages;
  const truncated = synthetic(); truncated.meta.logMessages.pop();
  const mismatched = synthetic(); mismatched.meta.logMessages[0] = `Program ${POOL} invoke [1]`;
  const wrongDepth = synthetic(); wrongDepth.meta.innerInstructions[0].instructions[0].stackHeight = 3;
  const spoofed = synthetic(); spoofed.meta.logMessages = spoofed.meta.logMessages.map((l) => `Program log: ${l}`);
  for (const tx of [noLogs, truncated, mismatched, wrongDepth, spoofed]) assert.deepEqual(evidence(tx), []);
});

test('Compute Budget logs may be present or absent without shifting attribution', () => {
  const tx = synthetic([node(PROGRAMS.COMPUTE_BUDGET), group([move(), fee()])]);
  assert.equal(fees(tx)[0]?.outerIndex, 1);
  tx.meta.logMessages = tx.meta.logMessages.filter((l) => !l.includes(PROGRAMS.COMPUTE_BUDGET));
  assert.equal(fees(tx)[0]?.outerIndex, 1);
});

test('no payment association without a successful compatible wallet token movement', () => {
  const failedMove = synthetic([group([move({}, true), fee()])]);
  const wrongMint = synthetic([group([move({ mint: PROGRAMS.WSOL }), fee()])]);
  const invalidAmount = synthetic([group([move({ tokenAmount: { amount: '0' } }), fee()])]);
  const conflict = synthetic(); conflict.meta.postTokenBalances[1].owner = POOL;
  for (const tx of [failedMove, wrongMint, invalidAmount, conflict]) assert.deepEqual(fees(tx), []);
});

test('wallet, mint and outer-instruction boundaries prevent cross-trade fee leakage', () => {
  const tx = synthetic([group([move(), fee()])]);
  const rec = parseTx(tx);
  // Pump event metadata is synthetic here to exercise the real launch-event consumer boundary.
  rec.pumpEvents = [0, 1].map((outerIndex) => ({ type: 'trade', mint: MINT, user: BUYER,
    isBuy: true, tokenAmount: 1, quoteAmount: 0.1, priceQuote: 0.1, outerIndex }));
  rec.pumpEvents.push({ ...rec.pumpEvents[0], user: POOL });
  const events = extractLaunchEvents([rec], MINT, { record: { ...rec, feePayer: FEE, sig: 'creation' } });
  assert.equal(events[0].routeEvidence?.filter((e) => e.kind === 'fee').length, 1);
  assert.deepEqual(events[1].routeEvidence, []);
  assert.equal(events[2].routeEvidence.filter((e) => e.kind === 'fee').length, 0);
  rec.pumpEvents = [{ ...rec.pumpEvents[0], mint: PROGRAMS.WSOL }];
  assert.deepEqual(extractLaunchEvents([rec], PROGRAMS.WSOL, { record: rec })[0].routeEvidence, []);
});

test('official shared fee account does not become private-operator coordination evidence', async () => {
  let requests = 0;
  const rpc = { async getSignaturesForAddress() { requests++; throw new Error('offline test must not request known labels'); } };
  const classification = await classifyFeeWallet(rpc, FEE);
  assert.equal(classification.platform, true);
  assert.match(classification.label, /Maestro/);
  assert.equal(requests, 0);
  const event = launch(synthetic()).events.find((e) => e.wallet === BUYER);
  const events = [0, 1, 2].map((i) => ({ ...event, wallet: `synthetic-wallet-${i}`, payer: `synthetic-wallet-${i}`, cuLimit: 1000 * i,
    externalFeeRecipients: [FEE], routeEvidence: [] }));
  const analysis = analyseLaunch(events);
  assert.equal(analysis.sharedFeeRecipients[0].platform, true);
  assert.ok(!analysis.launchToolPattern.reasons.some((r) => /fee/i.test(r)));
  const unknown = analyseLaunch(events.map((e) => ({ ...e, externalFeeRecipients: ['synthetic-unknown'] })));
  assert.ok(unknown.launchToolPattern.reasons.some((r) => /same non-protocol fee wallet/.test(r)));
  await annotateFeeWallets(rpc, analysis);
  assert.match(analysis.sharedFeeRecipients[0].label, /Maestro/);
  assert.equal(requests, 0);
});

test('unknown fee accounts retain the existing offline classification path', async () => {
  let requests = 0;
  const c = await classifyFeeWallet({ async getSignaturesForAddress(address) {
    requests++; assert.equal(address, 'synthetic-unknown-fee'); return [];
  } }, 'synthetic-unknown-fee');
  assert.equal(requests, 1);
  assert.equal(c.platform, false);
  assert.equal(c.payers, 0);
});

test('creator receipts also display fee evidence without inventing a program name', () => {
  const { analysis } = launch(synthetic(), BUYER);
  const html = panelHtml({ launch: analysis, creation: { creator: BUYER, sig: 'synthetic-create' } });
  assert.match(html, /Maestro fee payment/);
  assert.match(html, /Jupiter/);
  assert.equal(analysis.buyers.length, 0);
});

test('panel escapes registry text and keeps fee and program roles visibly distinct', () => {
  const { analysis } = launch(synthetic());
  assert.ok(Array.isArray(analysis.buyers[0].routeEvidence), 'report exposes separate observed route evidence');
  analysis.buyers[0].routeEvidence.push({ kind: 'fee', label: '<img src=x onerror=alert(1)>', address: FEE, signature: 'synthetic' });
  const html = panelHtml({ launch: analysis });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});
