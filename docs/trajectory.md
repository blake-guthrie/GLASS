# Trajectory comparison

`compareTrajectories(target, library, options)` in `src/lib/scan/trajectory.js` is a
pure comparator for caller-supplied price, traded-volume and unique-buyer curves.
It performs no acquisition, persistence, browser work or prediction. The existing
extension does not yet collect these complete curves or display these comparisons.
Neither the input's provenance nor its outcome labels are independently verified
by this function. The caller supplies genuine historical records for real use.

## Input contract

Each record has:

| Field | Meaning |
| --- | --- |
| `id` | Nonempty, trimmed, stable launch identity, normally the mint. |
| `launchedAt` | Nonnegative safe integer Unix timestamp, **seconds**, at the agreed launch anchor. |
| `quoteUnit` | Exact identifier for compatible quote amounts, e.g. `solana:SOL`. Price is quote units per token and volume is quote units. Callers using converted USD must also agree on the historical conversion method. No implicit conversion occurs. |
| `completeThrough` | Nonnegative elapsed seconds through which the caller asserts **complete event coverage**, including intervals without changes. This is not the last successfully sampled point. |
| `samples` | Strictly increasing `{t, price, volume, buyers}` event samples, starting at `t: 0`. `t` is elapsed seconds and may be fractional. |
| `gaps` | Optional known missing intervals `{from, to}`, in elapsed seconds. Any overlap with the comparison window makes the record ineligible. |
| `source` | Optional caller-provided source/receipt description; returned unchanged as a string, without a verification claim. |
| `outcome` | Optional `{graduated: boolean, observedAt: unixSeconds, source?: string}` observation. Missing, invalid or later-than-cutoff observations remain unknown. |

`price` is positive and finite. `volume` is finite, nonnegative cumulative **gross
traded quote volume**, counting a successful trade once whether buy or sell; it is
not net flow or holdings. `buyers` is a nonnegative safe integer: cumulative distinct
buying wallets since launch, including the creator if they bought. It never decreases
when a buyer sells. Buyer identity is the trader, not the fee payer. Both cumulative
series must be nondecreasing inside the evaluated window. A sample at `t: 0` may
include a launch-time trade; all records must use the same launch anchor and convention.

Samples describe **right-continuous step functions**: a value holds until the next
change. Sparse and irregular event times are supported without a sampling grid or
interpolation. A long unchanged span is valid only when the caller can assert complete
coverage. Periodic snapshots with unknown intervening activity must not be passed as
complete event curves. Known zero activity differs from missing data; null values
are not filled with zeros. Coalesce simultaneous events in their known order before
calling, retaining their final price, gross volume and distinct-buyer count.

Options:

- `asOf` is a required safe integer Unix timestamp in seconds. There is no ambient clock.
- `horizonSeconds` is an integer from 300 to 900, default 300. Every candidate uses
  the **same** half-open window `[0, horizonSeconds)`. The function never silently
  shortens the window to fit a candidate. Both elapsed maturity at `asOf` and declared
  coverage must reach the horizon.
- `limit` is a positive safe integer, default 5.
- `weights` optionally supplies finite positive `price`, `volume`, and `buyers`
  weights. They are normalized to sum to one; defaults are equal thirds. All three
  channels remain active. Values whose relative magnitude underflows a channel to
  zero are rejected.

Only historical launches strictly older than the target are eligible. Self matches
and **all** copies of duplicate library IDs are excluded. Data values at or after the
horizon do not affect scores, normalization or cumulative checks; sample timestamps
are still checked for ordering. Outcomes observed after `asOf` do not enter cohort
counts. These checks cannot detect a caller mislabeling a future observation or
supplying false completeness/source claims.

## Metric and output

The versioned metric is `time-weighted-step-l1-v1`:

1. Divide each price curve by its own initial price. This removes token denomination
   while retaining relative movement shape and amplitude. Volume and buyer counts
   retain their absolute magnitude; they are **not** normalized separately to each
   launch's final value.
2. For each channel, find one shared maximum across both evaluated curves. Divide
   both curves by that maximum. If both volume or buyer curves are entirely zero,
   that channel's distance is zero.
3. Integrate their absolute difference over elapsed time, divided by the horizon.
   The union of the actual change times gives the exact integral for the declared
   step curves. Additional repeated observations do not give a curve extra weight.
4. The overall distance is the weighted mean of the three channel distances.
   `similarity = 100 * (1 - distance)`. Distances lie in `[0,1]`; similarity lies in
   `[0,100]`, subject to normal floating-point precision.

This is a documented descriptive score, **not a probability, confidence interval,
calibrated forecast or recommendation**. Pairwise shared scales make the measure
sensitive to relative differences in activity magnitude, rather than absolute units.
Large outliers can dominate the shared scale; the metric does not promise predictive
quality or corpus representativeness. A score of 100 means equality of the normalized
step curves, not equality of token prices or identities. Candidate outcome labels
never affect distance or ranking.

Results contain ranked `matches` with record IDs/sources, `distance`, `similarity`,
per-channel distances in `components`, and cutoff-aware observed outcomes. Ties use
lexical ID order. `cohorts.eligible` describes all eligible history;
`cohorts.returned` describes only the returned top matches. Each reports counts of
graduated, observed-not-graduated and unknown outcomes, launch-date bounds and the
mean similarity of its observed-graduated members (null if none). An observed false
label means **not graduated at that observation**, not that a token never graduates.
Counts and means describe the supplied cohort only; they are not population rates.

An unusable target returns `status: 'unavailable'` with `targetIssue`. Bad historical
records appear in `excluded` with their input index, ID and reason. An empty or wholly
ineligible library returns `no-comparable-history`, empty matches and zero cohort
counts. Malformed request options or a non-array library throw `TypeError`. Inputs
are never mutated and returned results do not retain mutable input objects.

## Synthetic example

These values demonstrate arithmetic; they are **not real launch history**.

```js
import { compareTrajectories } from './src/lib/scan/trajectory.js';

const target = {
  id: 'example-current', launchedAt: 10000, quoteUnit: 'solana:SOL',
  completeThrough: 300,
  samples: [{ t: 0, price: 1, volume: 0, buyers: 0 }],
};
const historical = {
  id: 'example-past', launchedAt: 1000, quoteUnit: 'solana:SOL',
  completeThrough: 300,
  samples: [
    { t: 0, price: 1, volume: 0, buyers: 0 },
    { t: 150, price: 2, volume: 10, buyers: 2 },
  ],
  outcome: { graduated: true, observedAt: 2000, source: 'synthetic example' },
};
const result = compareTrajectories(target, [historical], { asOf: 10300 });
// Channel distances: price=0.25, volume=0.5, buyers=0.5.
// Equal-weight distance=5/12; similarity=58.333...; one supplied graduated label.
```

`test/trajectory.test.mjs` uses explicitly synthetic mathematical cases for exact
expected scores, temporal paths, coverage, units and outcome handling. Existing real
mainnet scanner fixtures remain unchanged; their short transaction samples are not
presented as complete trajectory records. Run the normal offline suite with `npm test`.
