import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTx } from '../src/lib/txparse.js';
import { profileWallets } from '../src/lib/scan/wallets.js';
import { PROGRAMS } from '../src/lib/constants.js';
import vm from 'node:vm';
import { runScan } from '../src/lib/scan/pipeline.js';
import { derivePumpAccounts } from '../src/lib/scan/launch.js';

const captured = JSON.parse(readFileSync(new URL('./fixtures/jupiter-wsol-r419.json', import.meta.url))).result;
const wallet = '6zQr2VFFTYjSt9VjCnMbQy65W7pZF9SufvefCXKvr7z1';
const sponsor = 'FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT';
async function profile(tx = captured, address = wallet) {
  const sig = tx.transaction.signatures[0];
  const rpc = {
    async getSignaturesForAddress(a) { return a === address ? [{ signature: sig, slot: tx.slot, blockTime: tx.blockTime }] : []; },
    async getTransactions(sigs) { return sigs.map(() => tx); },
  };
  return profileWallets(rpc, [address], { launchTimeSec: tx.blockTime + 60, known: {}, buyersSet: new Set() });
}

test('captured ephemeral close identifies native mint and separates account owner from close authority', () => {
  const close = parseTx(captured).closeAccounts[0];
  assert.equal(close.mint, 'So11111111111111111111111111111111111111112');
  assert.equal(close.accountOwner, wallet);
  assert.equal(close.closeAuthority, wallet);
});

test('captured Jupiter proceeds and sponsored rent are not attributed wholesale to the fee payer', async () => {
  const { profiles: [p], summary } = await profile();
  assert.equal(p.fundingSource, null);
  assert.equal(p.fundingMethod, 'swap-proceeds');
  assert.equal(p.firstPayer, sponsor);
  assert.equal(p.fundingEvidence.components.find(c => c.kind === 'swap-proceeds').lamports, 16005);
  assert.equal(p.fundingEvidence.components.find(c => c.kind === 'account-rent').lamports, 1488440);
  assert.equal(p.fundingEvidence.components.find(c => c.kind === 'account-rent').source, sponsor);
  assert.equal(p.fundingEvidence.receivedLamports, 1504445);
  assert.equal(p.fundingHistory, 'first-observed');
  assert.equal(p.ageHoursAtLaunch, null);
  assert.match(p.fundingNote, /swap proceeds/);
  assert.equal(summary.sharedFunders.length, 0);
  assert.ok(!p.flags.some(f => /evasion|first ever|wallet created/.test(f)));
  const output = p.fundingEvidence.components.find(c => c.kind === 'swap-proceeds');
  assert.deepEqual(output.inputOwners, [wallet]);
  assert.deepEqual(output.inputs.map(i => i.rawAmount), [1630]); // excludes the separate 156692-unit payment
  assert.equal(p.fundingEvidence.preSolLamports, 650241);
  assert.equal(p.fundingEvidence.feeLamports, 10058);
});

// Everything below uses synthetic protocol-shaped transactions or explicitly mutated capture
// variants. These are algorithm controls, not additional observed mainnet history.
const other = '8ekCy2jHHUbW2yeNGFWYJT9Hm9FW7SvZcZK66dSZCDiF';
const account = 'AVgCN28iGemGnjCUo8GkRfdqjA1yDHgGQiFwU34JxvFh';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const clone = () => structuredClone(captured);
function closeTx({ owner = wallet, authority = wallet, native = true, principal = 16005, rent = 1488440 } = {}) {
  const keys = [...new Set([sponsor, wallet, account, owner, authority])];
  const balances = Object.fromEntries(keys.map(k => [k, 650241]));
  balances[sponsor] = 9000000; balances[account] = rent + (native ? principal : 0);
  const after = { ...balances, [account]: 0, [wallet]: balances[wallet] + balances[account], [sponsor]: balances[sponsor] - 5000 };
  return { slot: 42, blockTime: 1700000000, version: 0,
    transaction: { signatures: ['synthetic-close'], message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [
      { programId: PROGRAMS.TOKEN, program: 'spl-token', parsed: { type: 'closeAccount', info: { account, destination: wallet, owner: authority } } },
    ] } }, meta: { err: null, fee: 5000, preBalances: keys.map(k => balances[k]), postBalances: keys.map(k => after[k]),
      preTokenBalances: [{ accountIndex: keys.indexOf(account), mint: native ? PROGRAMS.WSOL : mint, owner, programId: PROGRAMS.TOKEN, uiTokenAmount: { amount: String(native ? principal : 0), decimals: native ? 9 : 6, uiAmount: native ? principal / 1e9 : 0 } }], postTokenBalances: [], innerInstructions: [], logMessages: [] } };
}
function solTx(from = other, amount = 2000000000) {
  return { slot: 43, blockTime: 1700000000, version: 0, transaction: { signatures: ['synthetic-sol'], message: {
    accountKeys: [sponsor, wallet, from].map(pubkey => ({ pubkey })), instructions: [{ programId: PROGRAMS.SYSTEM, program: 'system', parsed: { type: 'transfer', info: { source: from, destination: wallet, lamports: amount } } }],
  } }, meta: { err: null, fee: 5000, preBalances: [100000, 0, amount], postBalances: [95000, amount, 0], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [] } };
}

