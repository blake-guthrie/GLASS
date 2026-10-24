import http from 'node:http';
import { isBase58Address } from '../src/lib/base58.js';
import { INDEX_MAX_BYTES, validateSnapshot } from '../src/lib/shared-index.js';

/** Read-only public query routes. There is deliberately no upload/publish endpoint. */
export function indexServer(store, status, settings = {}) {
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'GET') return reply(405, { error: 'read-only' });
      if (req.url === '/v1/status') return reply(200, status());
      const match = /^\/v1\/reports\/([1-9A-HJ-NP-Za-km-z]+)$/.exec(req.url);
      if (!match || !isBase58Address(match[1])) return reply(404, { error: 'not-found' });
      const stored = await store.readReport(match[1]);
      if (!stored) {
        const job = store.state.jobs[match[1]];
        if (job) return reply(202, { schema: 1, mint: match[1], status: job.status, reason: job.reason || null,
          nextAttemptAt: job.status === 'queued' ? job.nextAt : null });
        return reply(404, { error: 'not-ready' });
      }
      const snapshot = validateSnapshot(stored, { mint: match[1], settings, maxAgeMs: Number.MAX_SAFE_INTEGER });
      if (!snapshot) return reply(503, { error: 'invalid-record' });
      const json = JSON.stringify(snapshot);
      if (Buffer.byteLength(json) > INDEX_MAX_BYTES) return reply(503, { error: 'invalid-record' });
      res.writeHead(200); res.end(json);
    } catch { if (!res.headersSent) reply(503, { error: 'index-unavailable' }); else res.end(); }
  });
}
