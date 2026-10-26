import page from './index.html';
import { fetchSnapshot, embed } from './data.js';

const KEY = 'snapshot';

// Upstream is only ever hit by the cron (and once, on an empty KV after first deploy),
// so request latency doesn't depend on ApeWisdom.
async function refresh(env) {
  const snap = await fetchSnapshot();
  const value = JSON.stringify(snap);
  await env.SNAP.put(KEY, value, { metadata: { t: snap.t } });
  return { value, metadata: { t: snap.t } };
}

async function load(env) {
  const hit = await env.SNAP.getWithMetadata(KEY, { cacheTtl: 60 });
  return hit.value === null ? refresh(env) : hit;
}

export default {
  async scheduled(_event, env) {
    // A failed run keeps the previous snapshot; the page shows a staleness warning if it persists.
    await refresh(env);
  },

  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    if (pathname !== '/' && pathname !== '/data.json') return new Response('Not found', { status: 404 });

    let snap;
    try {
      snap = await load(env);
    } catch (e) {
      console.error(e);
      return new Response('Data temporarily unavailable', { status: 503, headers: { 'retry-after': '60' } });
    }

    const headers = {
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      // Defense in depth: rows are rendered with textContent; this also blocks framing and any off-site loads.
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    if (pathname === '/data.json') {
      const etag = `"${snap.metadata.t}"`;
      // Cloudflare weakens ETags on compressed responses, so the browser sends back W/"…".
      if (req.headers.get('if-none-match')?.replace(/^W\//, '') === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
      return new Response(snap.value, { headers: { ...headers, etag, 'content-type': 'application/json; charset=utf-8' } });
    }
    // Function replacer: a string replacement would interpret "$&" etc. inside the data.
    const html = page.replace('__DATA__', () => embed(snap.value));
    return new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  },
};