test('self unwrap retains principal and unknown historical rent depositor without inventing a funder', async () => {
  const { profiles: [p] } = await profile(closeTx());
  assert.equal(p.fundingMethod, 'self-unwrap'); assert.equal(p.fundingSource, null);
  assert.deepEqual(p.fundingEvidence.components.map(c => [c.kind, c.lamports, c.source]), [['self-unwrap', 16005, wallet], ['account-rent', 1488440, null]]);
});

test('real external WSOL principal is attributed to the token owner, not delegated close authority or fee payer', async () => {
  const { profiles: [p] } = await profile(closeTx({ owner: other, authority: wallet }));
  assert.equal(p.fundingMethod, 'wsol-close'); assert.equal(p.fundingSource, other);
  assert.equal(p.fundedSol, 0.000016005);
  assert.equal(p.fundingEvidence.closes[0].accountOwner, other);
  assert.equal(p.fundingEvidence.closes[0].closeAuthority, wallet);
  assert.equal(p.firstPayer, sponsor);
});

test('non-WSOL token close is returned rent, never WSOL funding', async () => {
  const { profiles: [p] } = await profile(closeTx({ native: false, owner: other }));
  assert.equal(p.fundingSource, null); assert.equal(p.fundingMethod, 'rent-return');
  assert.deepEqual(p.fundingEvidence.components.map(c => [c.kind, c.lamports]), [['account-rent', 1488440]]);
});

test('ordinary SOL transfers preserve exact funding and exchange classification', async () => {
  const tx = solTx(), rpc = { async getSignaturesForAddress(a) { return a === wallet ? [{ signature: 'sol', blockTime: tx.blockTime, slot: tx.slot }] : []; }, async getTransactions(s) { return s.map(() => tx); } };
  const { profiles: [p] } = await profileWallets(rpc, [wallet], { launchTimeSec: tx.blockTime + 60, known: { exchanges: { [other]: 'Example exchange' } } });
  assert.equal(p.fundingSource, other); assert.equal(p.fundingKind, 'exchange'); assert.equal(p.fundedSol, 2);
  assert.equal(p.fundingEvidence.receivedLamports, 2000000000);
});

test('failed transaction cannot provide transfers, close provenance or payer linkage', async () => {
  const tx = clone(); tx.meta.err = { InstructionError: [2, 'Custom'] };
  const { profiles: [p], summary } = await profile(tx);
  assert.equal(p.fundingSource, null); assert.equal(p.firstPayer, null); assert.equal(p.fundingEvidence, undefined);
  assert.equal(parseTx(tx).closeAccounts[0].successful, false); assert.equal(summary.sharedFunders.length, 0);
});

test('missing transaction execution status cannot establish incoming funding', async () => {
  const tx = clone(); delete tx.meta.err;
  const { profiles: [p] } = await profile(tx);
  assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence, undefined);
  assert.equal(parseTx(tx).closeAccounts[0].successful, false);
});

test('missing runtime logs leave ephemeral mint and proceeds unresolved instead of assuming fee payer funding', async () => {
  const tx = clone(); tx.meta.logMessages = null;
  const { profiles: [p] } = await profile(tx);
  assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence.coverage, 'partial');
  assert.equal(p.fundingEvidence.receivedLamports, null); assert.equal(p.fundingMethod, 'unknown');
});

test('missing balances and unexplained recipient gains do not yield a fabricated exact breakdown', async () => {
  for (const variant of ['missing', 'extra']) {
    const tx = clone();
    if (variant === 'missing') tx.meta.preBalances = [];
    else tx.meta.postBalances[tx.transaction.message.accountKeys.findIndex(k => k.pubkey === wallet)] += 1;
    const { profiles: [p] } = await profile(tx);
    assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence.receivedLamports, null);
    assert.equal(p.fundingEvidence.coverage, 'partial');
  }
});

