# Similar launches

The worker archives behavioral fingerprints from completed SOL-quote GLASS reports and compares a requested mint against earlier retained launches. Wallet rotation does not prevent a match. Exact creator/buyer overlap is reported separately and never enters the resemblance score. Matching is a transparent heuristic, not calibrated identity confidence, probability, a trading prediction, or proof that two launches share an operator.

This builds on the pre-scan worker/index; use the setup in [README.md](README.md). No dependencies, hosted index, bundled corpus, browser uploads or new credentials are required. An operator supplies their own existing RPC, persistent directory and endpoint. The extension uses its existing explicit index opt-in, off by default. Normal scans/cache remain usable without history; ↻ bypasses the index entirely.

## Collection, bootstrap and recovery

After a successful scan, before publishing its snapshot, the worker atomically archives the fingerprint in `history.json`. Short-lived `reports/` retention does not delete history. Only known public behavioral fields, public wallet relations and observed price evidence enter history; raw reports, RPC URLs, settings and local browser memory do not. Incomplete/unsupported-quote scans are never turned into usable history. A report missing valid creation/window information can still publish its normal snapshot, with a durable `historyReason` and aggregate `historyUnavailable` status.

`history` configuration:

| Key | Default | Contract |
|---|---|---|
| `source` | `worker` | Public dataset label, 1–96 ASCII letters, digits, dot, underscore, colon or hyphen; never credentials |
| `maxRecords` | 2000 | 1–5000 source/profile/mint records |
| `retentionDays` | 90 | 1–90 days from launch |
| `queryDays` | 30 | 1–retentionDays, preceding the target launch |

New installations start empty and collect from their documented feed boundary. Existing pre-scan snapshots do not contain enough features to reconstruct history; obtain full reports or deliberately rescan/backfill through the normal engine. Do not manufacture historical fingerprints from snapshots. History uses the same exclusive worker directory lock. Stop the worker before importing. Corrupt/unrecognized history fails startup without resetting evidence; preserve the file and restore a verified operator backup or repair the identified invalid entry offline. An interrupted atomic write leaves the last complete file; a later import/scan can resume. Duplicate imports are idempotent, conflicting launch times or conflicting observations at the same source/kind/time are rejected. Each source/profile/mint keeps the earliest observed fingerprint; later full reports add observations only. The server chooses the earliest observed compatible source per mint, with source labels breaking ties, so duplicate sources cannot inflate counts.

Oldest launches are evicted first, with deterministic key ties. Age/capacity eviction counters, collection start, oldest retained launch, actual stored/eligible/matched counts, deduplication and exclusions accompany queries. At most 5000 records are examined and 20 matches returned, fewer if necessary to keep the JSON response within 32 KiB. Summary denominators cover all qualifying matches, not just displayed rows. This is a bounded sample, not all launches or an assurance of production throughput.

## Feature and comparison contract

`src/lib/scan/similar.js` defines `launch-behavior-v1`, record version 1, and the inherited engine `glass-0.3.2:9649c7c`. Profiles must match the existing scan options exactly. Launch/observation timestamps are Unix **milliseconds**; raw Solana block seconds are converted by the engine. Candidate launch time must fall in `[targetLaunch - queryDays, targetLaunch)`, and the candidate's report observation must be no later than target launch. The current mint, future reports, other profiles and duplicate mints are excluded. Outcomes use only observations with declared measurement time at or before that cutoff. Import time is not substituted for measurement time: historical evidence is an operator assertion, not proof that the service itself possessed it then.

Only the first configured launch-slot window is used, deduplicated by buyer and capped at 100. Coverage is measured against the engine's full observed window-buyer count, so truncation reduces coverage. Creator and buyer wallet addresses are excluded from the score. Four dimensions each contribute 25%:

| Dimension | Features |
|---|---|
| Transaction | Histograms of compute limit, priority fee in micro-lamports/CU, Jito tip in lamports, entry/router program, instruction count and slippage percentage |
| Funding | Histograms of observed funding method and category; missing/truncated wallet histories remain unknown. `linked` and `shared-funder` are categorical engine evidence, not cross-launch wallet identity. |
| Sniper mix | Classified bundle / sniper / organic shares; unclassified or unavailable entries lower coverage |
| Launch-slot shape | First-buy slot distribution, gross-buy token-weighted slot distribution, buyer count scale and gross supply scale |

Numeric transaction buckets are `min(20, floor(2*log10(1+x)))`; slippage ratios from the engine fingerprint are multiplied by 100 first. Missing values remain absent, never numeric zero. Slot indices remain exact. Buyer-count scale is `log2(n+1)/log2(101)`; gross-supply scale is clipped to 0–100%. Each scalar is encoded as low/high weights. Gross amounts describe observed buys, including possible recycling; they are not a net holder estimate. These coarse normalizations preserve behavior and scale while tolerating small fee changes; shared defaults can still look similar.

For each feature group, histogram resemblance is `1 - sum(abs(a-b))/2`. Group weights are their minimum available coverage; dimension coverage is the mean of those weights. All four dimension scores are averaged equally. Acceptance requires overall ≥85/100, each dimension ≥60/100 and ≥60% coverage, and at least three captured buyers and three complete funding profiles on each side. No match is accepted when ≥70% of either captured cohort is known generic infrastructure (snipers, known platform fee users or exchange/high-volume funding). Missing dimensions cannot be hidden by a strong transaction match. The thresholds are conservative design choices, not empirically calibrated accuracy claims.

