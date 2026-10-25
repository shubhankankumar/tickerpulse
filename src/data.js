// Fetches the ApeWisdom leaderboard and turns it into a compact, validated snapshot.
// Row layout (tuples keep the payload small; the page reads them by index):
//   [rank, ticker, name, mentions, upvotes, prevRank, prevMentions, delta, pct, z]
// prevRank     null = not ranked 24h ago (new entry)
// prevMentions null = unknown (upstream gave no count); 0 for new entries
// delta/z      null when prevMentions is unknown
// pct          null when prevMentions < MIN_PCT_BASE, where a % change is noise

const API = 'https://apewisdom.io/api/v1.0/filter/all-stocks/page/';
const MAX_PAGES = 40; // Workers allow 50 subrequests per invocation
export const MIN_PCT_BASE = 10;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Upstream escapes some names (S&amp;P) and not others (AT&T); decode once.
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const hex = e[1] === 'x' || e[1] === 'X';
    const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function int(v, field) {
  if (!Number.isSafeInteger(v)) throw new Error(`${field} is not an integer: ${JSON.stringify(v)}`);
  return v;
}

export function toRow(r) {
  const rank = int(r.rank, 'rank');
  const mentions = int(r.mentions, 'mentions');
  const upvotes = int(r.upvotes, 'upvotes'); // can legitimately be negative (downvoted posts)
  if (typeof r.ticker !== 'string' || !/^[A-Z0-9.\-]{1,12}$/.test(r.ticker)) throw new Error(`bad ticker: ${JSON.stringify(r.ticker)}`);
  if (mentions < 0) throw new Error(`negative mentions for ${r.ticker}`);
  const name = typeof r.name === 'string' ? decodeEntities(r.name).trim() : r.ticker;

  const rank24 = r.rank_24h_ago ?? 0;
  const prevRank = int(rank24, 'rank_24h_ago') > 0 ? rank24 : null;
  const prevMentions = r.mentions_24h_ago != null ? int(r.mentions_24h_ago, 'mentions_24h_ago') : prevRank === null ? 0 : null;

  let delta = null, pct = null, z = null;
  if (prevMentions !== null) {
    delta = mentions - prevMentions;
    if (prevMentions >= MIN_PCT_BASE) pct = Math.round((delta / prevMentions) * 100);
    // Difference of two Poisson counts: z = (a - b) / sqrt(a + b). |z| >= 2 is an unusual move.
    const n = mentions + prevMentions;
    z = n === 0 ? 0 : Math.round((delta / Math.sqrt(n)) * 100) / 100;
  }
  return [rank, r.ticker, name || r.ticker, mentions, upvotes, prevRank, prevMentions, delta, pct, z];
}

// Pages are fetched separately, so the list can shift between requests. Reject anything that
// isn't one clean, gap-free ranking rather than publish duplicated or missing stocks.
export function buildSnapshot(pages, now) {
  const raw = pages.flatMap((p, i) => {
    if (!Array.isArray(p?.results)) throw new Error(`page ${i + 1} has no results array`);
    return p.results;
  });
  if (raw.length === 0) throw new Error('upstream returned an empty list');
  if (raw.length !== pages[0].count) throw new Error(`expected ${pages[0].count} rows, got ${raw.length}`);
  const seen = new Set();
  raw.forEach((r, i) => {
    if (r?.rank !== i + 1) throw new Error(`rank ${i + 1} out of order (got ${r?.rank}); list shifted mid-fetch`);
    if (seen.has(r.ticker)) throw new Error(`duplicate ticker ${r.ticker}; list shifted mid-fetch`);
    seen.add(r.ticker);
  });

  const rows = [];
  for (const r of raw) {
    try {
      rows.push(toRow(r));
    } catch (e) {
      console.warn(`dropping row ${r.rank}: ${e.message}`);
    }
  }
  return { t: now, rows };
}

async function getPage(fetchFn, n) {
  const res = await fetchFn(API + n, {
    headers: { accept: 'application/json', 'user-agent': 'TickerPulse/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ApeWisdom page ${n}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchSnapshot(fetchFn = fetch, now = Date.now()) {
  const first = await getPage(fetchFn, 1);
  const pages = first?.pages;
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES) throw new Error(`bad page count: ${pages}`);
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getPage(fetchFn, i + 2)));
  return buildSnapshot([first, ...rest], now);
}

// JSON inside <script> must not contain "</script>"; "<" only appears inside strings, where < is equivalent.
export const embed = (json) => json.replace(/</g, '\\u003c');