test('unresolved close mint and conflicting account owner do not become external funding', async () => {
  for (const variant of ['unknown', 'conflicting']) {
    const tx = closeTx({ owner: other });
    if (variant === 'unknown') tx.meta.preTokenBalances = [];
    else tx.meta.postTokenBalances = [{ ...tx.meta.preTokenBalances[0], owner: wallet }];
    const { profiles: [p] } = await profile(tx);
    assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence.coverage, 'partial');
  }
});

test('Jupiter account presence and unrelated successful invocation do not turn a self unwrap into swap proceeds', async () => {
  for (const invoke of [false, true]) {
    const tx = closeTx(); tx.transaction.message.accountKeys.push({ pubkey: PROGRAMS.JUPITER_V6 }); tx.meta.preBalances.push(1); tx.meta.postBalances.push(1);
    if (invoke) tx.transaction.message.instructions.unshift({ programId: PROGRAMS.JUPITER_V6, accounts: [], data: '1' });
    const { profiles: [p] } = await profile(tx);
    assert.equal(p.fundingMethod, 'self-unwrap'); assert.equal(p.fundingSource, null);
  }
});

test('different or ambiguous swap input owners remain explicit unknown output, never the pool or sponsor as funder', async () => {
  const tx = clone();
  const idx = tx.transaction.message.accountKeys.findIndex(k => k.pubkey === '24aZpsMf4ffkHaMChfKMNfhh82eeMrN991nLHAfnwGM8');
  for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) if (b.accountIndex === idx) b.owner = sponsor;
  const { profiles: [p] } = await profile(tx);
  assert.equal(p.fundingSource, null); assert.notEqual(p.fundingMethod, 'swap-proceeds');
  assert.deepEqual(p.fundingEvidence.components.find(c => c.kind === 'unknown-swap-output').inputOwners, [sponsor]);
});

test('failed nested swap ancestor rolls back its otherwise successful token children', async () => {
  const tx = clone(), old = tx.transaction.message.instructions[2], group = tx.meta.innerInstructions.find(g => g.index === 2);
  tx.transaction.message.instructions[2] = { programId: PROGRAMS.PUMP, accounts: [], data: '1', stackHeight: 1 };
  group.instructions = [{ ...old, stackHeight: 2 }, ...group.instructions.map(i => ({ ...i, stackHeight: i.stackHeight + 1 }))];
  const logs = tx.meta.logMessages, start = logs.findIndex(l => l === `Program ${PROGRAMS.JUPITER_V6} invoke [1]`), end = logs.findLastIndex(l => l === `Program ${PROGRAMS.JUPITER_V6} success`);
  const middle = logs.slice(start, end + 1).map(l => l.replace(/invoke \[(\d+)\]/, (_, n) => `invoke [${+n + 1}]`));
  middle[middle.length - 1] = `Program ${PROGRAMS.JUPITER_V6} failed: custom program error: 1`;
  logs.splice(start, end - start + 1, `Program ${PROGRAMS.PUMP} invoke [1]`, ...middle, `Program ${PROGRAMS.PUMP} success`);
  const idx = tx.transaction.message.accountKeys.findIndex(k => k.pubkey === wallet); tx.meta.postBalances[idx] -= 16005;
  const { profiles: [p] } = await profile(tx);
  assert.equal(p.fundingSource, null); assert.equal(p.fundingMethod, 'rent-return');
  assert.equal(p.fundingEvidence.receivedLamports, 1488440);
  assert.ok(!p.fundingEvidence.components.some(c => c.kind.includes('swap')));
});

test('missing and capped history remain bounded, without first-ever or source claims', async () => {
  for (const count of [1, 1000]) {
    let requests = 0;
    const rpc = { async getSignaturesForAddress() { return Array.from({ length: count }, (_, i) => ({ signature: `missing-${i}`, blockTime: 1700000000, slot: 44 })); }, async getTransactions(s) { requests++; return s.map(() => null); } };
    const { profiles: [p] } = await profileWallets(rpc, [wallet], { launchTimeSec: 1700000000 });
    assert.equal(p.fundingSource, null); assert.equal(p.ageHoursAtLaunch, null);
    assert.ok(!p.flags.some(f => /first ever|wallet created/.test(f)));
    assert.ok(requests <= 1); if (count === 1000) assert.equal(requests, 0);
  }
});