Ranking is score descending, then launch time descending, then mint in ordinal lexical order. Ties do not imply stronger confidence. The response supplies each component/coverage, rejection reason counts, exact-wallet overlap separately, and per-match source/outcome evidence. A small eligible sample is shown as such; even 100/100 is resemblance only.

## Import actual reports and outcome observations

The service intentionally has no write HTTP endpoint. Use the local command:

```sh
node worker/import-history.mjs --config /absolute/path/worker-config.json --input /absolute/path/history-import.json
```

The input format is:

```json
{
  "schema": 1,
  "engine": "glass-0.3.2:9649c7c",
  "reports": [],
  "updates": []
}
```

Each `reports` entry is `{ "report": <full runScan report>, "settings": <actual scan overrides>, "source": <public dataset label>, "quoteMint": <actual quote mint> }`. Use genuine full JSON reports from the pinned engine, including completed stage statuses, creation time, launch buyers and wallet profiles. `settings: {}` means actual defaults, not unknown settings. The only currently supported quote is WSOL `So11111111111111111111111111111111111111112`. Do not label USDC/other quote reports as SOL; the separate quote-aware engine/schema work is required first. Import validation checks consistency and format, not chain authenticity. Do not supply fabricated or unsupported reports.

An update is `{ "mint": <mint>, "source": <same record source>, "profile": <exact stored profile string>, "observations": [...] }`. Read that profile from the owned history record or compute `scanProfileId(actualSettings)`. Updates cannot create an unknown record. At most 500 report/update entries and 16 MiB per file; at most 32 distinct observations per record. Invalid batches leave the prior archive intact. Retention still applies to imports.

Every observation has `kind`, `at` (actual measurement time in milliseconds), `source` (public provider/dataset label) and `evidence` (public HTTPS receipt/dataset URL, no credentials, query or fragment). The evidence URL is retained, never automatically fetched. These are **validated operator assertions, not independently verified data**. Keep the underlying receipts available and use source labels that identify the same asset/unit/provider basis consistently.

- Price: `{ "kind":"price", "at":..., "source":..., "evidence":..., "priceUsd":... }`. A positive finite USD price **per one token**, not market capitalization, SOL price or a ratio. The baseline is the first same-token observation within five minutes of launch. Later samples must have the same source and fall in the first 24 hours. At least two samples are needed; the highest observed sample divided by that baseline is the observed peak multiple, **not ATH**. The response includes both prices, source, timestamps and sample count. Absolute `athMcapUsd` is never converted into a multiple. The worker automatically captures a real quoted DexScreener market price when available, excluding curve-derived estimates; subsequent genuine full reports or explicit observations can supply later prices.
- Exit window: `kind:"exit-window"`, `basis:"initial-launch-cluster"`, `windowStart: launchAt`, `windowEnd: launchAt + 5400000`, `at >= windowEnd`, `complete`, `cohortWallets`, `initialTokens`, `soldTokens`, and `soldFraction = min(1, soldTokens/initialTokens)`, plus source/evidence. `cohortWallets` must exactly match the archived creator plus bundle-like/unclassified launch buyers (organic/sniper buyers excluded). `initialTokens` is the positive gross initial launch allocation to that cohort; `soldTokens` covers attributable sales from that allocation through minute 90, with transfers traced rather than treated as sales and later repurchases excluded. Both use the same token units. A complete assertion requires all cohort wallets and the entire window to have been checked, including intervening transfers; capped or partial sampling is **not complete**. A truncated initial cohort cannot accept a complete window. Incomplete observations stay unknown; conflicting complete sources about the ≥50% threshold also stay unknown. Existing short engine/live samples are never automatically promoted into a complete 90-minute exit.

Median peak uses only known comparable multiples. The rapid-dump count means ≥50% of the initial cluster allocation sold during a **complete** first-90-minute window; its denominator is known complete windows only. Unknown counts are displayed separately. No complete windows means null/unknown, never 0%. Late measurements cannot leak into a historical target's summary. The illustrative bounty numbers are not constants or fixtures presented as real history.

## Consumer, privacy and validation

`GET /v1/similar/<mint>` sends no settings, browser reports, wallet memory, RPC URLs, API keys or body. The operator already needs its own target report. Responses include the pinned schema/method/profile and fresh generation time; the consumer checks types, cutoff/window, component thresholds, arithmetic, duplicates, units, timestamps and known/unknown denominators. Responses older than two minutes, over 32 KiB, incompatible or unavailable are omitted after a two-second limit. No external index is configured by default. Remote history is displayed separately from local receipts and never cached as local evidence.

Tests use labelled synthetic cases for rotated wallets, conflicting/common/sparse behavior, boundaries, outcomes, dedup/retention and genuine loopback HTTP/CLI integration. Unchanged captured repository transaction bytes also run through the actual seven-stage scanner into history; missing surrounding histories and outcomes remain unknown. Actual background and panel functions are exercised with test fixtures, not a browser runtime. Offline checks establish implementation behavior, not live endpoint correctness, historical data authenticity, calibrated matching quality, a deployed service, or production all-mint capacity.
