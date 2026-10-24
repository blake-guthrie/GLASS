# Bot and router labels

GLASS preserves the entry program in the transaction fingerprint. Built-in route names take
precedence, then `src/data/known.js` → `programs` supplies community labels. Unknown programs
remain addresses. Nested labelled programs are additional evidence, not replacements for the
entry route. A shared public router or fee recipient does not establish a shared operator.

## Maestro fee recipient (registry revision 1)

The [official Maestro monetization documentation](https://docs.maestrobots.com/sniper/monetization),
reviewed on **2026-10-24**, lists **Solana** recipient
`MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36` and explains that Solana fees are taken within
the trade transaction. This entry is a **native SOL fee recipient**, not a program ID.
The documentation is a dated live source, not a versioned vendor release.

The panel and CLI show **Maestro fee payment** when the parsed transaction establishes a
successful positive System Program transfer to that recipient, from the wallet whose token
movement is inside the same successful invocation subtree. The report retains the recipient,
lamports, wallet, mint, instruction positions, signature and source URL. This is evidence of
the payment to the published account. It does not prove who wrote the invoking program,
which client originated the transaction, why the payment was made, or who controls the trader.
Actual Jupiter, PumpSwap and other route evidence remains visible alongside the fee label.

The known shared fee account is also excluded from the existing private fee-wallet coordination
signal. Its popularity alone is not a link between traders.

### Captured receipt

- Signature: [`238hniW3yhcpUB2k2eah8Kmdmb3W4MJQjVFVwqV2Gj7NWs5W9j2vSsvx7gpxC7MG6GkuigrpifvbpDdbbyNfdbEf`](https://solscan.io/tx/238hniW3yhcpUB2k2eah8Kmdmb3W4MJQjVFVwqV2Gj7NWs5W9j2vSsvx7gpxC7MG6GkuigrpifvbpDdbbyNfdbEf)
- Solana mainnet, finalized slot **460759094**, block time **1792825544**, transaction version **1**.
- Retrieved with `getTransaction`, `encoding: "jsonParsed"`, `commitment: "finalized"`,
  `maxSupportedTransactionVersion: 1` from `https://api.mainnet.solana.com` on 2026-10-24.
- Successful inner System transfer: **2,000,000 lamports** from
  `EDNPGnPKEkvyBjn5YrcrxXDkJZyHfn46XhkQprchBWYg` to the published fee recipient,
  under outer instruction **2**. The same transaction includes nested swap instructions.
- The raw response wrapper is `test/fixtures/maestro-fee-mainnet.json`, SHA-256
  `c47b5496f0bf325cc61322a603f4b348de4cd1c8ededecfda331b287e246991e`.

The receipt's invoking program is intentionally **not** added to the program registry:
the captured association alone is not independent official attribution of that program.

## Evidence limits

- Labels require exact addresses and instruction roles. Mere account presence, standalone
  SOL transfers, unrelated invocation subtrees, zero/invalid amounts and Jito tips do not
  establish a bot label. Token-denominated fees are not supported by this native SOL entry.
- Runtime invocation logs must match the parsed instructions. Failed transactions, failed
  CPIs and descendants rolled back by a caught ancestor failure do not establish evidence.
  Missing, truncated or inconsistent paths produce no new attribution for those paths.
- Token movements require parsed Token/Token-2022 transfers with compatible account-owner
  and mint metadata. Amounts must be positive safe integers. Missing metadata, unsupported
  encodings or larger amounts can leave a route unlabelled; absence is **unknown**, not proof
  that a bot was not used. Top-level fee transfers are conservatively not attributed because
  their relationship to a particular swap cannot be established by a parent invocation.
- This contribution adds one verified Maestro fee recipient and connects the existing
  program registry. It does **not** add verified Axiom, BullX, GMGN, Trojan or Bloom addresses,
  claim complete Maestro coverage, or identify launch tools from bot fees.

## Updating and testing

Add an officially attributable executable address to `known.programs`, or a verified native
fee recipient to `known.botFees` with its `label`, `role`, source URL and review date. Preserve
chain, role and version distinctions. Include a real public transaction showing the role;
third-party explorer labels or an address occurring in a transaction are insufficient alone.

`node --test test/bot-labels.test.mjs` checks the captured receipt through parsing, launch
analysis, serialized report and the actual panel receipt renderer. Synthetic instruction trees
exercise role, amount, wallet/mint, nesting, failure, mixed-route and common-infrastructure
boundaries. Synthetic launch metadata around the captured swap only supplies an analysis
context; the test does not claim the swap was the token's creation. The panel test executes
its real rendering method in Node with page startup disabled; it is not a browser runtime
or live scan test. All tests are offline and make no RPC requests. `npm test` runs the full suite.
