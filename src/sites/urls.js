// Site adapters: turn a terminal URL into { site, identifier, hintIsMint }.
// Plain script (no imports) so it can be loaded as a content script alongside content.js, and
// imported for its side effect (globalThis.GlassSites) in tests.
(() => {
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const isAddr = (s) => typeof s === 'string' && B58.test(s);

  const SITES = [
    {
      name: 'pump.fun',
      host: /(^|\.)pump\.fun$/,
      parse(u) {
        const parts = u.pathname.split('/').filter(Boolean);
        // Only token pages: /coin/<mint>. Profiles (/profile/<wallet>), boards, livestreams carry
        // wallet addresses that are not tokens.
        const i = parts.indexOf('coin');
        if (i < 0) return null;
        const id = parts[i + 1];
        return isAddr(id) ? { identifier: id, hintIsMint: true } : null;
      },
    },
    {
      name: 'axiom',
      host: /(^|\.)axiom\.trade$/,
      parse(u) {
        const parts = u.pathname.split('/').filter(Boolean);
        const i = parts.indexOf('meme');
        const id =
