// GLASS risk score: 0 (looks organic) → 100 (one operator controls the launch and is dumping).
// Every point comes with a receipt so the panel can show *why*.

export function computeScore({ launch, wallets, live, operator, ctx = {} }) {
  const parts = [];
  const add = (label, pts, max, detail) => parts.push({ label, pts: Math.round(pts), max, detail });

  // 1) Launch-window control (0–35): supply bought in the creation slot / window.
  //    Once wallets are classified, operator-like bundle wallets count fully and sniper bots at 40%.
  const winPct = launch?.window?.pct || 0;
  const slot0Pct = launch?.slot0?.pct || 0;
  const devPct = launch?.creatorDevBuy?.pct || 0;
  let controlled;
  let detail;
  if (launch?.classified) {
    const b = launch.bundle;
    const s = launch.snipers;
    const o = launch.organic;
    controlled = devPct + b.pct + 0.4 * s.pct;
    detail = `${b.pct.toFixed(1)}% in ${b.count} operator-like wallet(s), ${s.pct.toFixed(1)}% in ${s.count} sniper bot(s), ${o.pct.toFixed(1)}% in ${o.count} organic wallet(s); dev buy ${devPct.toFixed(1)}%; ${slot0Pct.toFixed(1)}% in the creation slot`;
  } else {
    controlled = winPct + devPct;
    detail = `${winPct.toFixed(1)}% bought by ${launch?.window?.count || 0} wallets in slots 0–${launch?.window?.slotWindow ?? 3} (+${devPct.toFixed(1)}% dev buy); ${slot0Pct.toFixed(1)}% in the creation slot itself`;
  }
  add('Launch-window supply', Math.min(35, controlled * 1.4), 35, detail);

  // 2) Coordination fingerprints (0–25)
  let coord = 0;
  const u = launch?.fingerprints?.uniformity || 0;
  const n = launch?.window?.count || 0;
  if (n >= 3) coord += 10 * u;
  if (launch?.jito?.confirmedMultiTxBundles) coord += 8;
  else if (launch?.jito?.inferredBundles?.some((b) => b.length >= 2)) coord += 5;
  if (launch?.jito?.identicalTipShare >= 0.6 && launch?.jito?.tippedCount >= 3) coord += 4;
  if ((launch?.sharedFeeRecipients || []).some((f) => !f.platform && f.wallets?.length >= 3)) coord += 3;
  add('Coordinated execution', Math.min(25, coord), 25, launch?.launchToolPattern?.reasons?.join('; ') || 'no uniform-execution signals');

  // 3) Behavioural wallet links (0–20)
  const bl = wallets?.summary?.behaviouralLinkScore || 0;
  add('Wallet links', 20 * bl, 20, wallets?.summary?.reasons?.join('; ') || 'no funding/activity links found');

  // 4) Live insider behaviour (0–20)
  let liveP = 0;
  const s = live?.summary;
  if (s) {
    if (s.coordinatedExits >= 1) liveP += 8;
    if (s.dumpingNow) liveP += 6;
    if (s.handoffCount >= 1) liveP += 3;
    if (s.clusterSoldShare != null && s.clusterSoldShare >= 0.5) liveP += 3;
  }
  add('Insider flow now', Math.min(20, liveP), 20, s ? `cluster holds ${fmtPct(s.clusterHoldsPct)} of supply now (bought ${fmtPct(s.clusterBoughtPct)}), sold ${fmtPct(s.clusterSoldPct)}; ${s.coordinatedExits} coordinated exit(s), ${s.handoffCount} hand-off(s)${s.dumpingNow ? `; ${s.dumpingNow} cluster sells in the last 10 min` : ''}` : 'not tracked');

  let score = Math.round(Math.min(100, parts.reduce((a, p) => a + p.pts, 0)));
  // Operator rating does not change *risk of bundling* but shifts the verdict text.
  const verdict = verdictFor(score, operator, launch, live);
  const call = callFor({ score, launch, wallets, live, operator, ctx });
  return { score, parts, verdict, call };
}

