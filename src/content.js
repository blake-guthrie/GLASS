// GLASS content script: detects the token on the page, asks the background worker for a scan, and
// renders a progressive panel in a Shadow DOM so terminal CSS can't touch it.
(() => {
  if (globalThis.__glassLoaded) return;
  globalThis.__glassLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const backgroundHelp = globalThis.browser
    ? 'Open about:debugging#/runtime/this-firefox → GLASS → Inspect.'
    : 'Open chrome://extensions → GLASS → Errors / service worker.';

  const Sites = globalThis.GlassSites;
  const STAGE_LABELS = {
    resolve: 'Resolving token',
    creation: 'Finding creation tx',
    launch: 'Reading launch slots',
    wallets: 'Profiling launch wallets',
    live: 'Tracking cluster now',
    operator: 'Dev history',
    score: 'Finalising',
  };
  const STAGE_ORDER = ['resolve', 'creation', 'launch', 'wallets', 'live', 'operator', 'score'];

  // ---------- formatting ----------
  const fmtUsd = (v) => {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
    return `$${v.toFixed(v < 1 ? 6 : 0)}`;
  };
  const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`);
  const fmtSol = (v) => (v == null ? '—' : `${v.toFixed(v < 1 ? 3 : 2)}◎`);
  const fmtMin = (m) => (m == null ? '—' : m < 1 ? `${Math.round(m * 60)}s` : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`);
  const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
  const ago = (ms) => {
    if (!ms) return '—';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
    return `${(s / 86400).toFixed(1)}d ago`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const solscan = (a, kind = 'account') => `https://solscan.io/${kind}/${a}`;
  const link = (a, kind = 'account', text) => `<a href="${solscan(a, kind)}" target="_blank" rel="noopener">${esc(text || short(a))}</a>`;
  let ICON_URL = null;
  try {
    ICON_URL = api.runtime.getURL('icons/icon48.png');
  } catch {
    ICON_URL = null;
  }
  const logoHtml = () => (ICON_URL ? `<img class="logo" src="${ICON_URL}" alt="GLASS" draggable="false" />` : '<div class="logo">G</div>');

  // ---------- styles ----------
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483000; right: 16px; bottom: 16px; width: 372px; max-width: calc(100vw - 24px); max-height: min(84vh, 900px);
  display: flex; flex-direction: column; background: #0b0d12; color: #e6e8ef; border: 1px solid #262b36; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.55); font: 12.5px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif; overflow: hidden; }
.wrap.collapsed { width: auto; max-height: none; border-radius: 999px; }
.wrap.collapsed .body, .wrap.collapsed .foot { display: none; }
.wrap.collapsed .head { border-bottom: 0; padding: 6px 10px 6px 8px; cursor: pointer; }
.head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid #1c2029; cursor: grab; user-select: none; background: linear-gradient(180deg, #121620, #0e1118); }
.head:active { cursor: grabbing; }
.logo { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: #06111a; font-weight: 800; font-size: 12px; flex: none; }
div.logo { background: linear-gradient(135deg, #4cc9f0, #3ecf8e); }
img.logo { object-fit: cover; background: #0b0d12; }
.title { font-weight: 700; letter-spacing: .3px; }
.spacer { flex: 1; }
.score { font-weight: 800; font-size: 13px; padding: 3px 9px; border-radius: 999px; background: #1a1f2b; border: 1px solid #2a3140; min-width: 44px; text-align: center; }
.score.ok { color: #3ecf8e; border-color: #1f6b4a; } .score.warn { color: #f5b544; border-color: #7a5a1d; } .score.bearish { color: #ff5c6c; border-color: #7a2a33; } .score.bullish { color: #4cc9f0; border-color: #1d5e73; }
.btn { background: #161a24; color: #c9cfdb; border: 1px solid #2a3140; border-radius: 7px; padding: 3px 7px; cursor: pointer; font-size: 11px; }
.btn:hover { background: #1e2432; color: #fff; }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 8px 10px 4px; }
.body::-webkit-scrollbar { width: 8px; } .body::-webkit-scrollbar-thumb { background: #262b36; border-radius: 8px; }
.verdict { padding: 9px 10px; border-radius: 10px; margin-bottom: 8px; border: 1px solid #262b36; background: #10141c; }
.verdict h1 { margin: 0 0 3px; font-size: 13.5px; font-weight: 700; }
.verdict p { margin: 0; color: #aab2c2; }
.verdict.ok { border-color: #1f6b4a; background: linear-gradient(180deg, #0f1a16, #10141c); } .verdict.warn { border-color: #7a5a1d; background: linear-gradient(180deg, #1c170f, #10141c); }
.call { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; flex-wrap: wrap; }
.call .w { font-size: 16px; font-weight: 800; letter-spacing: .2px; }
.call .conf { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid #2a3140; color: #aab2c2; background: #161a24; }
.call .conf.high { color: #3ecf8e; border-color: #1f6b4a; } .call .conf.medium { color: #f5b544; border-color: #7a5a1d; } .call .conf.low { color: #8b93a5; }
.call.avoid .w { color: #ff5c6c; } .call.caution .w { color: #f5b544; } .call.neutral .w { color: #c9cfdb; } .call.interesting .w { color: #4cc9f0; }
.why { margin: 2px 0 0; padding-left: 16px; color: #c9cfdb; font-size: 12px; } .why li { margin: 1px 0; }
.gaps { font-size: 10.5px; color: #6c7488; margin-top: 4px; }
.devline { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin: 4px 0 6px; font-size: 12px; }
.devline .big { font-weight: 800; font-size: 14px; }
.feed { margin-top: 6px; border-top: 1px solid #171b25; }
.feed .ev { display: grid; grid-template-columns: 44px 1fr; gap: 6px; padding: 3px 0; border-bottom: 1px solid #171b25; font-size: 11.5px; }
.feed .ev .t { color: #8b93a5; font-variant-numeric: tabular-nums; } .feed .ev.sell { color: #ffb3ba; } .feed .ev.buy { color: #b7f0d6; } .feed .ev.transfer_out, .feed .ev.transfer_in { color: #f5d08a; }
.feed .live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #3ecf8e; margin-right: 5px; animation: pulse 1.2s infinite; }
.rep { font-size: 11px; color: #f5d08a; margin-top: 4px; }
.verdict.bearish { border-color: #7a2a33; background: linear-gradient(180deg, #1f1114, #10141c); } .verdict.bullish { border-color: #1d5e73; background: linear-gradient(180deg, #0e1a21, #10141c); }
.sec { border: 1px solid #1c2029; border-radius: 10px; margin-bottom: 8px; background: #0e1118; }
.sec > .sh { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; font-weight: 700; color: #d7dce6; }
.sec > .sh .sub { font-weight: 500; color: #8b93a5; font-size: 11.5px; }
.sec > .sh .chev { margin-left: auto; color: #6c7488; transition: transform .15s; }
.sec.open > .sh .chev { transform: rotate(90deg); }
.sec > .sc { display: none; padding: 2px 10px 9px; border-top: 1px solid #1c2029; }
.sec.open > .sc { display: block; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; padding: 3px 0; }
.kv .k { color: #8b93a5; } .kv .v { text-align: right; font-variant-numeric: tabular-nums; }
.bar { height: 7px; background: #171b25; border-radius: 6px; overflow: hidden; display: flex; margin: 6px 0 4px; }
.bar i { display: block; height: 100%; }
.leg { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: #aab2c2; margin-bottom: 4px; }
.leg b { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
.c-dev { background: #c084fc; } .c-bundle { background: #ff5c6c; } .c-sniper { background: #f5b544; } .c-organic { background: #3ecf8e; } .c-rest { background: #2a3140; } .c-un { background: #8b93a5; }
ul.rs { margin: 4px 0 0; padding-left: 16px; color: #c9cfdb; } ul.rs li { margin: 2px 0; }
.muted { color: #8b93a5; } .good { color: #3ecf8e; } .bad { color: #ff5c6c; } .amber { color: #f5b544; } .cyan { color: #4cc9f0; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 4px; table-layout: auto; }
th, td { text-align: left; padding: 3px 4px; border-bottom: 1px solid #171b25; white-space: nowrap; }
.tscroll { overflow-x: auto; overscroll-behavior-x: contain; margin: 0 -10px; padding: 0 10px; }
.tscroll::-webkit-scrollbar { height: 6px; } .tscroll::-webkit-scrollbar-thumb { background: #262b36; border-radius: 6px; }
.op-table th, .op-table td { padding: 3px 3px; font-size: 11px; }
.op-table td.sold { white-space: normal; max-width: 70px; line-height: 1.2; }
tr.how td { white-space: normal !important; }
th { color: #8b93a5; font-weight: 600; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
a { color: #8ec5ff; text-decoration: none; } a:hover { text-decoration: underline; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; border: 1px solid #2a3140; background: #161a24; margin-left: 4px; }
.pill.bull { color: #4cc9f0; border-color: #1d5e73; } .pill.bear { color: #ff5c6c; border-color: #7a2a33; } .pill.mix { color: #f5b544; border-color: #7a5a1d; } .pill.na { color: #8b93a5; }
.pill.sniper { color: #f5b544; } .pill.bundle { color: #ff5c6c; } .pill.organic { color: #3ecf8e; } .pill.unclassified { color: #8b93a5; }
.stages { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 8px; }
.stg { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid #262b36; color: #8b93a5; }
.stg.done { color: #3ecf8e; border-color: #1f6b4a; } .stg.running { color: #4cc9f0; border-color: #1d5e73; animation: pulse 1.2s infinite; } .stg.error { color: #ff5c6c; border-color: #7a2a33; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
.targets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 6px; }
.tgt { background: #121620; border: 1px solid #262b36; border-radius: 8px; padding: 6px 8px; }
.tgt .l { font-size: 10.5px; color: #8b93a5; } .tgt .m { font-weight: 800; font-size: 13px; } .tgt .x { font-size: 10.5px; color: #aab2c2; }
.tgt.hit { border-color: #1f6b4a; } .tgt.dump { border-color: #7a2a33; grid-column: 1 / -1; display: flex; gap: 10px; align-items: baseline; }
.warnbox { margin: 6px 0; padding: 7px 9px; border-radius: 8px; border: 1px solid #7a5a1d; background: #1c170f; color: #f5d08a; font-size: 11.5px; line-height: 1.4; }
.warnbox.cyan-box { border-color: #1d5e73; background: #0e1a21; color: #9ad9f0; }
.targets.single { grid-template-columns: 1fr; }
tr.how td { border-bottom: 1px solid #171b25; }
.foot { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-top: 1px solid #1c2029; font-size: 10.5px; color: #6c7488; }
.foot .spacer { flex: 1; }
.err { color: #ff8a94; padding: 6px 8px; border: 1px solid #7a2a33; border-radius: 8px; background: #1f1114; margin-bottom: 8px; }
.note { font-size: 11px; color: #8b93a5; margin-top: 6px; }
.skl { height: 10px; border-radius: 5px; background: linear-gradient(90deg, #141821, #1b2130, #141821); background-size: 200% 100%; animation: sh 1.2s infinite; margin: 6px 0; }
@keyframes sh { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
`;

  // ---------- panel ----------
  class Panel {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = 'glass-panel-host';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      this.shadow.appendChild(style);
      this.root = document.createElement('div');
      this.root.className = 'wrap';
      this.shadow.appendChild(this.root);
      document.documentElement.appendChild(this.host);
      this.open = { launch: true, operator: true, live: true, wallets: false, coord: false, receipts: false, score: false };
      this.collapsed = false;
      this.report = null;
      this.identifier = null;
      this.ticks = null;
      this.drag = null;
      // Pointer events + pointer capture on the header: the drag keeps following the cursor even when it
      // crosses the terminal's chart (which otherwise captures the pointer and swallows mousemove).
      this.onPointerMove = (e) => {
        if (!this.drag) return;
        this.drag.moved = true;
        this.setPos({ x: e.clientX - this.drag.dx, y: e.clientY - this.drag.dy });
      };
      this.onPointerUp = (e) => {
        if (this.drag?.moved) {
          const rect = this.root.getBoundingClientRect();
          api.storage?.local?.set({ glassPanelPos: { x: rect.left, y: rect.top } }).catch?.(() => {});
        }
        try {
          this.drag?.target?.releasePointerCapture?.(e.pointerId);
        } catch {
          /* already released */
        }
        this.lastDragMoved = !!this.drag?.moved;
        this.drag = null;
        setTimeout(() => (this.lastDragMoved = false), 0);
      };
      window.addEventListener('resize', () => {
        if (this.root.style.left) {
          const rect = this.root.getBoundingClientRect();
          this.setPos({ x: rect.left, y: rect.top });
        }
      });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.collapsed && !e.defaultPrevented && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') this.setCollapsed(true);
      });
      this.restorePosition();
      this.render();
    }
    async restorePosition() {
      try {
        const r = await api.storage.local.get(['glassPanelPos', 'glassPanelCollapsed']);
        if (r.glassPanelPos) this.setPos(r.glassPanelPos);
        if (r.glassPanelCollapsed) {
          this.collapsed = true;
          this.render();
        }
      } catch {
        /* storage unavailable */
      }
    }
    setPos(p) {
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
      this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, p.x))}px`;
      this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, p.y))}px`;
    }
    setReport(report, identifier) {
      this.report = report;
      this.identifier = identifier;
      if (report) this.error = null;
      this.render();
    }
    setError(message) {
      this.error = message;
      this.render();
    }
    clearError() {
      if (!this.error) return;
      this.error = null;
      this.render();
    }
    toggle(sec) {
      this.open[sec] = !this.open[sec];
      this.render();
    }
    render() {
      const prevBody = this.root.querySelector('.body');
      const scrollTop = prevBody ? prevBody.scrollTop : 0;
      const r = this.report;
      const tone = r?.score?.verdict?.tone || 'na';
      const scoreTxt = r?.score ? String(r.score.score) : '…';
      const headerTitle = r?.market?.symbol || r?.creation?.symbol ? `$${esc(r.market?.symbol || r.creation?.symbol)}` : 'GLASS';
      this.root.className = `wrap${this.collapsed ? ' collapsed' : ''}`;
      this.root.innerHTML = `
        <div class="head" part="head">
          ${logoHtml()}
          <div class="title">${this.collapsed ? headerTitle : 'GLASS'}</div>
          ${this.collapsed ? `<span class="muted">${r?.score?.call ? `<b class="${r.score.call.level === 'avoid' ? 'bad' : r.score.call.level === 'caution' ? 'amber' : r.score.call.level === 'interesting' ? 'cyan' : ''}">${esc(r.score.call.word)}</b> · ` : ''}${esc(r?.score?.verdict?.headline || STAGE_LABELS[r?.stage] || 'scanning…')}</span>` : ''}
          <div class="spacer"></div>
          <div class="score ${tone}" title="GLASS risk score (0 organic → 100 operator-controlled)">${scoreTxt}</div>
          ${this.collapsed ? '' : `<button class="btn" data-act="rescan" title="Re-scan now">↻</button><button class="btn" data-act="copy" title="Copy text report">⧉</button><button class="btn" data-act="collapse" title="Collapse">—</button>`}
        </div>
        <div class="body">${this.collapsed ? '' : this.renderBody()}</div>
        <div class="foot">
          <span title="${esc(r?.rpc?.url || '')}${r?.rpc?.switched ? ` (fell back from ${esc(r.rpc.switched.from)}: ${esc(r.rpc.switched.reason)})` : ''}">${r?.rpcCalls ? `${r.rpcCalls} RPC` : ''}${r?.rpc?.profile ? ` · ${esc(r.rpc.profile)}${r.rpc.switched ? ' <span class="amber">(fallback)</span>' : ''}` : ''}${r?.degraded ? ` · <span class="amber" title="${esc(r.rpc?.failSummary || '')}${r.rpc?.rateLimited ? '. The free RPC throttled this scan — a free Helius key in GLASS settings removes this.' : ''}">${r.degraded} failed → partial${r.rpc?.rateLimited ? ' (rate-limited)' : ''}</span>` : ''}${r?.totalMs ? ` · ${(r.totalMs / 1000).toFixed(0)}s` : ''}</span>
          <span class="spacer"></span>
          <span>${r?.mint ? link(r.mint, 'token', short(r.mint)) : ''}</span>
          <span title="Historical pattern recognition. Not financial advice.">ⓘ not advice</span>
        </div>`;
      this.bind();
      const body = this.root.querySelector('.body');
      if (body && scrollTop) body.scrollTop = scrollTop;
    }
    renderBody() {
      const r = this.report;
      if (this.error && !r) return `<div class="err">${esc(this.error)}</div>`;
      const errBanner = this.error && r && !r.finishedAt ? `<div class="err">${esc(this.error)}</div>` : '';
      if (!r) return `<div class="stages">${STAGE_ORDER.map((s) => `<span class="stg">${STAGE_LABELS[s]}</span>`).join('')}</div><div class="skl"></div><div class="skl" style="width:70%"></div>`;
      const parts = [];
      if (errBanner) parts.push(errBanner);
      // stages strip
      parts.push(`<div class="stages">${STAGE_ORDER.map((s) => `<span class="stg ${r.stages?.[s]?.status || ''}">${STAGE_LABELS[s]}</span>`).join('')}</div>`);
      for (const e of r.errors || []) parts.push(`<div class="err">${e.stage === 'resolve' || e.stage === 'creation' ? '' : `${esc(STAGE_LABELS[e.stage] || e.stage)} skipped: `}${esc(e.message)}</div>`);
      if (r.score?.verdict) {
        const v = r.score.verdict;
        const c = r.score.call;
        const callHtml = c
          ? `<div class="call ${c.level}"><span class="w">${esc(c.word)}</span><span class="conf ${c.confidence}" title="${esc(c.gaps?.length ? `Missing: ${c.gaps.join('; ')}` : 'All stages completed with full data')}">${esc(c.confidence)} confidence</span>${r.finishedAt ? '' : '<span class="muted">· still scanning</span>'}</div>`
          : '';
        const why = c?.why?.length ? `<ul class="why">${c.why.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
        const gaps = c?.gaps?.length ? `<div class="gaps">Not yet known: ${esc(c.gaps.join(' · '))}</div>` : '';
        parts.push(`<div class="verdict ${v.tone}">${callHtml}<h1>${esc(v.headline)}</h1><p>${esc(v.sub)}</p>${why}${gaps}</div>`);
      }
      if (r.finishedAt && r.degraded >= 10 && r.rpc?.rateLimited) parts.push(`<div class="warnbox">The free RPC throttled this scan (${r.degraded} requests dropped), so some wallets or prior launches may be missing. A free Helius API key in GLASS settings fixes this.</div>`);
      parts.push(this.secMarket(r));
      if (r.launch) parts.push(this.secLaunch(r));
      if (r.operator || r.stages?.operator?.status === 'running') parts.push(this.secOperator(r));
      if (r.live || r.stages?.live?.status === 'running') parts.push(this.secLive(r));
      if (r.launch) parts.push(this.secCoord(r));
      if (r.wallets || r.stages?.wallets?.status === 'running') parts.push(this.secWallets(r));
      if (r.launch) parts.push(this.secReceipts(r));
      if (r.score) parts.push(this.secScore(r));
      return parts.join('');
    }
    sec(id, title, sub, inner) {
      return `<div class="sec ${this.open[id] ? 'open' : ''}" data-sec="${id}"><div class="sh" data-toggle="${id}"><span>${title}</span><span class="sub">${sub || ''}</span><span class="chev">›</span></div><div class="sc">${inner}</div></div>`;
    }
    secMarket(r) {
      const m = r.market || {};
      const c = r.creation;
      return `<div class="kv">
        <span class="k">${esc(m.name || c?.tokenName || 'Token')}${m.symbol || c?.symbol ? ` · $${esc(m.symbol || c?.symbol)}` : ''}</span><span class="v" title="${esc(m.mcapSource || 'DexScreener')}">${fmtUsd(m.marketCapUsd)} mcap${m.mcapSource ? '*' : ''}</span>
        <span class="k">Created</span><span class="v">${c ? `${ago(c.createdAt)} · slot ${c.slot}` : r.stages?.creation?.status === 'running' ? 'finding…' : '—'}</span>
        <span class="k">Creator</span><span class="v">${c ? link(c.creator) : '—'}</span>
        <span class="k">Venue</span><span class="v">${esc(m.dexId || '—')}${m.liquidityUsd ? ` · liq ${fmtUsd(m.liquidityUsd)}` : ''}</span>
        ${m.athMcapUsd ? `<span class="k" title="Highest market cap this token has reached (pump.fun record)">Peak so far</span><span class="v">${fmtUsd(m.athMcapUsd)}${m.marketCapUsd && m.athMcapUsd > m.marketCapUsd * 1.5 ? ` <span class="muted">· now ${Math.round((m.marketCapUsd / m.athMcapUsd) * 100)}% of peak</span>` : ''}</span>` : ''}
      </div>`;
    }
    secLaunch(r) {
      const L = r.launch;
      const dev = L.creatorDevBuy?.pct || 0;
      const cls = L.classified;
      const bundle = cls ? L.bundle.pct : L.window.pct;
      const sniper = cls ? L.snipers.pct : 0;
      const organic = cls ? L.organic.pct : 0;
      const rest = Math.max(0, 100 - dev - bundle - sniper - organic);
      const bar = `<div class="bar">
          <i class="c-dev" style="width:${dev}%" title="dev buy ${fmtPct(dev)}"></i>
          <i class="${cls ? 'c-bundle' : 'c-un'}" style="width:${bundle}%" title="${cls ? 'operator-like' : 'launch-window'} ${fmtPct(bundle)}"></i>
          <i class="c-sniper" style="width:${sniper}%" title="snipers ${fmtPct(sniper)}"></i>
          <i class="c-organic" style="width:${organic}%" title="organic ${fmtPct(organic)}"></i>
          <i class="c-rest" style="width:${rest}%"></i></div>
        <div class="leg"><span><b class="c-dev"></b>dev ${fmtPct(dev)}</span>
          <span><b class="${cls ? 'c-bundle' : 'c-un'}"></b>${cls ? `bundle ${fmtPct(bundle)} (${L.bundle.count})` : `launch window ${fmtPct(bundle)} (${L.window.count})`}</span>
          ${cls ? `<span><b class="c-sniper"></b>snipers ${fmtPct(sniper)} (${L.snipers.count})</span><span><b class="c-organic"></b>organic ${fmtPct(organic)} (${L.organic.count})</span>` : ''}</div>`;
      const kv = `<div class="kv">
        <span class="k" title="Wallets (other than the dev) that bought in the very same block the token was created — only possible if the buy was prepared before the token existed">Creation slot</span><span class="v">${L.slot0.count} wallets · ${fmtPct(L.slot0.pct)} of supply · ${fmtSol(L.slot0.sol)} spent</span>
        <span class="k" title="Buyers in the creation slot plus the next ${L.window.slotWindow} slots (~${(((L.window.slotWindow + 1) * (r.slotMs || 400)) / 1000).toFixed(1)} s). This is the 'launch window' everything else is based on">Slots 0–${L.window.slotWindow}</span><span class="v">${L.window.count} wallets · ${fmtPct(L.window.pct)} of supply · ${fmtSol(L.window.sol)} spent</span>
        <span class="k" title="Everyone who bought in the first ${L.early.seconds} seconds (context, not counted as bundle)">First ${L.early.seconds}s</span><span class="v">${L.early.count} wallets · ${fmtPct(L.early.pct)} of supply${L.partialEarly ? ' <span class="amber">(partial)</span>' : ''}${L.partial ? ' <span class="cyan">(loading…)</span>' : ''}</span>
        <span class="k" title="What the creator wallet bought in the create transaction">Dev buy</span><span class="v">${fmtPct(dev)} of supply · ${fmtSol(L.creatorDevBuy.sol)} spent</span>
      </div>`;
      const sub = cls ? `${fmtPct(bundle)} bundle · ${fmtPct(sniper)} snipers` : `${fmtPct(L.window.pct)} in ${L.window.count} wallets`;
      return this.sec('launch', 'Launch window', sub, bar + kv);
    }
    secCoord(r) {
      const L = r.launch;
      const fp = L.fingerprints;
      const j = L.jito;
      const rows = [];
      const n = L.window.count;
      const dom = fp.dominant;
      const explainFp = (key) => {
        const [cu, price, tip, route, ix, slip] = String(key).split('|');
        const parts = [];
        if (cu !== 'na') parts.push(`compute budget ${Number(cu).toLocaleString()} CU`);
        if (price !== 'na') parts.push(`priority fee ${Number(price).toLocaleString()} µ-lamports/CU`);
        if (tip && tip !== '0') parts.push(`Jito tip ${(Number(tip) / 1e9).toFixed(4)} SOL`);
        if (ix && ix !== 'na') parts.push(`${ix} instructions`);
        if (slip !== 'na') parts.push(`slippage ${Math.round(Number(slip) * 100)}%`);
        return parts;
      };
      rows.push(`<span class="k" title="A transaction fingerprint = the settings a wallet's software chose when it built the buy: compute budget, priority fee, Jito tip, which program it routed through, how many instructions, slippage. Humans clicking different terminals produce different combinations; one script producing many wallets' buys produces one identical combination.">Same fingerprint</span><span class="v">${dom ? `${dom.wallets.length} of ${n} launch buyers` : '—'}</span>`);
      if (dom) {
        const parts = explainFp(dom.key);
        rows.push(`<span class="k">That fingerprint</span><span class="v" style="white-space:normal;text-align:left">${esc(dom.label.split(' · ').find((x) => !/^CU|^prio|^slip|^tip/.test(x)) || 'route')}${parts.length ? `<br><span class="muted">${esc(parts.join(' · '))}</span>` : ''}<br><span class="muted">wallets: ${dom.wallets.slice(0, 6).map((w) => link(w)).join(', ')}${dom.wallets.length > 6 ? ` +${dom.wallets.length - 6}` : ''}</span></span>`);
      }
      rows.push(`<span class="k" title="Jito tips are paid to land a transaction in a bundle (a group of transactions executed together, in order). Identical tips across wallets = one sender.">Jito tipped</span><span class="v">${j.tippedCount}/${n}${j.tippedCount ? ` · identical tip ${Math.round(j.identicalTipShare * 100)}%` : ''}</span>`);
      rows.push(`<span class="k" title="A Jito bundle is a group of transactions submitted together. Several launch buys in ONE bundle = one operator sent them">Jito bundles</span><span class="v">${j.confirmedMultiTxBundles != null ? (j.confirmedMultiTxBundles ? `<span class="bad">${j.confirmedMultiTxBundles} with multiple launch buys</span>` : 'none shared between buyers') : `${j.inferredBundles.length} inferred`}${j.bundleIds?.length ? ` <span class="muted">(${j.bundleIds.length} tipped tx${j.bundleIds.length === 1 ? '' : 's'} checked)</span>` : ''}</span>`);
      for (const x of L.sharedFeeRecipients || []) {
        const who = x.platform ? `<span class="muted">bot/terminal fee account — ${x.payersSeen ?? '?'} different traders paid it in its last ${x.mintsSeen ? `${x.mintsSeen}-token` : 'few'} stretch${x.perMinute ? `, ~${x.perMinute}/min` : ''}. Means "these wallets used the same popular bot", not "same operator".</span>` : x.payersSeen != null ? `<span class="bad">private fee wallet — only ${x.payersSeen} payer(s) across ${x.mintsSeen} token(s) recently: a launch tool's or the operator's own fee account</span>` : '<span class="muted">unclassified</span>';
        rows.push(`<span class="k" title="pump.fun's protocol fee is paid inside the program. A separate SOL transfer from the buyer to some other wallet in the same transaction is a fee the buyer's software added — a trading bot, a terminal, or a launch tool.">Extra fee wallet</span><span class="v" style="white-space:normal;text-align:left">${link(x.address)} · paid by ${x.wallets.length} of the launch buyers (${x.wallets.slice(0, 4).map((w) => link(w)).join(', ')}${x.wallets.length > 4 ? ` +${x.wallets.length - 4}` : ''})<br>${who}</span>`);
      }
      if (L.sharedPayers?.length) rows.push(`<span class="k" title="The wallet that signed as fee payer for another wallet's buy. One wallet paying for several buyers' transactions = one operator.">Shared fee payer</span><span class="v">${L.sharedPayers.map((x) => `${link(x.address)} paid for ${x.wallets.length}`).join(', ')}</span>`);
      const reasons = L.launchToolPattern.reasons.length ? `<ul class="rs">${L.launchToolPattern.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="note">No uniform-execution signals.</div>';
      const fpRep = r.reputation?.fingerprint;
      const rep = fpRep?.seen ? `<div class="rep">This exact fingerprint appeared on ${fpRep.seen} launch${fpRep.seen === 1 ? '' : 'es'} you scanned before${fpRep.avoid ? ` — ${fpRep.avoid} rated Avoid` : ''}.</div>` : '';
      const sub = L.launchToolPattern.detected ? '<span class="bad">launch-tool pattern</span>' : dom && n ? `${dom.wallets.length}/${n} same fingerprint` : '—';
      return this.sec('coord', 'Coordination', sub, `<div class="kv">${rows.join('')}</div>${reasons}${rep}`);
    }
    secWallets(r) {
      const w = r.wallets;
      if (!w) return this.sec('wallets', 'Launch wallets', 'profiling…', '<div class="skl"></div><div class="skl" style="width:60%"></div>');
      const s = w.summary || {};
      if (!s.walletsProfiled) return this.sec('wallets', 'Launch wallets', 'none in the launch window', `<div class="note">No wallet besides the dev bought in the first ${(r.launch?.window?.slotWindow ?? 3) + 1} slots, so there is no launch-window cluster to profile. Early buyers after that are listed under Receipts.</div>`);
      const kinds = s.kinds || {};
      const fk = s.fundingKinds || {};
      const fundingTxt = Object.entries(fk).map(([k, v]) => `${v} ${k === 'unknown' ? 'unknown' : k === 'linked' ? 'by another launch wallet' : k === 'shared-funder' ? 'by a shared funder' : k === 'high-volume' ? 'from a high-volume source' : k === 'exchange' ? 'from an exchange' : k}`).join(' · ') || '—';
      const rows = [
        `<span class="k" title="bundle = looks operator-controlled (fresh / linked / warmed-up / creation-block with identical settings) · sniper = high-volume bot that buys every launch · organic = older wallet with a normal history and no links">Profiled</span><span class="v">${s.walletsProfiled} · <span class="bad">${kinds.bundle || 0} bundle</span> · <span class="amber">${kinds.sniper || 0} sniper</span> · <span class="good">${kinds.organic || 0} organic</span></span>`,
        `<span class="k" title="Where each wallet's first SOL came from: a plain transfer, a WSOL account closed into it (hides the transfer), or a third party paying its fees. 'unknown' = the wallet's first transactions are older than the RPCs GLASS can reach, or it was funded through a swap.">Funding</span><span class="v" style="white-space:normal;text-align:left">${esc(fundingTxt)}</span>`,
        `<span class="k" title="Only filled in when a funding source is a known exchange hot wallet (Binance, Coinbase, Crypto.com…). Different from Funding: that is *how* the SOL arrived, this is *who* it came from.">Exchanges</span><span class="v">${s.exchangesUsed?.length ? esc(s.exchangesUsed.join(', ')) : 'none recognised'}</span>`,
        `<span class="k" title="Median wallet age at launch (first transaction → launch)">Median age</span><span class="v">${s.medianAgeHours == null ? '—' : fmtMin(s.medianAgeHours * 60)} before launch</span>`,
        `<span class="k" title="Wallets whose pre-launch activity looks scripted (same program over and over, dust-sized moves, regular gaps)">Warm-up activity</span><span class="v">${s.generatedActivityWallets || 0} wallets · fresh ${s.freshWallets || 0}</span>`,
      ];
      const reasons = s.reasons?.length ? `<ul class="rs">${s.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="note">No funding or activity links between launch wallets.</div>';
      // per-wallet detail
      const kindOf = new Map((r.launch?.buyers || []).map((b) => [b.wallet, b]));
      const list = (w.profiles || []).slice(0, 14).map((p) => {
        const b = kindOf.get(p.wallet);
        const kind = b?.kind || p.kind;
        const fund = p.fundingSource ? `${esc(p.fundingMethod === 'wsol-close' ? 'WSOL-close from' : p.fundingMethod === 'payer' ? 'fees paid by' : p.fundingMethod === 'token-transfer' ? 'tokens from' : 'transfer from')} ${link(p.fundingSource)}${p.fundingLabel ? ` <span class="muted">(${esc(p.fundingLabel)})</span>` : ''}${p.fundedSol ? ` ${fmtSol(p.fundedSol)}` : ''}${p.fundedAt ? ` <span class="muted">${ago(p.fundedAt)}</span>` : ''}` : `<span class="muted">${esc(p.fundingNote || 'funding unknown')}</span>`;
        const age = p.ageHoursAtLaunch != null ? fmtMin(p.ageHoursAtLaunch * 60) : p.historyTruncated ? '>' + (r.rpc?.historyHours || 14) + 'h' : '—';
        return `<tr><td>${link(p.wallet)}<span class="pill ${esc(kind)}" title="${esc(b?.kindReason || '')}">${esc(kind)}</span></td><td class="num" title="wallet age at launch">${age}</td><td class="num" title="transactions before launch">${p.preLaunchTxs}${p.txCountCapped ? '+' : ''}</td><td style="white-space:normal">${fund}</td></tr>`;
      });
      const table = list.length ? `<div class="tscroll"><table><tr><th>wallet</th><th class="num">age</th><th class="num">txs</th><th>funded by</th></tr>${list.join('')}</table></div>${(w.profiles || []).length > 14 ? `<div class="note">${w.profiles.length - 14} more in Receipts.</div>` : ''}` : '';
      return this.sec('wallets', 'Launch wallets', `${kinds.bundle || 0} bundle · ${kinds.sniper || 0} sniper`, `<div class="kv">${rows.join('')}</div>${reasons}${table}`);
    }
    secLive(r) {
      const l = r.live;
      if (!l) return this.sec('live', 'Insider flow', 'tracking…', '<div class="skl"></div>');
      const s = l.summary;
      const ls = this.liveState;
      const supply = r.supply || 1e9;
      // live holdings override the scan's snapshot
      const nowOf = (h) => (ls?.balances?.has(h.wallet) ? ls.balances.get(h.wallet) : h.now);
      const holdings = (l.holdings || []).map((h) => ({ ...h, now: nowOf(h) }));
      const totalBought = holdings.reduce((a, h) => a + (h.bought || 0), 0);
      const totalNow = holdings.reduce((a, h) => a + (h.now || 0), 0);
      const holdsPct = s.balancesUnavailable && !ls?.balances?.size ? s.clusterHoldsPct : (totalNow / supply) * 100;
      const soldShare = totalBought ? Math.max(0, Math.min(1, 1 - totalNow / totalBought)) : null;
      const rows = [
        `<span class="k" title="The cluster = the dev wallet plus every launch wallet GLASS classified as operator-controlled (bundle). Snipers and organic buyers are tracked separately.">Cluster bought → holds</span><span class="v">${fmtPct(s.clusterBoughtPct)} → <b>${fmtPct(holdsPct)}</b></span>`,
        `<span class="k">Sold so far</span><span class="v">${soldShare == null ? fmtPct(s.clusterSoldPct) : fmtPct((Math.max(0, totalBought - totalNow) / supply) * 100)} of supply (${soldShare == null ? '—' : Math.round(soldShare * 100) + '% of their bag'})${s.clusterSoldSol ? ` · ${fmtSol(s.clusterSoldSol)} out` : ''}</span>`,
        `<span class="k" title="Minutes after launch when any cluster wallet first sold this token (from their token-account history)">First cluster sell</span><span class="v">${s.firstClusterSellMin == null ? (s.sellsSeen === 0 ? 'none yet' : '—') : `+${s.firstClusterSellMin}m after launch`}</span>`,
        `<span class="k" title="≥2 cluster wallets selling within the same 10 seconds — one hand on the button">Coordinated exits</span><span class="v ${s.coordinatedExits ? 'bad' : ''}">${s.coordinatedExits}</span>`,
        `<span class="k" title="Tokens transferred (not sold) to another wallet — usually to dump from a 'clean' address">Hand-offs</span><span class="v">${s.handoffCount}${s.handoffTokensPct ? ` · ${fmtPct(s.handoffTokensPct)}` : ''}</span>`,
        `<span class="k">Selling now (10m)</span><span class="v ${s.dumpingNow ? 'bad' : 'good'}">${s.dumpingNow ? `${s.dumpingNow} sell${s.dumpingNow === 1 ? '' : 's'}${s.recentSoldPct ? ` · ${fmtPct(s.recentSoldPct)}` : ''}` : 'no'}</span>`,
      ];
      if (l.snipers) rows.push(`<span class="k">Snipers (${l.snipers.count})</span><span class="v">bought ${fmtPct(l.snipers.boughtPct)} → hold ${fmtPct(l.snipers.holdsPct)}${l.snipers.exitedShare != null ? ` <span class="muted">(${Math.round(l.snipers.exitedShare * 100)}% out)</span>` : ''}</span>`);
      if (ls?.curve?.mcapUsd) rows.push(`<span class="k" title="From the bonding curve's reserves, pushed by the RPC the moment they change">Live mcap</span><span class="v cyan">${fmtUsd(ls.curve.mcapUsd)} <span class="muted">${ago(ls.curve.at)}</span></span>`);
      // cluster wallet table (live)
      const roleOf = (h) => (h.wallet === r.creation?.creator ? 'dev' : h.kind || 'bundle');
      const clusterRows = holdings.slice(0, 25).map((h) => {
        const boughtPct = (h.bought / supply) * 100;
        const nowPct = h.now == null ? null : (h.now / supply) * 100;
        const status = h.now == null ? '<span class="muted">?</span>' : h.now === 0 && h.bought > 0 ? '<span class="bad">sold out</span>' : h.bought && h.now < h.bought * 0.5 ? `<span class="bad">sold ${Math.round((1 - h.now / h.bought) * 100)}%</span>` : h.bought && h.now < h.bought * 0.98 ? `<span class="amber">trimmed ${Math.round((1 - h.now / h.bought) * 100)}%</span>` : h.now > h.bought * 1.02 ? '<span class="cyan">added</span>' : '<span class="good">holding</span>';
        const flash = ls?.flash?.get(h.wallet) && Date.now() - ls.flash.get(h.wallet) < 4000 ? ' style="background:#1a2230"' : '';
        return `<tr${flash}><td>${link(h.wallet)} <span class="pill ${esc(roleOf(h))}">${esc(roleOf(h))}</span></td><td class="num">${fmtPct(boughtPct)}</td><td class="num">${nowPct == null ? '?' : fmtPct(nowPct)}</td><td>${status}</td></tr>`;
      });
      const clusterTable = clusterRows.length ? `<div class="note" style="margin-top:6px"><b>Cluster wallets</b> <span class="muted">· ${holdings.length} tracked${ls?.status?.state === 'open' ? ' · <span class="live-dot"></span>live' : ''}</span></div><div class="tscroll"><table><tr><th>wallet</th><th class="num">bought</th><th class="num">holds</th><th>status</th></tr>${clusterRows.join('')}</table></div>` : '';
      const feed = this.activityFeed(r);
      const reps = [];
      const snR = r.reputation?.snipers || [];
      if (snR.length) {
        const top = snR[0];
        reps.push(`${snR.length} of these sniper bots showed up on launches you scanned before (${link(top.wallet)}: ${top.seen}×${top.avoid ? `, ${top.avoid} rated Avoid` : ''})`);
      }
      const feR = (r.reputation?.feeWallets || []).filter((x) => !(r.launch?.sharedFeeRecipients || []).find((f) => f.address === x.wallet && f.platform));
      if (feR.length) reps.push(`fee wallet ${link(feR[0].wallet)} collected on ${feR[0].seen} earlier launch${feR[0].seen === 1 ? '' : 'es'} you scanned${feR[0].avoid ? ` (${feR[0].avoid} rated Avoid)` : ''}`);
      const fuR = r.reputation?.funders || [];
      if (fuR.length) reps.push(`funder ${link(fuR[0].wallet)} funded buyers on ${fuR[0].seen} earlier launch${fuR[0].seen === 1 ? '' : 'es'} you scanned${fuR[0].avoid ? ` (${fuR[0].avoid} rated Avoid)` : ''}`);
      const repHtml = reps.length ? `<div class="rep">${reps.map((x) => `· ${x}`).join('<br>')}</div>` : '';
      const sub = s.dumpingNow ? '<span class="bad">selling now</span>' : `holds ${fmtPct(holdsPct)}`;
      const st = ls?.status;
      const liveTag = st?.state === 'open' ? `<div class="note"><span class="live-dot"></span>live — balance changes arrive the moment they confirm (${st.subs} accounts watched)${this.liveRefreshAt ? ` · sells re-read ${ago(this.liveRefreshAt)}` : ''}</div>` : st?.state === 'reconnecting' ? '<div class="note">live feed reconnecting…</div>' : st?.state === 'error' ? `<div class="note">live feed unavailable on this RPC (${esc(st.message || 'no websocket')}) — refreshing every 45 s instead</div>` : r.finishedAt && this.autoRefreshEligible() ? '<div class="note"><span class="live-dot"></span>connecting live feed…</div>' : '';
      return this.sec('live', 'Insider flow', sub, `<div class="kv">${rows.join('')}</div>${clusterTable}${feed}${repHtml}${liveTag}`);
    }
    /** "What just happened": the cluster's own trades and transfers, newest first (live events merged in). */
    activityFeed(r) {
      const l = r.live;
      const L = r.launch;
      const launchMs = (r.creation?.blockTime || 0) * 1000 || r.creation?.createdAt || 0;
      const kinds = new Map((L?.buyers || []).map((b) => [b.wallet, b.kind]));
      const who = (w, k) => (w === r.creation?.creator ? 'dev' : (k || kinds.get(w)) === 'bundle' ? 'launch wallet' : (k || kinds.get(w)) === 'sniper' ? 'sniper bot' : (k || kinds.get(w)) === 'organic' ? 'early buyer' : 'launch wallet');
      const supply = r.supply || 1e9;
      const liveEvs = (this.liveState?.events || []).map((e) => ({ ...e, live: true }));
      const scanEvs = (l?.events || []).filter((e) => e.t && ((e.tokens / supply >= 0.0005) || (e.sol || 0) >= 0.05 || e.side.startsWith('transfer')));
      const evs = [...liveEvs, ...scanEvs].sort((a, b) => b.t - a.t).slice(0, 10);
      if (!evs.length && !(l?.exitEvents || []).length) return '';
      const when = (t) => {
        const min = launchMs ? Math.max(0, Math.round((t - launchMs) / 60000)) : null;
        return `<span class="t" title="${new Date(t).toLocaleTimeString()}">${ago(t)}${min != null ? `<br><span style="font-size:10px" title="minutes after launch">+${min}m</span>` : ''}</span>`;
      };
      const rows = evs.map((e) => {
        const pctS = e.tokens ? fmtPct((e.tokens / supply) * 100) : '';
        const w = who(e.wallet, e.walletKind);
        let txt;
        if (e.side === 'sell') txt = `${w} ${link(e.wallet)} sold ${pctS}${e.sol ? ` for ${fmtSol(e.sol)}` : ''}${e.closed ? ' <span class="muted">(everything)</span>' : ''}`;
        else if (e.side === 'buy') txt = `${w} ${link(e.wallet)} bought ${pctS}${e.sol ? ` (${fmtSol(e.sol)})` : ''}`;
        else if (e.side === 'transfer_out') txt = `${w} ${link(e.wallet)} moved ${pctS} to ${e.to ? link(e.to) : 'another wallet'} <span class="muted">(hand-off)</span>`;
        else if (e.side === 'transfer_in') txt = `${w} ${link(e.wallet)} received ${pctS}${e.from ? ` from ${link(e.from)}` : ''}`;
        else txt = `${w} ${link(e.wallet)} ${esc(e.side)}`;
        return `<div class="ev ${esc(e.side)}">${when(e.t)}<span>${e.live ? '<span class="live-dot"></span>' : ''}${txt}</span></div>`;
      });
      const exitsNote = (l?.exitEvents || []).slice(0, 2).map((x) => `<div class="ev sell"><span class="t">+${x.minutesAfterLaunch}m</span><span><b>${x.wallets} wallets sold within 10 s</b> — ${fmtPct(x.pct)} of supply, ${fmtSol(x.sol)} <span class="muted">(coordinated exit)</span></span></div>`).join('');
      return `<div class="feed"><div class="note" style="margin:6px 0 2px"><b>What just happened</b> <span class="muted">· cluster wallets, newest first · "+Nm" = minutes after launch</span></div>${exitsNote}${rows.join('')}</div>`;
    }
    autoRefreshEligible() {
      const r = this.report;
      if (!r?.finishedAt || !r.launch || !r.creation) return false;
      const ageMs = Date.now() - (r.creation.createdAt || 0);
      return ageMs < 6 * 3600 * 1000; // only worth polling for tokens launched in the last 6 h
    }
    devLine(r, p) {
      // "This wallet has launched 5,092 tokens" — the one fact Axiom shows and GLASS 0.2 missed
      if (!p) return '';
      const n = p.totalCreated;
      const kind = p.archetype?.kind;
      const chip = kind === 'farm' ? '<span class="pill bear">token farm</span>' : kind === 'serial' ? '<span class="pill mix">serial launcher</span>' : kind === 'first' ? '<span class="pill na">first launch</span>' : '';
      const since = p.firstCreatedAt ? `since ${new Date(p.firstCreatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
      const rate = p.perDay != null && n >= 5 ? (p.perDay >= 1 ? `≈${Math.round(p.perDay)}/day` : p.perDay * 7 >= 1 ? `≈${Math.round(p.perDay * 7)}/week` : '') : '';
      const st = p.stats || {};
      const bits = [];
      if (st.n) bits.push(`<span title="Share of their launches that reached graduation (~$69k)">${Math.round((st.graduationRate || 0) * 100)}% graduated</span>`);
      if (st.n) bits.push(`<span title="Median of the highest market cap their launches reached">typical peak ${fmtUsd(st.medianAthUsd)}</span>`);
      if (st.best?.athMcapUsd) bits.push(`<span title="Their best launch ever">best ${fmtUsd(st.best.athMcapUsd)}${st.best.symbol ? ` ($${esc(st.best.symbol)})` : ''}</span>`);
      if (st.n && st.deadRate != null) bits.push(`<span title="Share of launches that never traded above $10k — the dev buy + bots was the top">${Math.round(st.deadRate * 100)}% never ran</span>`);
      if (st.n && st.ranRate != null) bits.push(`<span title="Share of launches that reached at least $30k market cap">${Math.round(st.ranRate * 100)}% ran past $30k</span>`);
      return `<div class="devline"><span class="big">${n.toLocaleString()}${p.atLeast ? '+' : ''} token${n === 1 ? '' : 's'}</span><span class="muted">launched by this wallet${since ? ` ${since}` : ''}${rate ? ` · ${rate}` : ''}${p.last24hAtLeast ? ` · ${p.last24h}+ in 24h` : p.last24h >= 3 ? ` · ${p.last24h} in 24h` : ''}</span>${chip}</div>${bits.length ? `<div class="leg" style="margin-bottom:6px">${bits.join('<span class="muted">·</span>')}</div>` : ''}`;
    }
    secOperator(r) {
      const o = r.operator;
      const early = r.devProfile;
      if (!o) return this.sec('operator', 'Dev history', early ? `${early.totalCreated.toLocaleString()}${early.atLeast ? '+' : ''} launches` : 'searching…', `${this.devLine(r, early)}<div class="skl"></div><div class="skl" style="width:80%"></div>`);
      const rt = o.rating;
      let pill = '<span class="pill na">unrated</span>';
      if (rt?.score != null) pill = `<span class="pill ${rt.score >= 65 ? 'bull' : rt.score >= 40 ? 'mix' : 'bear'}" title="Dev score 0–100: how a buyer at launch has fared on this dev's previous tokens. 0 = they sell at launch and nothing runs; 100 = launches run and the dev holds. ${esc(rt.label)}.">${esc(rt.label)} · dev score ${rt.score}/100</span>`;
      const reasons = rt?.reasons?.length ? `<ul class="rs">${rt.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
      let table = '';
      if (o.launches?.length) {
        const shown = o.launches.slice(0, 8);
        table = `<table class="op-table"><tr><th>prior launch</th><th class="num" title="Highest market cap it ever reached">peak</th><th class="num" title="How long after launch that peak came. 'launch' = the top was the launch block itself (the dev/bundle buy was the all-time high)">peak after</th><th class="num" title="Market cap now">now</th><th title="When the dev wallet first sold that token, read from its token account. '—' = not checked (only the most recent launches are), 'held' = no sell found">dev sold</th></tr>${shown
          .map((l) => {
            const how = (l.linkedBy || []).map((x) => (x.wallets && x.wallets.length > 1 ? x.how : `${short(x.wallet)} (${x.how})`)).join('; ') || (l.relation === 'created' ? 'created by a cluster wallet' : 'cluster wallets bought in its launch window');
            const tag = l.relation === 'created' ? (l.viaInfra ? 'funder\'s dev' : 'same dev') : l.viaInfra ? 'same funder' : 'same wallets';
            const when = l.createdAt ? `<span class="muted" style="font-size:10px"> ${ago(l.createdAt).replace(' ago', '')}</span>` : '';
            const showHow = l.source !== 'pump.fun' || l.viaInfra;
            return `<tr><td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.symbol || short(l.mint))}</a>${when} <span class="pill na" title="${esc(how)}">${tag}</span></td><td class="num" title="${l.source === 'on-chain' ? 'from on-chain trades (no price candles yet) — a lower bound' : l.source === 'pump.fun' ? 'all-time high market cap (pump.fun record)' : ''}">${fmtUsd(l.peakMcapUsd)}${l.source === 'on-chain' ? '<span class="muted">≥</span>' : ''}${l.graduated ? ' <span class="good" title="graduated to a DEX">G</span>' : ''}</td><td class="num">${l.minutesToPeak == null ? '—' : l.minutesToPeak <= 0.1 ? '<span class="muted" title="peaked in the launch block">launch</span>' : fmtMin(l.minutesToPeak)}</td><td class="num">${fmtUsd(l.nowMcapUsd)}</td><td class="sold">${l.clusterExit?.sells ? `<span class="bad" title="${esc(`sold ${l.clusterExit.soldShare != null ? Math.round(l.clusterExit.soldShare * 100) + '% of their bag' : ''} ${l.clusterExit.solOut ? 'for ' + l.clusterExit.solOut.toFixed(2) + ' SOL' : ''}`)}">${l.clusterExit.firstSellSec != null && l.clusterExit.firstSellSec < 90 ? `+${l.clusterExit.firstSellSec}s` : `+${l.clusterExit.firstSellMin}m`}</span>` : l.clusterExit ? `<span class="good" title="${esc(l.clusterExit.note || '')}">held</span>` : '<span class="muted" title="not checked">—</span>'}</td></tr>
            ${showHow ? `<tr class="how"><td colspan="5" class="muted" style="font-size:10.5px;padding-top:0">↳ linked because ${esc(how)}</td></tr>` : ''}`;
          })
          .join('')}</table>${o.launches.length > shown.length ? `<div class="note">${o.launches.length - shown.length} more launch${o.launches.length - shown.length === 1 ? '' : 'es'} counted in the rating · <a href="https://pump.fun/profile/${esc(r.creation?.creator || '')}?tab=coins" target="_blank" rel="noopener">all on pump.fun</a></div>` : ''}`;
      } else if (o.disabled) table = '<div class="note">Operator history is disabled in settings.</div>';
      else if (!rt) table = '<div class="note">Loading outcomes…</div>';

      let warn = '';
      const prof = o.profile;
      if (rt?.thin && rt.rated > 0) {
        warn = prof && prof.totalCreated > rt.rated + 1
          ? `<div class="warnbox">⚠ This wallet has launched <b>${prof.totalCreated.toLocaleString()}</b> tokens but only <b>${rt.rated}</b> had a recorded peak to judge by. Read the numbers below as "what happened last time", not as a forecast.</div>`
          : `<div class="warnbox">⚠ Thin history: only <b>${rt.rated} prior launch${rt.rated === 1 ? '' : 'es'}</b> could be linked to this operator${prof ? ` (pump.fun confirms ${prof.totalCreated} launch${prof.totalCreated === 1 ? '' : 'es'} from this wallet)` : ''}. One launch is an anecdote, not a pattern — read the numbers below as "what happened last time", not as a forecast.</div>`;
      }
      if (!prof && o.profileError && r.market?.dexId !== 'pumpswap' && r.creation?.generic === false) warn += `<div class="warnbox">pump.fun's launch record could not be reached (${esc(o.profileError)}), so history below is sampled from chain only — the last ~${r.rpc?.historyHours || 14}h of this wallet. The dev may have far more launches than shown.</div>`;
      if (rt?.historyExceeded) warn += `<div class="warnbox cyan-box">This token (${fmtUsd(r.market?.marketCapUsd)}) has already run past every prior peak this operator has (${fmtUsd(rt.exit?.highest?.mcapUsd)}). Their history is not a guide for where this one stops.</div>`;

      let targets = '';
      if (rt?.exit) {
        const e = rt.exit;
        const cur = r.market?.marketCapUsd;
        const t = (label, help, x) => `<div class="tgt ${x.reached ? 'hit' : ''}" title="${esc(help)}"><div class="l">${label}</div><div class="m">${fmtUsd(x.mcapUsd)}</div><div class="x">${x.reached ? 'already above this' : x.multiple ? `${x.multiple.toFixed(1)}× from here` : ''}</div></div>`;
        const boxes = e.single
          ? t('their only prior peak', 'The highest market cap the one prior launch reached', e.base)
          : `${t('low end', 'A quarter of their prior launches peaked below this', e.conservative)}${t('typical peak', 'Half of their prior launches peaked below this — the middle of the pack', e.base)}${t('high end', 'Three quarters of their prior launches peaked below this; only the best quarter went higher', e.stretch)}`;
        targets = `<div class="note" style="margin-top:8px"><b>Where this operator's launches usually top out</b> <span class="muted">· based on ${esc(e.basis)}${cur ? ` · this token now ${fmtUsd(cur)}` : ''}</span></div>
          <div class="targets ${e.single ? 'single' : ''}">${boxes}
          ${e.operatorDump ? `<div class="tgt dump"><div><div class="l">they usually start selling around</div><div class="m bad">${fmtUsd(e.operatorDump.mcapUsd)}</div></div><div class="x">≈ ${fmtMin(e.operatorDump.minutes)} after launch${e.operatorDump.reached ? ' · this token is already above that level' : e.operatorDump.multiple ? ` · ${e.operatorDump.multiple.toFixed(1)}× from here` : ''}. If you're in, plan your exit before this.</div></div>` : ''}</div>
          <div class="note">${esc(e.note)}</div>`;
      }
      const linkers = r.operatorCluster?.linkers || [];
      const hops = o.funderHops || [];
      const lp = o.linkerProfiles || [];
      const infra = linkers.length ? `<div class="note" title="The wallets GLASS treats as 'the operator': the creator plus the wallets that paid fees for, or funded, the launch buyers. Launch wallets themselves are listed under Receipts.">Linked through: creator ${link(r.creation?.creator)}${linkers.length ? ` + ${linkers.length} funder/fee-payer wallet${linkers.length > 1 ? 's' : ''} ${linkers.slice(0, 3).map((a) => link(a)).join(', ')}` : ''}${hops.length ? ` · funder${hops.length > 1 ? 's' : ''} seen funding ${hops.map((h) => h.funded).reduce((a, b) => a + b, 0)}+ wallets recently` : ''}${lp.length ? ` · ${lp.map((x) => `${short(x.creator)} itself launched ${x.totalCreated.toLocaleString()} token${x.totalCreated === 1 ? '' : 's'}`).join(', ')}` : ''}</div>` : '';
      const rep = r.reputation?.dev && r.reputation.dev.seen > 0 ? `<div class="rep">You scanned ${r.reputation.dev.seen} earlier launch${r.reputation.dev.seen === 1 ? '' : 'es'} from this dev${r.reputation.dev.avoid ? ` — ${r.reputation.dev.avoid} rated Avoid` : ''}.</div>` : '';
      const sub = rt?.score != null ? pill : prof ? `${prof.totalCreated.toLocaleString()}${prof.atLeast ? '+' : ''} launches` : o.discovered ? `${o.discovered} found` : 'none found';
      return this.sec('operator', 'Dev history', sub, `${this.devLine(r, prof)}${rt?.score != null ? `<div style="margin:2px 0 4px">${pill} <span class="muted">rated on ${rt.rated} launch${rt.rated === 1 ? '' : 'es'}${prof?.sampleFull ? ' (most recent)' : ''}</span></div>` : ''}${warn}${infra}${rep}${reasons}${table}${targets}`);
    }
    secReceipts(r) {
      const L = r.launch;
      const prof = new Map((r.wallets?.profiles || []).map((p) => [p.wallet, p]));
      const hold = new Map([...(r.live?.holdings || []), ...(r.live?.otherHoldings || [])].map((h) => [h.wallet, h]));
      const liveBal = this.liveState?.balances || new Map();
      const holdsCell = (wallet) => {
        const lv = liveBal.get(wallet);
        const h = hold.get(wallet);
        const now = lv != null ? lv : h ? h.now : null;
        if (now == null) return '<span class="muted">?</span>';
        return now === 0 ? '<span class="bad">0</span>' : fmtPct((now / L.supply) * 100);
      };
      const routeCell = (b) => {
        const lbl = b.routeLabel || '';
        const known = !/^[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/.test(lbl);
        const route = known ? esc(lbl) : `<span title="Unlabelled program ${esc(b.route || '')} — a trading bot / router GLASS has no name for yet (see bounties)">via ${esc(lbl)}</span>`;
        return `${b.tip ? `<span title="paid a Jito tip of ${(b.tip / 1e9).toFixed(4)} SOL to land in a bundle">tip</span> · ` : ''}${route}`;
      };
      const rows = L.buyers.slice(0, 40).map((b) => {
        const p = prof.get(b.wallet);
        const kind = b.kind || p?.kind || (b.firstSlotOffset <= L.window.slotWindow ? 'unclassified' : '');
        const fund = p?.fundingLabel ? ` · ${esc(p.fundingLabel)}` : p?.fundingMethod === 'wsol-close' ? ' · WSOL-close funded' : '';
        return `<tr><td>+${b.firstSlotOffset}</td><td>${link(b.wallet)}${kind ? `<span class="pill ${kind}" title="${esc(b.kindReason || '')}">${kind}</span>` : ''}</td><td class="num" title="${b.flipped ? `bought ${fmtPct(b.boughtPct)} and sold part or all of it again inside the launch window (flip)` : 'share of supply still held at the end of the launch window'}">${fmtPct(b.pct)}${b.flipped ? ' <span class="amber" title="flipped: sold inside the launch window">↺</span>' : ''}</td><td class="num">${fmtSol(b.sol)}</td><td class="num">${holdsCell(b.wallet)}</td><td class="muted" title="${esc((p?.flags || []).join('; '))}">${routeCell(b)}${fund}</td></tr>`;
      });
      const dev = L.creatorDevBuy;
      const devRow = r.creation ? `<tr><td>0</td><td>${link(r.creation.creator)}<span class="pill" style="color:#c084fc">dev</span></td><td class="num">${fmtPct(dev.pct)}</td><td class="num">${fmtSol(dev.sol)}</td><td class="num">${holdsCell(r.creation.creator)}</td><td class="muted">create tx ${link(r.creation.sig, 'tx', 'view')}</td></tr>` : '';
      const inner = `<div class="tscroll"><table><tr><th title="Slots after the creation slot (0 = same block the token was created in; one slot ≈ ${r.slotMs || 400} ms)">slot</th><th title="Buyer wallet. Pill = GLASS classification (hover for why)">wallet</th><th class="num" title="Share of total token supply this wallet ended up with inside the launch window (net of anything it sold back). ↺ = bought and sold inside the window">% supply</th><th class="num" title="SOL the wallet spent on its launch buys">SOL paid</th><th class="num" title="Share of supply the wallet holds right now (0 = fully sold). Updates live.">holds now</th><th title="Which program the buy went through (pump.fun directly, or a router/bot), and how the wallet was funded">route · funding</th></tr>${devRow}${rows.join('')}</table></div>${L.buyers.length > 40 ? `<div class="note">${L.buyers.length - 40} more early buyers not shown.</div>` : ''}<div class="note">↺ = bought and sold again inside the launch window · "via XXXX…" = an unlabelled bot/router program · scroll sideways for more columns.</div>`;
      return this.sec('receipts', 'Receipts', `${L.buyers.length} early wallets`, inner);
    }
    secScore(r) {
      const s = r.score;
      const inner = `<table>${s.parts.map((p) => `<tr><td style="white-space:normal">${esc(p.label)}</td><td class="num">${p.pts}/${p.max}</td><td class="muted" style="white-space:normal">${esc(p.detail)}</td></tr>`).join('')}</table>`;
      return this.sec('score', 'Score breakdown', `${s.score}/100`, inner);
    }
    bind() {
      const head = this.shadow.querySelector('.head');
      this.shadow.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', () => this.toggle(el.dataset.toggle)));
      this.shadow.querySelectorAll('[data-act]').forEach((el) =>
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const a = el.dataset.act;
          if (a === 'collapse') this.setCollapsed(true);
          if (a === 'rescan') this.onRescan?.();
          if (a === 'copy') this.copyReport();
        }),
      );
      if (this.collapsed) head.addEventListener('click', (e) => { if (!this.lastDragMoved) this.setCollapsed(false); });
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-act]') || e.button !== 0) return;
        const rect = this.root.getBoundingClientRect();
        this.drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false, target: head };
        try {
          head.setPointerCapture(e.pointerId);
        } catch {
          /* unsupported */
        }
        e.preventDefault();
      });
      head.addEventListener('pointermove', this.onPointerMove);
      head.addEventListener('pointerup', this.onPointerUp);
      head.addEventListener('pointercancel', this.onPointerUp);
    }
    setCollapsed(v) {
      this.collapsed = v;
      api.storage?.local?.set({ glassPanelCollapsed: v }).catch?.(() => {});
      this.render();
    }
    copyReport() {
      const r = this.report;
      if (!r) return;
      const L = r.launch;
      const lines = [];
      lines.push(`GLASS ${r.score?.score ?? '?'}/100 — ${r.market?.name || ''} ($${r.market?.symbol || ''}) ${r.mint}`);
      if (r.score?.call) lines.push(`${r.score.call.word.toUpperCase()} (${r.score.call.confidence} confidence): ${r.score.call.why.join('; ')}`);
      if (r.score?.verdict) lines.push(`${r.score.verdict.headline}. ${r.score.verdict.sub}`);
      if (r.operator?.profile) lines.push(`Dev: ${r.operator.profile.totalCreated}${r.operator.profile.atLeast ? '+' : ''} tokens launched by this wallet (${r.operator.profile.archetype?.label || ''})`);
      if (L) lines.push(`Launch: ${L.classified ? `bundle ${fmtPct(L.bundle.pct)} (${L.bundle.count}), snipers ${fmtPct(L.snipers.pct)} (${L.snipers.count}), organic ${fmtPct(L.organic.pct)}` : `${fmtPct(L.window.pct)} in ${L.window.count} wallets`}, dev ${fmtPct(L.creatorDevBuy.pct)}; creation slot ${L.slot0.count} wallets ${fmtPct(L.slot0.pct)}`);
      if (L?.launchToolPattern?.reasons?.length) lines.push(`Coordination: ${L.launchToolPattern.reasons.join('; ')}`);
      if (r.wallets?.summary?.reasons?.length) lines.push(`Wallets: ${r.wallets.summary.reasons.join('; ')}`);
      if (r.live?.summary) {
        const s = r.live.summary;
        lines.push(`Insider flow: holds ${fmtPct(s.clusterHoldsPct)} (bought ${fmtPct(s.clusterBoughtPct)}), sold ${fmtPct(s.clusterSoldPct)}, ${s.coordinatedExits} coordinated exits, ${s.handoffCount} hand-offs${s.dumpingNow ? `, SELLING NOW (${s.dumpingNow})` : ''}`);
      }
      if (r.operator?.rating) {
        const rt = r.operator.rating;
        lines.push(`Operator: ${rt.label}${rt.score != null ? ` ${rt.score}/100` : ''} — ${rt.reasons.join('; ')}`);
        for (const l of r.operator.launches.slice(0, 10)) lines.push(`  ${l.relation} ${l.symbol || l.mint}: peak ${fmtUsd(l.peakMcapUsd)} @${fmtMin(l.minutesToPeak)}, now ${fmtUsd(l.nowMcapUsd)}${l.graduated ? ', graduated' : ''}${l.clusterExit?.sells ? `, cluster sold +${l.clusterExit.firstSellMin}m` : ''}`);
        if (rt.thin) lines.push(`WARNING: only ${rt.rated} prior launch(es) linked — not a pattern.`);
        if (rt.exit) lines.push(rt.exit.single ? `Their only prior peak: ${fmtUsd(rt.exit.base.mcapUsd)}${rt.exit.operatorDump ? ` · they started selling ~${fmtUsd(rt.exit.operatorDump.mcapUsd)} (+${fmtMin(rt.exit.operatorDump.minutes)})` : ''}` : `Where their launches usually top out: low ${fmtUsd(rt.exit.conservative.mcapUsd)} · typical ${fmtUsd(rt.exit.base.mcapUsd)} · high ${fmtUsd(rt.exit.stretch.mcapUsd)}${rt.exit.operatorDump ? ` · they usually start selling ~${fmtUsd(rt.exit.operatorDump.mcapUsd)} (+${fmtMin(rt.exit.operatorDump.minutes)})` : ''}`);
      }
      lines.push('— GLASS (open-source launch scanner). Not financial advice.');
      navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
      const btn = this.shadow.querySelector('[data-act="copy"]');
      if (btn) {
        btn.textContent = '✓';
        setTimeout(() => (btn.textContent = '⧉'), 1200);
      }
    }
  }

  // ---------- live refresh (insider flow keeps updating while the page is open) ----------
  const LIVE_EVERY_MS = 45_000;
  const LIVE_MAX_ROUNDS = 40; // 30 minutes, then the user can hit ↻
  let liveTimer = null;
  let liveRounds = 0;
  function stopLive() {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  function startLive(everyMs = LIVE_EVERY_MS) {
    stopLive();
    liveRounds = 0;
    if (!panel?.autoRefreshEligible()) return;
    liveTimer = setInterval(refreshLive, everyMs);
  }
  async function refreshLive() {
    const r = panel?.report;
    if (!r?.finishedAt || !r.launch || panel.collapsed || document.hidden || panel.liveRefreshing) return;
    if (++liveRounds > LIVE_MAX_ROUNDS || !panel.autoRefreshEligible()) return stopLive();
    const L = r.launch;
    const win = (L.buyers || []).filter((b) => b.firstSlotOffset <= L.window.slotWindow);
    const cluster = [{ wallet: r.creation.creator, tokens: L.creatorDevBuy?.tokens || 0 }, ...win.filter((b) => b.kind !== 'organic' && b.kind !== 'sniper').map((b) => ({ wallet: b.wallet, tokens: b.tokens, kind: b.kind }))].filter((c) => c.wallet);
    const snipers = win.filter((b) => b.kind === 'sniper').map((b) => ({ wallet: b.wallet, tokens: b.tokens }));
    const clusterSet = new Set(cluster.map((c) => c.wallet));
    const others = (L.buyers || []).filter((b) => !clusterSet.has(b.wallet)).slice(0, 60).map((b) => ({ wallet: b.wallet, tokens: b.tokens, kind: b.kind || 'early' }));
    panel.liveRefreshing = true;
    try {
      const res = await api.runtime.sendMessage({
        type: 'refreshLive',
        mint: r.mint,
        cluster,
        snipers,
        others,
        launchTimeSec: r.creation.blockTime || Math.floor((r.creation.createdAt || Date.now()) / 1000),
        supply: r.supply,
        tokenProgram: r.tokenProgram,
        scoreInput: { launch: L, wallets: r.wallets, operator: r.operator?.rating, ctx: { profile: r.operator?.profile || null, operatorDone: true, degraded: r.degraded, rateLimited: r.rpc?.rateLimited } },
      });
      if (res?.live && panel.report === r) {
        r.live = res.live;
        if (res.score) r.score = res.score;
        r.rpcCalls = (r.rpcCalls || 0) + (res.rpcCalls || 0);
        panel.liveRefreshAt = res.at || Date.now();
      }
    } catch (e) {
      console.debug('[GLASS] live refresh failed', e);
    } finally {
      panel.liveRefreshing = false;
      panel.render();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && liveTimer) refreshLive();
  });

  // ---------- real-time feed over the worker's websocket ----------
  function startWatch(r) {
    if (!port || !r?.finishedAt || !r.launch || !r.creation || !panel.autoRefreshEligible()) return;
    const L = r.launch;
    const win = (L.buyers || []).filter((b) => b.firstSlotOffset <= L.window.slotWindow);
    const wallets = [{ wallet: r.creation.creator, kind: 'dev' }, ...win.filter((b) => b.kind !== 'organic').map((b) => ({ wallet: b.wallet, kind: b.kind || 'bundle' }))].filter((w) => w.wallet).slice(0, 40);
    const balances = [...(r.live?.holdings || []), ...(r.live?.otherHoldings || [])].map((h) => ({ wallet: h.wallet, now: h.now }));
    try {
      port.postMessage({ type: 'watch', mint: r.mint, tokenProgram: r.tokenProgram, wallets, balances, curve: r.creation.bondingCurve || null });
    } catch {
      /* port gone */
    }
  }
  function onLiveEvent(ev) {
    const r = panel.report;
    if (!r || !ev) return;
    const ls = (panel.liveState = panel.liveState || { balances: new Map(), events: [], flash: new Map() });
    if (ev.type === 'curve') {
      const sol = r.solUsd || (r.market?.priceUsd && r.market?.priceNative ? r.market.priceUsd / r.market.priceNative : null);
      ls.curve = { ...ev, mcapUsd: ev.priceSol && sol ? ev.priceSol * (r.supply || 1e9) * sol : null };
      if (ls.curve.mcapUsd && r.market) r.market.marketCapUsd = ls.curve.mcapUsd;
      // throttle re-render for price ticks
      clearTimeout(ls.curveTimer);
      ls.curveTimer = setTimeout(() => panel.render(), 400);
      return;
    }
    if (ev.type === 'balance') {
      ls.balances.set(ev.wallet, ev.amount);
      ls.flash.set(ev.wallet, Date.now());
      if (ev.delta != null && ev.delta !== 0) {
        const side = ev.delta < 0 ? 'sell' : 'buy';
        ls.events.unshift({ t: ev.at, wallet: ev.wallet, walletKind: ev.walletKind, side, tokens: Math.abs(ev.delta), sol: null, closed: ev.closed || ev.amount === 0 });
        ls.events = ls.events.slice(0, 30);
        // keep the summary honest without a full rescan
        if (r.live?.summary && side === 'sell') {
          const sm = r.live.summary;
          const launchSec = r.creation.blockTime || Math.floor((r.creation.createdAt || 0) / 1000);
          if (sm.firstClusterSellMin == null) sm.firstClusterSellMin = Math.max(0, Math.round((ev.at / 1000 - launchSec) / 60));
          sm.dumpingNow = (sm.dumpingNow || 0) + 1;
          sm.lastClusterSellAt = ev.at;
          sm.sellsSeen = (sm.sellsSeen || 0) + 1;
        }
      }
      panel.render();
    }
  }

  // ---------- controller ----------
  let panel = null;
  let port = null;
  let pingTimer = null;
  let retryTimer = null;
  let attempt = 0;
  const RETRY_MS = [500, 1200, 2500];
  let current = null; // identifier currently shown
  let lastHref = null;

  function disconnect() {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (port) {
      const old = port;
      port = null;
      try {
        old.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  function connect(identifier, hintIsMint, force = false, preserveReport = false) {
    disconnect();
    panel.error = null;
    if (!force && !preserveReport) panel.setReport(null, identifier);
    try {
      port = api.runtime.connect({ name: 'glass-scan' });
    } catch (e) {
      panel.setError('GLASS was updated — reload this page to reconnect.');
      return;
    }
    const connectedPort = port;
    connectedPort.onMessage.addListener((msg) => {
      if (port !== connectedPort) return;
      if (!msg) return;
      if (msg.type === 'stage' || msg.type === 'done') {
        if (msg.report?.identifier !== identifier && msg.report?.mint !== identifier) return;
        attempt = 0;
        // On an explicit re-scan keep the old report on screen until the new one has launch data.
        if (force && panel.report && msg.type !== 'done' && !msg.report.launch) {
          panel.report.stages = msg.report.stages;
          panel.render();
          return;
        }
        panel.setReport(msg.report, identifier);
        if (msg.type === 'done') {
          panel.liveRefreshAt = null;
          panel.liveState = { balances: new Map(), events: [], flash: new Map(), status: null };
          startLive();
          startWatch(msg.report);
        }
      } else if (msg.type === 'live-event') onLiveEvent(msg.ev);
      else if (msg.type === 'live-status') {
        panel.liveState = panel.liveState || { balances: new Map(), events: [], flash: new Map() };
        panel.liveState.status = msg.status;
        if (msg.status?.state === 'open') startLive(180_000); // websocket is the source now; polling only re-reads sells/exits
        panel.render();
      } else if (msg.type === 'error') panel.setError(msg.message);
      else if (msg.type === 'tick') {
        if (panel.report) {
          panel.report.rpcCalls = msg.rpcCalls;
          panel.report.degraded = msg.degraded;
          panel.render();
        }
      }
    });
    connectedPort.onDisconnect.addListener(() => {
      const err = api.runtime.lastError?.message || '';
      if (port !== connectedPort) return;
      port = null;
      clearInterval(pingTimer);
      stopLive();
      if (err) console.warn('[GLASS] worker port closed:', err);
      // The worker may still be starting up (cold start) — retry a few times before giving up.
      if (attempt < RETRY_MS.length && current?.identifier === identifier) {
        const wait = RETRY_MS[attempt++];
        panel.setError(`Connecting to the GLASS worker… (retry ${attempt}/${RETRY_MS.length})`);
        retryTimer = setTimeout(() => current?.identifier === identifier && connect(identifier, hintIsMint, force, true), wait);
        return;
      }
      const hint = `Reload this page. ${backgroundHelp}`;
      panel.setError(`Lost connection to the GLASS worker${err ? ` (${err})` : ''}. ${hint}`);
    });
    port.postMessage({ type: 'scan', identifier, hintIsMint, force });
    // Keep the worker's idle timer reset while a scan is running (MV3 service workers sleep when idle).
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!port) return clearInterval(pingTimer);
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        clearInterval(pingTimer);
      }
    }, 20_000);
  }

  function check() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    const det = Sites?.detect(href);
    if (!det?.identifier) {
      // Not on a token page: hide the panel but keep state.
      if (panel) panel.host.style.display = 'none';
      current = null;
      stopLive();
      disconnect();
      return;
    }
    if (!panel) {
      panel = new Panel();
      panel.onRescan = () => current && connect(current.identifier, current.hintIsMint, true);
    }
    panel.host.style.display = '';
    if (current?.identifier === det.identifier) return;
    current = det;
    attempt = 0;
    stopLive();
    connect(det.identifier, det.hintIsMint);
  }

  window.addEventListener('pagehide', () => {
    disconnect();
    stopLive();
    current = null;
    lastHref = null;
  });

  api.storage?.sync?.get('settings').then((r) => {
    const s = r?.settings || {};
    if (s.enabled === false) return;
    check();
    setInterval(check, 500);
  });
})();