test('independent traders sharing Jupiter and a fee/rent sponsor retain sponsorship without shared-funder scoring', async () => {
  const trader = 'G11111111111111111111111111111111111111111111';
  const rotated = JSON.parse(JSON.stringify(captured).replaceAll(wallet, trader));
  const txs = new Map([[wallet, captured], [trader, rotated]]);
  const rpc = { async getSignaturesForAddress(a) { const tx = txs.get(a); return tx ? [{ signature: a, slot: tx.slot, blockTime: tx.blockTime }] : []; }, async getTransactions(s) { return s.map(a => txs.get(a)); } };
  const { profiles, summary } = await profileWallets(rpc, [wallet, trader], { launchTimeSec: captured.blockTime + 60 });
  assert.ok(profiles.every(p => p.fundingSource === null)); assert.equal(summary.sharedFunders.length, 0);
  assert.ok(profiles.every(p => p.fundingMethod === 'swap-proceeds'));
  assert.deepEqual(summary.sharedPayers, [{ address: sponsor, count: 2, operatorLink: false }]);
  assert.equal(summary.behaviouralLinkScore, 0); assert.equal(summary.fundingTimeClusterMax, 0);
  assert.match(summary.observations.join(' '), /sponsorship alone/);
  assert.equal(summary.rentSponsors[0].lamports, 2976880);
  assert.equal(summary.rentSponsors[0].operatorLink, false);
});

test('invalid amounts, duplicate closes and mismatched log depths remain unknown', async () => {
  for (const variant of ['amount', 'duplicate', 'depth']) {
    const tx = clone();
    if (variant === 'amount') tx.meta.innerInstructions.find(g => g.index === 2).instructions[2].parsed.info.tokenAmount.amount = '-16005';
    if (variant === 'duplicate') tx.transaction.message.instructions.push(structuredClone(tx.transaction.message.instructions[3]));
    if (variant === 'depth') tx.meta.innerInstructions[0].instructions[0].stackHeight = 9;
    const { profiles: [p] } = await profile(tx);
    assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence.receivedLamports, null);
    assert.notEqual(p.fundingMethod, 'swap-proceeds');
  }
});

test('account authority changes and unverified inner movements cannot establish a native close source', async () => {
  for (const variant of ['authority', 'unverified']) {
    const tx = closeTx({ owner: other });
    const ix = { programId: PROGRAMS.TOKEN, program: 'spl-token', parsed: { type: 'setAuthority', info: { account, authority: other, newAuthority: wallet, authorityType: 'accountOwner' } } };
    if (variant === 'authority') tx.transaction.message.instructions.unshift(ix);
    else tx.meta.innerInstructions = [{ index: 0, instructions: [ix] }];
    const { profiles: [p] } = await profile(tx);
    assert.equal(p.fundingSource, null); assert.equal(p.fundingEvidence.coverage, 'partial');
  }
});

test('direct incoming external WSOL preserves source principal alongside existing own principal and rent', async () => {
  const tx = closeTx(), sourceAccount = '5pVN5XZB8cYBjNLFrsBCPWkCQBan5K5Mq2dWGzwPgGJV';
  const index = tx.transaction.message.accountKeys.length;
  tx.transaction.message.accountKeys.push({ pubkey: sourceAccount }); tx.meta.preBalances.push(2000000); tx.meta.postBalances.push(1990000);
  tx.meta.preTokenBalances.push({ accountIndex: index, mint: PROGRAMS.WSOL, owner: other, programId: PROGRAMS.TOKEN, uiTokenAmount: { amount: '10000', decimals: 9, uiAmount: 0.00001 } });
  tx.transaction.message.instructions.unshift({ programId: PROGRAMS.TOKEN, program: 'spl-token', parsed: { type: 'transferChecked', info: { source: sourceAccount, destination: account, mint: PROGRAMS.WSOL, authority: other, tokenAmount: { amount: '10000', decimals: 9, uiAmount: 0.00001 } } } });
  tx.meta.postBalances[1] += 10000;
  const { profiles: [p] } = await profile(tx);
  assert.equal(p.fundingSource, other); assert.equal(p.fundedSol, 0.00001);
  assert.equal(p.fundingEvidence.receivedLamports, 1514445);
  assert.deepEqual(p.fundingEvidence.components.map(c => c.kind), ['self-unwrap', 'account-rent', 'external-wsol']);
});