/**
 * The 2-second read: one word, one confidence level, the reasons. Everything else in the panel is the
 * receipt for this line.
 *   avoid       – operator is dumping / a token farm / a serial dumper / heavy control with no history
 *   caution     – bundled or dev-heavy with unknown or mixed history, or snipers own a big share
 *   interesting – clean launch, or a bundle whose operator historically lets launches run
 *   neutral     – nothing alarming, nothing special
 */
export function callFor({ score, launch, wallets, live, operator, ctx = {} }) {
  const why = [];
  const bundlePct = launch?.classified ? launch.bundle.pct : launch?.window?.pct || 0;
  const bundleCount = launch?.classified ? launch.bundle.count : launch?.window?.count || 0;
  const sniperPct = launch?.classified ? launch.snipers.pct : 0;
  const organicPct = launch?.classified ? launch.organic.pct : 0;
  const devPct = launch?.creatorDevBuy?.pct || 0;
  const control = bundlePct + devPct;
  const bundled = bundlePct >= 5 || control >= 10 || (launch?.launchToolPattern?.detected && bundlePct >= 3 && bundleCount >= 2);
  const s = live?.summary;
  const dumping = !!s?.dumpingNow;
  const soldShare = s?.clusterSoldShare ?? null;
  const prof = ctx.profile; // dev profile summary (pump.fun record), may be null
  const farm = prof?.archetype?.kind === 'farm';
  const rated = operator?.rated || 0;
  const opScore = operator?.score ?? null;
  const serialDumper = opScore != null && rated >= 3 && opScore < 35;
  const bullishOp = opScore != null && rated >= 3 && opScore >= 65;

  let level;
  if (farm) {
    level = 'avoid';
    why.push(`token farm: this wallet has launched ${prof.totalCreated.toLocaleString('en-US')}${prof.atLeast ? '+' : ''} tokens${prof.stats?.ranRate != null ? `, ${Math.round((1 - prof.stats.ranRate) * 100)}% never ran` : ''}`);
  } else if (dumping && (soldShare == null || soldShare >= 0.3)) {
    level = 'avoid';
    const devOnly = (s.walletsTracked || 0) <= 1;
    why.push(`${devOnly ? 'the dev is' : 'launch wallets are'} selling right now (${s.dumpingNow} sell${s.dumpingNow === 1 ? '' : 's'} in 10 min${soldShare != null ? `, ${Math.round(soldShare * 100)}% of ${devOnly ? 'the dev bag' : 'their bag'} gone` : ''})`);
  } else if (serialDumper && (prof?.stats?.graduationRate || 0) >= 0.4 && !dumping) {
    // The launch wallets dump instantly, yet many of this dev's tokens graduate later: buying at launch
    // means buying their dump, buying later is a different trade. Say exactly that.
    level = 'caution';
    why.push(`launch wallets sold within ${Math.max(1, Math.round(operator.stats?.medianFirstSellMin ?? 1))} min on their prior launches (history ${opScore}/100)`);
    why.push(`but ${Math.round(prof.stats.graduationRate * 100)}% of this dev's ${prof.totalCreated} tokens graduated later${prof.stats.best?.athMcapUsd ? ` (best ${fmtUsdShort(prof.stats.best.athMcapUsd)})` : ''} — buying at launch is buying their dump; the run, if any, came after`);
  } else if (serialDumper) {
    level = 'avoid';
    why.push(`serial dumper: ${rated} prior launches, history ${opScore}/100${operator.stats?.medianFirstSellMin != null ? `, cluster usually sells within ${Math.max(1, Math.round(operator.stats.medianFirstSellMin))} min` : ''}`);
  } else if (bundled && control >= 30 && opScore == null) {
    level = 'avoid';
    why.push(`${fmtPct(control)} of supply is operator-controlled (${fmtPct(bundlePct)} bundle + ${fmtPct(devPct)} dev) and the operator has no track record`);
  } else if (bundled && bullishOp && !dumping) {
    level = 'interesting';
    why.push(`bundled (${fmtPct(bundlePct)} in ${bundleCount} wallets), but this operator's launches usually run (${opScore}/100 over ${rated})`);
  } else if (bundled || devPct >= 10 || score >= 45) {
    level = 'caution';
    if (bundled && bundleCount > 0 && bundlePct >= 0.5) why.push(`${fmtPct(bundlePct)} of supply in ${bundleCount} linked launch wallet${bundleCount === 1 ? '' : 's'}${devPct >= 3 ? ` + ${fmtPct(devPct)} dev` : ''}`);
    else if (devPct >= 3) why.push(`dev bought ${fmtPct(devPct)} of supply at launch${bundleCount === 0 ? ', no other wallets in the launch window' : ''}`);
    else why.push(`risk score ${score}/100`);
    if (opScore == null) why.push(rated === 0 && prof?.archetype?.kind === 'first' ? "creator's first token — no history" : 'no usable operator history');
    else if (rated < 3) why.push(`only ${rated} prior launch${rated === 1 ? '' : 'es'} to judge by`);
    else why.push(`operator history mixed (${opScore}/100)`);
  } else if (sniperPct >= 20) {
    level = 'caution';
    why.push(`sniper bots hold ${fmtPct(sniperPct)} of supply from the launch window — expect bot selling`);
  } else if (!bundled && organicPct >= 50 && sniperPct < 10 && devPct < 5) {
    level = 'interesting';
    why.push(`clean launch: ${fmtPct(organicPct)} of the launch window went to independent wallets, ${fmtPct(sniperPct)} to bots, dev ${fmtPct(devPct)}`);
  } else {
    level = 'neutral';
    why.push(`no launch-window control found (${fmtPct(bundlePct)} linked, ${fmtPct(sniperPct)} bots, dev ${fmtPct(devPct)})`);
  }
  if (level !== 'avoid' && s?.coordinatedExits >= 1) why.push(`${s.coordinatedExits} coordinated exit${s.coordinatedExits === 1 ? '' : 's'} already`);
  if (level !== 'avoid' && s?.handoffCount >= 1) why.push(`${s.handoffCount} token hand-off${s.handoffCount === 1 ? '' : 's'} to fresh wallets`);

  // Confidence: how much of the picture we actually have
  let conf = 3;
  const gaps = [];
  if (!launch) {
    conf = 0;
    gaps.push('launch window not read');
  }
  if (launch?.partial) {
    conf -= 1;
    gaps.push('early window still loading');
  }
  if (launch && !launch.classified && wallets == null) {
    conf -= 1;
    gaps.push('wallets not profiled yet');
  }
  if (ctx.walletsFailed) {
    conf -= 1;
    gaps.push('wallet profiling failed');
  }
  if (s?.balancesUnavailable) {
    conf -= 1;
    gaps.push('current balances unavailable');
  }
  if ((ctx.degraded || 0) >= 5) {
    conf -= 1;
    gaps.push(`${ctx.degraded} RPC requests failed${ctx.rateLimited ? ' (throttled)' : ''}`);
  }
  if (bundled && !farm && opScore == null && !ctx.profileError && prof == null && !ctx.operatorDone) gaps.push('operator history pending');
  if (bundled && !farm && opScore == null && ctx.operatorDone) {
    conf -= 1;
    gaps.push(ctx.profileError ? 'pump.fun history unreachable' : 'no operator history to judge by');
  } else if (bundled && rated > 0 && rated < 3 && !farm) {
    conf -= 1;
    gaps.push(`only ${rated} prior launch${rated === 1 ? '' : 'es'}`);
  }
  conf = Math.max(0, Math.min(3, conf));
  const confidence = conf >= 3 ? 'high' : conf === 2 ? 'medium' : 'low';
  const word = { avoid: 'Avoid', caution: 'Caution', neutral: 'Neutral', interesting: 'Interesting' }[level];
  return { level, word, confidence, why, gaps };
}

