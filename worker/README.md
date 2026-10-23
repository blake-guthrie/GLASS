# Community pre-scan worker

This optional Node 22+ service discovers new pump.fun creations, runs GLASS's existing `runScan`, and publishes a small, versioned snapshot for the extension. It has no npm dependencies, wallet access, signing, write API, built-in remote index, or hosted-service requirement. An operator supplies their own compute, storage and read-only RPC endpoint. Running it can consume that provider's request allowance; this repository does not provision anything.

## Run

Copy `worker/config.example.json` to an operator-owned config file. Set `dataDir` to an absolute persistent directory. On Windows, for example, use `"F:/GLASS/worker-data"`; the example's `/srv/glass-worker/data` is for Linux. Keep one worker process per directory on a local filesystem.

```sh
export GLASS_WORKER_RPC='https://your-read-only-rpc-endpoint'
node worker/main.mjs --config /absolute/path/worker-config.json
```

PowerShell uses `$env:GLASS_WORKER_RPC = 'https://your-read-only-rpc-endpoint'`. Keep actual credentials out of source control, config examples and public logs. The RPC URL is read from the environment and never serialized into index records. The worker disables automatic RPC/archive failover. The unmodified engine also reads its usual public DexScreener, pump.fun and Jito APIs; it never submits transactions.

The default listener is `127.0.0.1:8788`. For remote users, put it behind your own HTTPS reverse proxy, retain the read-only routes, and apply the request limits appropriate to your deployment. No authentication credentials are accepted in the extension's index URL. `--once` performs one bounded tick and exits; normal execution loops without an external scheduler. SIGINT/SIGTERM stops scheduling, waits for the current engine stage/request to return, saves the queue and closes the service. Engine requests retain their existing retry/time limits; shutdown is cooperative, not an immediate cancellation of every network request.

## Discovery, state and capacity

On a new directory the worker records the newest signature as a **start-now boundary**, without claiming to have scanned older history. To start after a known earlier signature, set `worker.startSignature` before first startup. It is exclusive; the transaction at that boundary is not scanned. An initialized directory always resumes its saved cursor, even if this option later changes.

The worker queries `getSignaturesForAddress` on the pump mint-authority PDA, newest first, using `before` pagination until it encounters the saved checkpoint. Pending signatures and the current page cursor are saved before advancing the checkpoint. It then fetches transactions, verifies the requested signature and successful creation instruction, and deduplicates by mint. Successful CPI creation must also have successful ancestor calls; caught failures and ancestor rollback do not enter the queue. RPC-loaded addresses and both legacy and `create_v2` instructions are supported.

The mint is queued immediately. Scanning waits until the later of `scanDelayMs` (default 65 seconds) and the configured early window, measured from block time; absent block time uses discovery time. This avoids presenting an unfinished first-minute sample as complete. One scan runs per tick. New results can appear instantly in the panel **once published**; discovery, maturation, scan latency and backlog still exist.

State is atomic JSON (`state.json`) with pending signatures, in-progress pagination, durable mint jobs, retries and timestamps. Reports are separately atomically replaced under `reports/<mint>.json`. A PID lock rejects a concurrent live process; a dead-process lock is reclaimed at startup. A corrupt/unrecognized state or invalid lock fails closed instead of silently resetting history. A stopped `running` job returns to the queue; an already-published matching snapshot recovers without another scan. This is local single-process storage, not a distributed database or power-loss guarantee for every filesystem.

| Option | Default | Meaning |
|---|---:|---|
| `pageSize` / `pagesPerTick` | 100 / 2 | Feed page size (maximum 1000), pages read per tick (maximum 100) |
| `signaturesPerTick` | 20 | Transactions decoded per tick |
| `maxPending` / `maxJobs` | 2000 / 5000 | Durable signature and mint capacities (maximum 100000 each) |
| `maxAttempts` / `retryMs` | 5 / 5000 | Per-job attempts and exponential retry base, capped at 5 minutes |
| `pollMs` | 3000 | Pause between completed ticks; a scan adds its own duration |
| `retentionMs` | 86400000 | Published-record retention; failed/unsupported jobs are retained |
| `scanDelayMs` | 65000 | Minimum maturity before the engine runs |

When capacity is reached the feed pauses with `backpressure`; it does not discard queued work. Failed transactions/scans retain a public reason code and their durable record. Restart with `--retry-failed` to reset exhausted attempts after fixing the provider/cause. Unsupported quote jobs remain blocked until the corresponding quote-aware engine and `supportsQuote`/snapshot engine version are upgraded, then the same retry command re-evaluates their quote. There is no force-publish switch. Persistent failures can fill capacity; inspect the private state, resolve them or deliberately start a new documented boundary in a different directory. Do not delete queue entries and then claim uninterrupted coverage.

