// Pure comparison of caller-supplied launch curves. No acquisition or predictions.
// Contract, units, coverage and metric: docs/trajectory.md.
const CHANNELS = ['price', 'volume', 'buyers'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const timestamp = (v) => Number.isSafeInteger(v) && v >= 0;
const identity = (v) => typeof v === 'string' && v.length > 0 && v === v.trim();
const issue = (code, detail) => ({ code, detail });

function requestOptions(options) {
  if (!object(options)) throw new TypeError('options must be an object');
  const { asOf, horizonSeconds = 300, limit = 5, weights = { price: 1, volume: 1, buyers: 1 } } = options;
  if (!timestamp(asOf)) throw new TypeError('asOf must be a nonnegative safe integer Unix timestamp in seconds');
  if (!Number.isInteger(horizonSeconds) || horizonSeconds < 300 || horizonSeconds > 900) {
    throw new TypeError('horizonSeconds must be an integer from 300 through 900');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  if (!object(weights) || CHANNELS.some((key) => !finite(weights[key]) || weights[key] <= 0)) {
    throw new TypeError('price, volume and buyers weights must all be finite and positive');
  }
  // Divide before summing so even large finite weights cannot overflow.
  const max = Math.max(...CHANNELS.map((key) => weights[key]));
  const scaled = CHANNELS.map((key) => weights[key] / max);
  const sum = scaled.reduce((a, b) => a + b, 0);
  const normalized = Object.fromEntries(CHANNELS.map((key, i) => [key, scaled[i] / sum]));
  if (CHANNELS.some((key) => normalized[key] === 0)) throw new TypeError('weights must not underflow a channel to zero');
  return { asOf, horizonSeconds, limit, weights: normalized };
}

function prepare(record, { asOf, horizonSeconds }) {
  if (!object(record) || !identity(record.id) || !timestamp(record.launchedAt) || !identity(record.quoteUnit)) {
    return { issue: issue('invalid-record', 'id, launchedAt and quoteUnit are required') };
  }
  if (asOf - record.launchedAt < horizonSeconds) return { issue: issue('immature', 'the requested window has not elapsed at asOf') };
  if (!finite(record.completeThrough) || record.completeThrough < 0) {
    return { issue: issue('invalid-record', 'completeThrough must declare nonnegative elapsed seconds of complete event coverage') };
  }
  if (record.completeThrough < horizonSeconds) return { issue: issue('incomplete-coverage', 'complete event coverage does not reach the horizon') };
  if (record.gaps !== undefined) {
    if (!Array.isArray(record.gaps)) return { issue: issue('invalid-record', 'gaps must be an array of {from,to} elapsed intervals') };
    for (const gap of record.gaps) {
      if (!object(gap) || !finite(gap.from) || !finite(gap.to) || gap.from < 0 || gap.to <= gap.from) {
        return { issue: issue('invalid-record', 'each gap must have finite 0 <= from < to') };
      }
      if (gap.from < horizonSeconds) return { issue: issue('coverage-gap', 'a declared gap intersects the comparison window') };
    }
  }
  if (!Array.isArray(record.samples) || record.samples.length === 0) return { issue: issue('missing-origin', 'an initial sample at t=0 is required') };
  const samples = [];
  let previousTime = -1, previousVolume = 0, previousBuyers = 0, initialPrice;
  for (const sample of record.samples) {
    if (!object(sample) || !finite(sample.t) || sample.t < 0 || sample.t <= previousTime) {
      return { issue: issue('invalid-sample', 'sample times must be finite, nonnegative and strictly increasing') };
    }
    previousTime = sample.t;
    // Future values never influence normalization, scores or cumulative validation.
    // Timestamps remain validated so the input cannot hide unordered observations.
    if (sample.t >= horizonSeconds) continue;
    if (!finite(sample.price) || sample.price <= 0 || !finite(sample.volume) || sample.volume < previousVolume ||
        !Number.isSafeInteger(sample.buyers) || sample.buyers < previousBuyers) {
      return { issue: issue('invalid-sample', 'price must be positive; volume and integer buyers must be nonnegative and cumulative') };
    }
    initialPrice ??= sample.price;
    const price = sample.price / initialPrice;
    if (!finite(price) || price <= 0) return { issue: issue('invalid-sample', 'relative price is outside the finite numeric range') };
    samples.push({ t: sample.t, price, volume: sample.volume, buyers: sample.buyers });
    previousVolume = sample.volume;
    previousBuyers = sample.buyers;
  }
  if (samples[0]?.t !== 0) return { issue: issue('missing-origin', 'an initial sample at t=0 is required') };
  return { record, samples };
}

function distances(left, right, horizon) {
  const scale = Object.fromEntries(CHANNELS.map((key) => [key, 0]));
  for (const sample of [...left, ...right]) {
    for (const key of CHANNELS) scale[key] = Math.max(scale[key], sample[key]);
  }
  const result = { price: 0, volume: 0, buyers: 0 };
  let a = 0, b = 0, t = 0;
  while (t < horizon) {
    const next = Math.min(left[a + 1]?.t ?? horizon, right[b + 1]?.t ?? horizon, horizon);
    const duration = (next - t) / horizon;
    for (const key of CHANNELS) {
      // Shared scaling preserves between-launch volume and buyer magnitude.
      // Dividing each value first avoids overflow in subtracting large amounts.
      if (scale[key] > 0) result[key] += Math.abs(left[a][key] / scale[key] - right[b][key] / scale[key]) * duration;
    }
    t = next;
    if (left[a + 1]?.t === next) a++;
    if (right[b + 1]?.t === next) b++;
  }
  for (const key of CHANNELS) result[key] = Math.max(0, Math.min(1, result[key]));
  return result;
}

function observedOutcome(record, asOf) {
  const outcome = record.outcome;
  if (!object(outcome) || typeof outcome.graduated !== 'boolean') return { kind: 'unknown', reason: 'no-observed-label' };
  if (!timestamp(outcome.observedAt) || outcome.observedAt < record.launchedAt) return { kind: 'unknown', reason: 'invalid-observation-time' };
  if (outcome.observedAt > asOf) return { kind: 'unknown', reason: 'not-observed-at-cutoff' };
  return {
    kind: outcome.graduated ? 'graduated' : 'not-graduated',
    observedAt: outcome.observedAt,
    source: typeof outcome.source === 'string' ? outcome.source : null,
  };
}

function cohort(matches) {
  const result = { count: matches.length, graduated: 0, notGraduated: 0, unknown: 0, graduatedMeanSimilarity: null, oldestLaunch: null, newestLaunch: null };
  let graduatedTotal = 0;
  for (const match of matches) {
    if (match.outcome.kind === 'graduated') { result.graduated++; graduatedTotal += match.similarity; }
    else if (match.outcome.kind === 'not-graduated') result.notGraduated++;
    else result.unknown++;
    result.oldestLaunch = Math.min(result.oldestLaunch ?? match.launchedAt, match.launchedAt);
    result.newestLaunch = Math.max(result.newestLaunch ?? match.launchedAt, match.launchedAt);
  }
  if (result.graduated) result.graduatedMeanSimilarity = graduatedTotal / result.graduated;
  return result;
}

/**
 * Compare all three launch-relative step curves with earlier launches.
 * @param {object} target {id,launchedAt,quoteUnit,completeThrough,samples,gaps?}
 * @param {object[]} library Same records, optionally with {outcome:{graduated,observedAt,source?}}.
 * @param {object} options {asOf,horizonSeconds?:300..900,limit?:5,weights?}
 * @returns {object} Ranked matches, channel distances, observed cohorts and exclusions.
 * Programmer errors in options/library throw TypeError; unusable records are reported.
 * All timestamps are Unix seconds; sample t and coverage are seconds since launch.
 */
export function compareTrajectories(target, library, options = {}) {
  const config = requestOptions(options);
  if (!Array.isArray(library)) throw new TypeError('library must be an array');
  const result = {
    status: 'no-comparable-history', metric: 'time-weighted-step-l1-v1',
    provenance: 'caller-supplied, not independently verified',
    asOf: config.asOf, horizonSeconds: config.horizonSeconds, weights: config.weights,
    librarySize: library.length, matches: [], excluded: [],
    cohorts: { eligible: cohort([]), returned: cohort([]) },
  };
  const current = prepare(target, config);
  if (current.issue) return { ...result, status: 'unavailable', targetIssue: current.issue };
  const counts = new Map();
  for (const item of library) if (identity(item?.id)) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  const ranked = [];
  for (let index = 0; index < library.length; index++) {
    const item = library[index];
    const id = identity(item?.id) ? item.id : null;
    const reject = (reason) => result.excluded.push({ index, id, ...reason });
    if (id === target.id) { reject(issue('self', 'target cannot be its own historical match')); continue; }
    if (counts.get(id) > 1) { reject(issue('duplicate-id', 'all copies of an ambiguous repeated identity are excluded')); continue; }
    const historical = prepare(item, config);
    if (historical.issue) { reject(historical.issue); continue; }
    if (item.launchedAt >= target.launchedAt) { reject(issue('not-past-launch', 'historical launch must predate target launch')); continue; }
    if (item.quoteUnit !== target.quoteUnit) { reject(issue('incompatible-quote', 'quoteUnit must match exactly; no conversion is performed')); continue; }
    const components = distances(current.samples, historical.samples, config.horizonSeconds);
    const distance = Math.max(0, Math.min(1, CHANNELS.reduce((sum, key) => sum + config.weights[key] * components[key], 0)));
    ranked.push({
      id, launchedAt: item.launchedAt, source: typeof item.source === 'string' ? item.source : null,
      distance, similarity: 100 * (1 - distance), components, outcome: observedOutcome(item, config.asOf),
    });
  }
  ranked.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  result.matches = ranked.slice(0, config.limit);
  result.cohorts = { eligible: cohort(ranked), returned: cohort(result.matches) };
  if (ranked.length) result.status = 'ok';
  return result;
}
