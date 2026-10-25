# TickerPulse

The most-mentioned stocks on Reddit in the last 24 hours, with honest change metrics.
One Cloudflare Worker, no framework, no build step. The whole page with all ~700 stocks is ~19KB gzipped (~5KB of it is code).

## How it works

```
cron (every 5 min) → ApeWisdom API (all pages) → validate + derive → KV
request → Worker reads KV → HTML with data inlined (one request, one paint)
page → polls /data.json every 2 min while visible (ETag → 304 when unchanged)
```

- `src/data.js` fetches, validates and derives metrics. A snapshot is rejected (the old one is kept) if the
  ranking shifted while the pages were being fetched, which shows up as duplicate tickers or gaps.
- `src/worker.js` serves `/` and `/data.json`, and runs the cron.
- `src/index.html` is the page: inline CSS and JS, and rows are built with `textContent`.

## Metrics

| Column | Definition |
|---|---|
| 24h change | `mentions − mentions_24h_ago`. The % is shown only when the earlier count is ≥ 10 (`MIN_PCT_BASE`). |
| Momentum | `(now − before) / √(now + before)`, the z-score of the difference between two Poisson counts. |
| NEW | upstream `rank_24h_ago = 0` (the earlier count is treated as 0) |
| — | ranked 24h ago but upstream gave no count: unknown, **not** new |

## Run

```sh
npm install
npm test                 # unit tests (node:test, no deps)
npm run dev              # http://localhost:8787 ; trigger cron: curl "localhost:8787/__scheduled"
```

## Deploy (Cloudflare free plan)

```sh
npx wrangler login
npx wrangler kv namespace create SNAP   # paste the id into wrangler.toml
npm run deploy
```

The first request after deploy fills KV. After that only the cron calls ApeWisdom.