test('real scan pipeline carries synthetic combined history into report JSON without adding rent sponsor to operator cluster', async t => {
  const pump = JSON.parse(readFileSync(new URL('./fixtures/pump-txs.json', import.meta.url)));
  const raws = Object.values(pump.txs), bySig = new Map(raws.map(tx => [tx.transaction.signatures[0], tx]));
  const infos = raws.map(tx => ({ signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime, err: null })).sort((a,b) => a.slot - b.slot);
  const accounts = await derivePumpAccounts(pump.mint), creator = parseTx(pump.txs.create).feePayer;
  const traders = [...new Set(raws.flatMap(tx => parseTx(tx).pumpEvents.filter(e => e.type === 'trade').map(e => e.user)))].filter(a => a !== creator);
  assert.ok(traders.length >= 2);
  // This transport history is synthetic: captured swap bytes are adapted to launch buyer addresses
  // and an earlier time. It does not assert a chain relationship between these separate captures.
  for (const trader of traders) {
    const tx = JSON.parse(JSON.stringify(captured).replaceAll(wallet, trader));
    tx.transaction.signatures = [`synthetic-history-${trader}`]; tx.blockTime = pump.txs.create.blockTime - 60;
    bySig.set(tx.transaction.signatures[0], tx);
  }
  const rpc = { totalCalls: 0, totalDegraded: 0,
    async getSignaturesForAddress(a) {
      if (a === accounts.metadata) return [infos.find(i => i.signature === pump.sigs.create)];
      if (traders.includes(a)) { const tx = bySig.get(`synthetic-history-${a}`); return [{ signature: tx.transaction.signatures[0], blockTime: tx.blockTime, slot: tx.slot }]; }
      return [];
    }, async getTransaction(s) { return bySig.get(s) || null; }, async getTransactions(ss) { return ss.map(s => bySig.get(s) || null); },
    async getAccountInfo() { return { value: { data: { parsed: { type: 'mint' } }, owner: PROGRAMS.TOKEN_2022 } }; },
    async getMintInfo() { return { supply: 1e9, tokenProgram: PROGRAMS.TOKEN_2022 }; },
    async getBlockAccounts(slot) { return { transactions: raws.filter(tx => tx.slot === slot).map(tx => ({ meta: { err: null }, transaction: { accountKeys: tx.transaction.message.accountKeys, signatures: tx.transaction.signatures } })) }; },
    async pageSignatures() { return { sigs: infos, exhausted: true }; }, async historyStart() { return 0; }, async forSlot() { return rpc; },
    async getTokenBalances(owners) { return owners.map(owner => ({ owner, amount: 0 })); }, async ataFor() { return account; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const host = new URL(url).hostname;
    if (host === 'api.dexscreener.com') return Response.json({ pairs: [] });
    if (host === 'frontend-api-v3.pump.fun') return Response.json([]);
    if (host === 'bundles.jito.wtf') return Response.json({ bundles: [] });
    throw Error(`Unexpected offline fixture request: ${host}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const report = JSON.parse(JSON.stringify(await runScan(rpc, pump.mint, { hintIsMint: true, settings: { operatorHistory: false, jitoLookup: false } })));
  assert.deepEqual(report.errors, []);
  assert.equal(report.wallets.summary.fundingMethods['swap-proceeds'], traders.length);
  assert.equal(report.wallets.summary.sharedFunders.length, 0);
  assert.ok(!report.operatorCluster.linkers.includes(sponsor));
  assert.ok(report.wallets.profiles.every(p => p.fundingEvidence.components.some(c => c.kind === 'swap-proceeds' && c.lamports === 16005)));
});

test('actual panel renders the report receipt with exact small amounts, owner, rent sponsor and uncertainty', async () => {
  const wallets = await profile();
  let source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
  const marker = '  // ---------- live refresh';
  assert.ok(source.includes(marker));
  source = source.replace(marker, '  globalThis.FundingPanel = Panel; return;\n' + marker);
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, chrome: {}, location: { hostname: 'pump.fun' }, document: {} });
  vm.runInContext(source, context);
  const html = context.FundingPanel.prototype.secWallets.call({ sec: (_id, _title, _sub, body) => body }, { wallets, launch: { buyers: [] } });
  for (const text of ['16005 lamports (0.000016005 SOL)', '1488440 lamports (0.001488440 SOL)', 'Jupiter swap proceeds', 'deposited by', 'close authority', 'input owner', 'Transaction fee payer', 'funding receipt', 'earlier funding unknown']) assert.ok(html.includes(text), text);
  assert.ok(html.includes(captured.transaction.signatures[0]));
  assert.ok(!html.includes('hides the transfer'));
});