`scan` may override only `slotWindow` (0–20), `earlyWindowSec` (0–300), `maxWalletProfiles` (0–100), `maxPriorLaunches` (0–30), `maxOperatorWallets` (0–50), and boolean `operatorHistory`, `liveTracking`, `jitoLookup`. Defaults are the extension's defaults. The client accepts only matching scan methodology. Unknown keys and out-of-range values fail startup.

## Query and opt-in panel

- `GET /v1/status`: aggregate backlog, failed signatures/scans, unsupported quotes, published records, queued-mint lag, catch-up state, last successful poll and checkpoint-gap count. `lastError` is a reason code, never a provider error/URL.
- `GET /v1/reports/<mint>`: a public snapshot (200), pending/failed/unsupported job state (202), absent record (404), or invalid/unavailable stored record (503). Other methods return 405. There is no upload route.

In the extension popup, enter the operator's HTTPS index base URL (or `http://127.0.0.1:8788/` / localhost for local use), check **Use a community pre-scan index**, then **Save** and grant the host permission. It is off by default. The popup requests RPC/index permissions together directly from the click gesture. A base path is supported when a reverse proxy strips that prefix.

The background uses existing fresh local cache first. For mint-address pages, an opted-in request sends only `GET .../v1/reports/<public mint>` with credentials omitted, no referrer, no redirect, and no settings/body. The index operator can see the queried mint and connection IP. Pair/pool pages still resolve through the normal local engine. Response size is capped at 32 KiB with a two-second deadline. Schema, engine, mint, scan profile, scalar types and freshness (two minutes, up to five seconds clock skew) must match. Missing, stale, incompatible, unavailable or invalid results fall back to the normal local scan. **↻ always forces a local scan.**

The panel labels the configured operator and snapshot time, shows risk, launch composition, creator-history and insider-flow summaries, and explains the trust boundary. These are operator-supplied results, not independently verified or live balances. Raw receipts and browser-local reputation are not uploaded or fabricated: use ↻ for a full local report and its normal live tracking. Shared results never enter the browser's local report cache or operator memory. The public projection selects known fields; it excludes RPC URLs, settings, errors, local memory and raw transactions. Unknown typed fields are discarded on receipt.

## Protocol sources and limits

Discovery is pinned to official [`pump-fun/pump-public-docs` commit 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22](https://github.com/pump-fun/pump-public-docs/tree/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22):

- [`idl/pump.json`](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump.json): program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; `create` discriminator `[24,30,200,40,5,28,7,119]`; `create_v2` `[214,144,76,236,95,139,49,180]`. Mint is account 0, mint-authority account 1, derived from `"mint-authority"` under that program. Legacy/v2 require at least 14/16 accounts respectively.
- [`docs/COIN_CREATION.md`](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/COIN_CREATION.md): v2 optional quote mint is remaining account 16; omitted/WSOL uses native SOL. The zero-key value describes the resulting bonding-curve state, not an assumed quote instruction argument; discovery does not reinterpret an arbitrary supplied quote as SOL. Explicit other quotes are discovered and retained as `unsupported-quote` because this base engine assumes SOL pricing. USDC support is separate work; this worker does not publish known-wrong quote valuations.

There is no claim of production all-mint throughput or complete chain history. A missing checkpoint increments `cursorGaps` and reports possible pruning; it cannot recover bytes an RPC no longer serves. Truncated/missing invocation logs prevent proving CPI creation and therefore exclude it. Feed failures, provider retention, queue capacity, engine sampling and optional source availability constrain coverage. All seven engine stages must finish without stage errors, the launch block window must be available, and the early sample must not be flagged partial before publication. Remaining engine uncertainty/degraded requests stay visible. The engine and schema are pinned; protocol changes require a reviewed update.

## Offline checks

`node --test test/*.test.mjs` includes the original suite plus worker/index tests. The end-to-end case reuses the unchanged repository `test/fixtures/pump-txs.json` captured creation/trade bytes through the **real seven-stage `runScan` with default depth**. Surrounding feed, block envelopes, empty wallet/API histories and balances are explicitly synthetic fixtures. It then persists, serves and consumes the result over real loopback HTTP and reopens storage. A separate CLI case uses real `RpcClient` JSON-RPC transport against a loopback server. No new live chain acquisition, production throughput, public deployment or browser runtime claim follows from these tests.

The other cases cover legacy/v2 and quotes, caught-CPI/ancestor rollback, cursor restart/bursts, dedup/maturity/capacity, retry exhaustion/recovery, cancellation, crash-after-publish, retention/locking, invalid snapshots, anonymous bounded lookup, actual background fallback/force/cache control flow, escaped panel rendering and synchronous popup permissions. Test files use an explicit `GLASS_TEST_TMP` directory or `../test-runtime`; no dependencies are installed.