function verdictFor(score, operator, launch, live) {
  const bundlePct = launch?.classified ? launch.bundle.pct : launch?.window?.pct || 0;
  const bundleCount = launch?.classified ? launch.bundle.count : launch?.window?.count || 0;
  const sniperPct = launch?.classified ? launch.snipers.pct : 0;
  const bundled = bundlePct >= 5 || (launch?.creatorDevBuy?.pct || 0) + bundlePct >= 10 || (launch?.launchToolPattern?.detected && bundlePct >= 3 && bundleCount >= 2);
  const op = operator?.label || 'Unrated';
  const dumping = live?.summary?.dumpingNow;
  const serialDumper = operator?.score != null && operator.rated >= 2 && operator.score < 40;
  if (!bundled) {
    if (serialDumper) {
      return {
        tone: 'bearish',
        headline: dumping ? 'Dev is selling now — serial dumper' : `Serial dumper: ${operator.rated} prior launches, median peak ${fmtUsdShort(operator.stats?.medianPeakUsd)}`,
        sub: `Not bundled, but the dev score is ${operator.score}/100${operator.label === 'Token farm' ? ' (token farm)' : ''}: their prior launches were sold within minutes.`,
      };
    }
    if (dumping) return { tone: 'bearish', headline: 'Launch wallets are selling now', sub: `${dumping} sells from launch/dev wallets in the last 10 minutes.` };
    const sub = sniperPct >= 3 ? `Sniper bots took ${fmtPct(sniperPct)} at launch, but no operator-controlled allocation was found.` : 'Early buyers look independent. Normal memecoin risk still applies.';
    return { tone: 'ok', headline: 'No launch-window control detected', sub };
  }
  const devPct = launch?.creatorDevBuy?.pct || 0;
  let headline = bundlePct < 2 && devPct >= 8 ? `Dev bought ${fmtPct(devPct)} at launch, no bundle wallets` : `Bundled: ${fmtPct(bundlePct)} of supply in ${bundleCount} launch wallet${bundleCount === 1 ? '' : 's'}${devPct >= 3 ? ` + ${fmtPct(devPct)} dev` : ''}`;
  let sub;
  let tone = 'warn';
  if (operator?.score == null) sub = 'Operator has no visible history. Treat as unknown.';
  else if (operator.rated < 3) {
    sub = `Only ${operator.rated} prior launch${operator.rated === 1 ? '' : 'es'} could be linked (thin history). Last time: ${operator.stats?.medianFirstSellMin != null ? `they sold within ${Math.max(1, Math.round(operator.stats.medianFirstSellMin))} min` : 'no cluster sell was sampled'}, peak ${fmtUsdShort(operator.stats?.medianPeakUsd)}.`;
    tone = operator.score < 40 ? 'bearish' : operator.score >= 65 ? 'bullish' : 'warn';
  } else if (operator.score >= 65) {
    sub = `Operator history is ${op.toLowerCase()} (${operator.score}/100): prior launches typically ran. Watch the exit zone.`;
    tone = 'bullish';
  } else if (operator.score >= 40) sub = `Operator history is mixed (${operator.score}/100). Some launches ran, some were dumped early.`;
  else if (op === 'Token farm') {
    sub = `Dev score ${operator.score}/100 — token farm: this wallet mass-mints tokens and sells the dev bag into whoever buys${operator.profile?.totalCreated ? ` (${operator.profile.totalCreated.toLocaleString('en-US')} so far)` : ''}.`;
    tone = 'bearish';
  } else {
    sub = `Dev score ${operator.score}/100 (${op.toLowerCase()}): they usually sell early and their launches rarely run.`;
    tone = 'bearish';
  }
  if (live?.summary?.dumpingNow) {
    headline = `${bundlePct < 2 ? 'Dev' : 'Cluster'} is selling now — ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;
    tone = 'bearish';
  }
  return { tone, headline, sub };
}

function fmtUsdShort(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}

export function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v.toFixed(v < 10 ? 1 : 0)}%`;
}
