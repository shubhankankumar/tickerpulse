import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, toRow, buildSnapshot, fetchSnapshot, embed } from '../src/data.js';

const raw = (o) => ({ rank: 1, ticker: 'NVDA', name: 'NVIDIA', mentions: 10, upvotes: 5, rank_24h_ago: 3, mentions_24h_ago: 8, ...o });

test('decodeEntities handles escaped and raw ampersands', () => {
  assert.equal(decodeEntities('SPDR S&amp;P 500'), 'SPDR S&P 500');
  assert.equal(decodeEntities('AT&T'), 'AT&T');
  assert.equal(decodeEntities('Lowe&#39;s &#x26; Co &bogus;'), "Lowe's & Co &bogus;");
});

test('toRow derives delta, pct and momentum', () => {
  // 30 vs 10: delta 20, +200%, z = 20/sqrt(40)
  assert.deepEqual(toRow(raw({ mentions: 30, mentions_24h_ago: 10 })), [1, 'NVDA', 'NVIDIA', 30, 5, 3, 10, 20, 200, 3.16]);
});

test('toRow hides pct below the minimum base', () => {
  const r = toRow(raw({ mentions: 18, mentions_24h_ago: 6 }));
  assert.equal(r[7], 12);
  assert.equal(r[8], null);
});

test('rank_24h_ago 0 means new: prev mentions count as 0', () => {
  const r = toRow(raw({ mentions: 4, rank_24h_ago: 0, mentions_24h_ago: null }));
  assert.deepEqual(r.slice(5), [null, 0, 4, null, 2]);
});

test('ranked 24h ago but mentions null means unknown, not new', () => {
  const r = toRow(raw({ rank_24h_ago: 131, mentions_24h_ago: null }));
  assert.deepEqual(r.slice(5), [131, null, null, null, null]);
});

test('toRow rejects garbage', () => {
  assert.throws(() => toRow(raw({ mentions: '10' })));
  assert.throws(() => toRow(raw({ ticker: '<script>' })));
  assert.throws(() => toRow(raw({ mentions: -1 })));
});

const page = (rows, count = rows.length) => ({ count, results: rows });

test('buildSnapshot accepts a clean ranking and drops bad rows', () => {
  const s = buildSnapshot([page([raw({}), raw({ rank: 2, ticker: 'TSLA', upvotes: 1.5 })])], 42);
  assert.equal(s.t, 42);
  assert.deepEqual(s.rows.map((r) => r[1]), ['NVDA']);
});

test('buildSnapshot rejects lists that shifted mid-fetch', () => {
  assert.throws(() => buildSnapshot([page([raw({}), raw({ rank: 2 })])], 0), /duplicate/);
  assert.throws(() => buildSnapshot([page([raw({}), raw({ rank: 3, ticker: 'X' })])], 0), /out of order/);
  assert.throws(() => buildSnapshot([page([raw({})], 2)], 0), /expected 2/);
  assert.throws(() => buildSnapshot([page([])], 0), /empty/);
});

test('fetchSnapshot walks every page', async () => {
  const pages = { 1: { count: 2, pages: 2, results: [raw({})] }, 2: { count: 2, pages: 2, results: [raw({ rank: 2, ticker: 'TSLA' })] } };
  const fake = async (url) => ({ ok: true, json: async () => pages[url.split('/').pop()] });
  const s = await fetchSnapshot(fake, 1);
  assert.deepEqual(s.rows.map((r) => r[1]), ['NVDA', 'TSLA']);
});

test('fetchSnapshot fails on HTTP errors and absurd page counts', async () => {
  await assert.rejects(fetchSnapshot(async () => ({ ok: false, status: 502 }), 1), /502/);
  await assert.rejects(fetchSnapshot(async () => ({ ok: true, json: async () => ({ pages: 9999 }) }), 1), /page count/);
});

test('embed cannot break out of the script tag', () => {
  assert.equal(embed('{"n":"</script><b>"}'), '{"n":"\\u003c/script>\\u003cb>"}');
  assert.deepEqual(JSON.parse(embed('{"n":"</script>"}')), { n: '</script>' });
});
