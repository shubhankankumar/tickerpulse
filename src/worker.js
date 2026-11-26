import page from './index.html';
import robots from './robots.txt';
import { fetchSnapshot, embed, csp } from './data.js';

let policy; // computed once per isolate from the page's inline blocks

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
    // Most failures are transient (ApeWisdom hiccups, or ranks shifting between page fetches), so retry once.
    try {
      await refresh(env);
    } catch (e) {
      console.warn('refresh failed, retrying in 5 s:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
      await refresh(env); // a second failure still shows up as an error in the dashboard
    }
  },

  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    if (pathname === '/robots.txt') return new Response(robots, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
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
      'content-security-policy': await (policy ??= csp(page)),
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
