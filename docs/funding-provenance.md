# Observed funding provenance

Wallet profiling samples up to six of the oldest available transactions. A positive SOL balance
change is not, by itself, a transfer from the transaction fee payer. A token account close also does
not identify its mint, token owner, rent depositor or economic source from the close authority alone.

`parseTx` attaches versioned `fundingProvenance`. `profileWallets` selects the first observed incoming
receipt and carries `fundingEvidence` into the scan report and the Launch wallets panel. The receipt
keeps signature, slot, time, fee payer/fee, pre-existing SOL, net change, and the exact lamport
components. The panel links the transaction and shows small amounts without rounding them to zero.
The report cache prefix changes to `report:v4:` so previous payer-attributed results are rescanned.

## Interpretation

| Evidence | Meaning |
|---|---|
| Successful direct System transfer | Observed external SOL source; unrelated transaction fees remain separate. |
| Native token principal from another token owner | External WSOL principal; the close authority can be a delegate. |
| Successful Jupiter invocation containing native output and non-native input from the recipient | Observed token-to-SOL swap proceeds, with the input owner/mint/raw amount. The liquidity pool is not called a wallet funder. |
| Own native token principal returned by a close | Self unwrap; earlier funding is unknown. |
| ATA creation deposit returned on close | Observed rent depositor, retained separately from swap principal and fees. |
| Existing account rent returned on close | Rent depositor unknown unless established by this transaction. |
| Non-native token account close | Account rent, not WSOL principal. |
| Unresolved input ownership or incomplete lifecycle | Unknown/partial provenance, without a fee-payer fallback. |

Native WSOL here means the legacy Token program plus `So11111111111111111111111111111111111111112`.
The Token Extensions native mint and arbitrary router variants are not supported by this detector.
Successful initialization resolves ephemeral accounts missing from both token-balance snapshots.
An ATA creation is used as a rent deposit only for a previously empty account, with matching
successful initialization and a single creation deposit. Existing native accounts use their raw
pre-token amount and account lamports to separate principal from reserve.

Inner instructions require complete runtime frame alignment and successful ancestry. A caught failed
CPI and its children are excluded. Successful top-level instructions remain usable when logs are
unavailable. Missing balances, unknown mints, conflicting owners, unsupported authority changes,
repeated closes, unexplained recipient deltas, outgoing native-account movements and unsafe integer
amounts prevent an exact close breakdown. These conservative limits produce unknown results rather
than guessing. Amounts use raw integer units, never floating-point token UI amounts.

`fundingSource` is populated only for one evidenced external principal source. `fundedSol` counts
external SOL/WSOL principal, excluding returned rent and the recipient's own swap proceeds. Multiple
external sources remain separate components without choosing an arbitrary largest funder.
`receivedLamports` is the reconciled gross receipt; `netSolChangeLamports` also reflects outgoing
transfers and fees. `coverage` refers to this transaction's available evidence, not lifetime history.

The summary retains `fundingMethods`, `rentSponsors` and observed `sharedPayers`. Sponsor rows have
`operatorLink: false`; shared fee/rent sponsorship and a public router do not create a shared-funder
edge, funding-time cluster, or additional operator-cluster member. Genuine direct external funding
and exchange labels remain available. This does not change the separate launch-transaction analysis.

History is explicitly **first observed**. A pre-existing SOL/token balance, unavailable transaction,
RPC pruning or the 1,000-signature cap prevents a wallet-age claim. Otherwise age is measured from the
first returned transaction, not proven account creation. Earlier sources, multi-hop transfers and
delayed activity are outside this bounded detector. None of these signals establishes identity or
evasion intent.

## Captured receipt and validation

`test/fixtures/jupiter-wsol-r419.json` is the unchanged public finalized `getTransaction` JSON-RPC
response captured on 2026-10-24. The transaction is in `.result` (version 1, slot 460791027,
`meta.err: null`). SHA-256:

`ba3d8c597cfc16d1c430ad009bc94a05f8a714823ae51085382a3fdef7996d1f`

[Transaction receipt](https://solscan.io/tx/3kNzAFyyRTWe5KPuinp4JipGvD2Fx7Z8znH2XtRygzHqzG6bKwzV2rk6hUmEPeB1TWViRHrBXRic5ucjTREgFpp8):

- Recipient/input owner/close authority: `6zQr2VFFTYjSt9VjCnMbQy65W7pZF9SufvefCXKvr7z1`.
- Fee payer and ATA rent depositor: `FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT`.
- Jupiter output: **16,005 lamports**; ATA rent deposit: **1,488,440 lamports**; recipient gain:
  **1,504,445 lamports**. The fee payer separately paid **10,058 lamports** in transaction fees.
- Jupiter input: **1,630 USDC base units**. A separate **156,692-unit** transfer outside the router
  invocation is not folded into that input. No inference is made about the purpose of that payment.
- Recipient already held **650,241 lamports**; this transaction does not prove first-ever funding.

Primary protocol references, read 2026-10-24:
[native token balances and SyncNative](https://solana.com/docs/tokens/basics/sync-native),
[token-account close and authority/rent semantics](https://solana.com/docs/tokens/basics/close-account).
The existing Jupiter v6 program identifier is used only for successful invocation evidence.

Run `node --test test/funding.test.mjs` for the focused contract and `npm test` for the unchanged
offline suite plus these cases. Two captured-receipt assertions reproduce the original defect on
the parent source. Counterexamples and modified-capture controls are explicitly synthetic. The real
scan-engine test combines the existing pump fixture with adapted funding history; it does not claim
those separate mainnet transactions belong to one launch. The panel test executes its actual renderer
in Node, not a browser. No live scan, complete wallet history, independent cryptographic transaction
verification, identity conclusion or exhaustive Jupiter coverage is claimed.
