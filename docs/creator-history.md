# Creator history beyond pump.fun

`creatorProfile(creator, { rpc, currentMint, launchpadHistory })` adds Bonk,
Raydium LaunchLab and Meteora DBC history to the existing pump.fun record.
The scan pipeline supplies its selected history `RpcClient` for the creator and
up to three linked wallets. `toPriorLaunches` returns these records in the existing
report shape; the panel shows per-source coverage and links to the token records.
No SDK, API key, index server or new host permission is required by this code.
The caller's RPC provider can still restrict, prune or charge for its own service.

```js
import { creatorProfile, toPriorLaunches } from './src/lib/scan/devprofile.js';
import { RpcClient } from './src/lib/rpc.js';

// Use the user's existing configured client; this module does not select a provider.
const rpc = new RpcClient(configuredRpcUrl);
const profile = await creatorProfile(creatorAddress, {
  rpc,
  currentMint,
  launchpadHistory: { pageSize: 50, maxPages: 2 },
});
const prior = toPriorLaunches(profile, creatorAddress);
```

Omit `rpc` to retain the existing pump.fun-only API. Pump pagination, counts,
outcome buckets and 90-second profile cache remain scoped to pump.fun. The cache
key also includes `currentMint`, so two scans cannot reuse the wrong exclusion.
Coin lookups retain their existing 60-second cache.

## Attribution and protocol scope

History reads `getSignaturesForAddress(creator)` and successful `getTransaction`
responses. It recognizes the original initialization instruction's creator account,
not the payer, fee recipient, signer set, token suffix or mutable current pool owner.
LaunchLab permits the designated creator to be a non-signer: attribution is an
on-chain designation, not proof that the wallet owner consented or operated a UI.
Meteora permits creator-rights transfers; those instructions are never new launches.
This method can retain attribution after transfers or pool-account closure if the
provider still serves the original transaction.
Inner instructions additionally require their invocation's successful program log:
a caller can catch a failed CPI and still complete its outer transaction. Missing
or truncated success logs omit those inner records rather than invent attribution.

Supported mainnet programs and initialization variants:

| Family | Program | Initialization variants |
| --- | --- | --- |
| Bonk | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | LaunchLab legacy, V2, Token-2022, exact Bonk platform below |
| Raydium LaunchLab | same LaunchLab program | legacy, V2, Token-2022; other platform IDs retained |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | SPL Token, Token-2022, Token-2022 transfer-hook |

Bonk is identified by `platform_config`, specifically
`8pCtbn9iatQ8493mDQax4xfEUjhoVBpUWYVQoRU18333` from Raydium's pinned official
Bonk example. Raydium's own default platform is
`4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4`. Other LaunchLab platform
addresses remain visible with `platformName: null`; they are not guessed to be
Bonk or Raydium-branded. This is a pinned identity mapping, not a claim that the
example enumerates every historical or future Bonk platform. Unknown/new Bonk
configurations remain generic LaunchLab until an authoritative mapping is added.

“Meteora” here means its Dynamic Bonding Curve token-launch protocol, including
the transfer-hook variant. Generic DAMM/DLMM liquidity-pool creation is not proof
that a wallet originally launched the base token. Migration destinations are not
counted as additional token launches. Legacy successful LaunchLab initializations
remain supported although the current program rejects new legacy calls.

## Coverage and unknowns

- Default work is at most 100 creator-address signatures (two pages of 50), with
  at most four transaction requests in flight. Configurable bounds are 1–100
  signatures per page and 1–10 pages. Only read methods are called.
- Each non-pump source returns `partial` after a successful signature page,
  including an empty page; `unavailable` means no page could be read. Neither
  means there were zero lifetime launches. An RPC may prune history or omit
  unsupported versions. New/unrecognized protocol instructions are not inferred.
- Coverage includes inspected signature/transaction counts, missing/failed
  transactions, page count, endpoint exhaustion and `nextBefore`. A short page
  only exhausts that endpoint's visible window; it never proves lifetime coverage.
  Resume with `fetchLaunchpadHistory(rpc, creator, { before: nextBefore, ... })`
  from `src/lib/scan/launchpads.js`, merging returned records by mint. Pagination
  errors preserve earlier records and include the error in coverage.
- Non-pump history caches successful windows for 90 seconds, separately for each
  actual RPC client, creator, bounds and cursor. Failed/incomplete request windows
  are evicted. Provider switching within one client follows that client's policy.
- Dates are successful transaction `blockTime` in milliseconds, slots are transaction
  slots. Missing values stay `null`; activation points and pool-update times are
  not treated as creation dates. Names/symbols describe initialization, not later edits.
- These reads supply no USD price history or migration observations. ATH, current
  market cap, peak timing, graduation and outcomes remain unknown (`null` / `unknown`).
  A missing market field does not mean a failed launch. No SOL/USDC conversion or
  pump supply/graduation threshold is applied to these tokens.
- Records deduplicate by mint, prefer an existing pump record on overlap, and
  exclude `currentMint` from prior launches. Mixed-profile totals are lower bounds;
  when the pump sample is incomplete the total is conservatively the greater of
  the pump count and the distinct observed union, rather than adding possibly
  overlapping unknown rows. Mixed profiles have no lifetime pace or global archetype.
- `pumpProfile` retains the pump-specific evidence for the existing rating logic.
  Non-pump records with unknown market history do not enter its price-based score,
  targets or dev-sell analysis (which otherwise assumes the current token's supply).
  Source coverage survives report serialization and is shown in the history panel.

## Pinned primary sources

Reviewed as source on 2026-10-23; no SDK scripts or transaction builders executed:

- [Raydium SDK instruction builders](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/raydium/launchpad/instrument.ts): all three discriminators; creator index 1, platform 3, pool 5, base mint 6, quote mint 7; metadata begins after discriminator plus decimals.
- [Raydium program/platform constants](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/common/programId.ts).
- [Official Bonk example](https://github.com/raydium-io/raydium-sdk-V2-demo/blob/003d9045830033e5ef4178d6db129d83f93e1c7f/src/launchpad/createBonkMintApi.ts): exact platform identity, lines 101–102. Only source read; its creation/send operations were not run.
- [Raydium instruction semantics](https://github.com/raydium-io/raydium-docs-v1/blob/36823847c22064f9ba0aa4d931f2a181fbbcd5a5/products/launchlab/instructions.mdx): creator designation is not a required signer; legacy initialization is now deprecated.
- [Meteora published IDL](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/3a965ec0c0a527c2be3c48b8b479366705bf4926/packages/dynamic-bonding-curve/src/idl/dynamic-bonding-curve/idl.json): program ID; three initialization discriminators; creator index 2, base mint 3, quote mint 4, pool 5; `InitializePoolParameters` strings; `transfer_pool_creator` is distinct.
- [Meteora official DBC overview](https://docs.meteora.ag/core-products/dbc/what-is-dbc): token-launch family interpretation, distinct from downstream liquidity pools.

Tests use explicitly synthetic transactions assembled independently from these
schemas. They cover transport through `RpcClient`, profile/prior-launch/report
integration, direct and CPI instructions, raw v0 lookup keys, all six variants,
creator mismatches, transfer instructions, exact platform identity, deduplication,
missing data, pagination failures and cache isolation/expiry. They do not establish
live RPC availability, actual historical coverage or captured mainnet behavior.
