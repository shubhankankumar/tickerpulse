# TickerPulse

A single page that shows which stocks Reddit has been talking about the most over the last 24 hours, and which ones are suddenly being talked about a lot more than usual.

It's one Cloudflare Worker. No framework, no build step, no database apart from one KV key. The whole page, with around 700 stocks in it, is about 19 KB gzipped, and only about 5 KB of that is code.

## What's on the page

Every stock gets a row with its rank, ticker, company name, mentions, how that compares with the day before, upvotes and a momentum score. You can sort by any column, search by ticker or company name (press `/` to jump to the search box), and click a ticker to see the actual Reddit posts. Sort settings are kept in the URL so you can share a link to a particular view.

The page refreshes itself every 2 minutes while the tab is open. If the data hasn't been updated for a while, a warning shows up at the top so you know you're looking at old numbers.

## What the numbers mean

**Mentions** is how many posts and comments named the stock across investing subreddits in the last 24 hours. The counts come from [ApeWisdom](https://apewisdom.io).

**24h change** is mentions now minus mentions in the 24 hours before that. A percentage is shown only when the earlier count was at least 10, because going from 1 mention to 3 being "+200%" is just noise.

**Momentum** answers "is this change actually unusual, given how much this stock normally gets discussed?" Going from 1,000 to 1,100 mentions is nothing special, but going from 5 to 105 is. The formula treats both days as Poisson counts and takes the z-score of their difference:

```
momentum = (now - before) / sqrt(now + before)
```

Roughly, anything past 2 is a real jump. It's only highlighted when the two counts add up to at least 10 and the ticker isn't also an everyday word.

**The ? marker** means the ticker is also a common word, like IT, NOW, HR or AI. Its count probably includes comments that have nothing to do with the stock. The list of these words is picked by hand and lives in `WORDS` inside `index.html`.

**NEW** means the stock wasn't ranked at all 24 hours ago.

**A dash** means it was ranked 24 hours ago but ApeWisdom didn't give a count, so the change is unknown. That's different from new.

## How the data flows

```
every 15 minutes   cron → ApeWisdom (every page) → validate → store in KV
on a visit         Worker reads KV → sends HTML with the data already inside
while open         page asks /data.json every 2 minutes → 304 if nothing changed
```

ApeWisdom is only ever called by the cron job (and once right after the first deploy, when KV is still empty). Visitors never wait on it, so the page is fast even when ApeWisdom is slow.

ApeWisdom serves the list in pages, and the ranking can shift while those pages are being fetched. When that happens you get the same stock twice, or a missing rank. `src/data.js` checks for this and throws the whole snapshot away if the ranking isn't one clean list from 1 to N. The previous snapshot stays live, and the cron retries once after 5 seconds.

The page builds every row with `textContent`. The Worker also sends a strict content security policy, generated from hashes of the page's own inline script and style, so nothing from another site can load or run.

## Files

```
src/worker.js    serves / and /data.json, runs the cron
src/data.js      fetches from ApeWisdom, validates, works out the metrics
src/index.html   the page, with its CSS and JavaScript inline
test/            unit tests for data.js
wrangler.toml    Worker config, cron schedule and KV binding
```

## Run locally

```sh
npm install
npm test      # unit tests, also run by CI on every push and pull request
npm run dev
```

Then open http://localhost:8787. To fill it with data, trigger the cron by hand:

```sh
curl "localhost:8787/__scheduled"
```

## Deploy

It fits in Cloudflare's free plan. The cron writes to KV 96 times a day, and the free limit is 1,000.

```sh
npx wrangler login
npx wrangler kv namespace create SNAP
```

Put the namespace ID it prints into `wrangler.toml`, then:

```sh
npm run deploy
```

The first visit after deploying fills KV. From then on only the cron talks to ApeWisdom. Workers Logs are switched on in `wrangler.toml`, so errors from failed refreshes show up in the Cloudflare dashboard.

## Disclaimer

This counts how much people are talking about a stock. It says nothing about whether the stock is a good buy. Don't trade on it.
