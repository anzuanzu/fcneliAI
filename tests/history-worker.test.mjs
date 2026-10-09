import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { historyTicker, normalizeHistory } from '../worker/src/history.js';

const env = { TWELVE_DATA_API_KEY: 'provider-secret', HISTORY_ACCESS_KEY: 'history-key', HISTORY_DISPLAY_LICENSE_CONFIRMED: 'true', ALLOWED_ORIGIN: 'https://anzuanzu.github.io' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
function fixture(symbol = 'AAPL', values = [
  { datetime: day(3), close: '99.00' }, { datetime: day(2), close: '101.25' }
]) {
  return { status: 'ok', meta: { symbol, interval: '1day', currency: 'USD', exchange_timezone: 'America/New_York' }, values };
}
function request(ticker = 'AAPL', key = 'history-key') {
  return new Request(`https://worker.example/api/history?ticker=${encodeURIComponent(ticker)}`, {
    headers: { Origin: env.ALLOWED_ORIGIN, ...(key ? { 'X-History-Key': key } : {}) }
  });
}
let moduleSequence = 0;
async function freshHandler() {
  return (await import(`../worker/src/history.js?test=${moduleSequence++}`)).handleHistory;
}
function mocks(upstream = url => json(fixture(url.searchParams.get('symbol')))) {
  const savedFetch = globalThis.fetch, savedCaches = globalThis.caches;
  const entries = new Map(), pending = [], calls = [];
  globalThis.caches = { default: {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => entries.set(key.url, response.clone())
  } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return upstream(new URL(url), init);
  };
  return {
    calls, entries, ctx: { waitUntil: task => pending.push(task) },
    flush: () => Promise.all(pending),
    restore: () => { globalThis.fetch = savedFetch; globalThis.caches = savedCaches; }
  };
}

test('history stays disabled without provider and private access secrets', async () => {
  const mock = mocks(() => { throw new Error('must not fetch'); });
  try {
    assert.equal((await worker.fetch(request(), {}, mock.ctx)).status, 503);
    const disabled = await worker.fetch(request(), { TWELVE_DATA_API_KEY: 'provider-secret' }, mock.ctx);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).code, 'HISTORY_ACCESS_NOT_CONFIGURED');
    assert.equal((await worker.fetch(request('AAPL', null), env, mock.ctx)).status, 401);
    const unconfirmed = await worker.fetch(request(), { ...env, HISTORY_DISPLAY_LICENSE_CONFIRMED: undefined }, mock.ctx);
    assert.equal(unconfirmed.status, 503);
    assert.equal((await unconfirmed.json()).code, 'HISTORY_LICENSE_NOT_CONFIRMED');
    const wrongOrigin = new Request(request(), { headers: { Origin: 'https://other.example', 'X-History-Key': 'history-key' } });
    assert.equal((await worker.fetch(wrongOrigin, env, mock.ctx)).status, 403);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('history accepts strict share-class symbols, rejects custom parameters and supports CORS', async () => {
  const mock = mocks();
  try {
    assert.equal(historyTicker(' brk/b '), 'BRK.B');
    for (const ticker of ['', 'AAPL,MSFT', 'https://evil.example', 'AAPL&apikey=bad']) {
      assert.equal(historyTicker(ticker), null);
      assert.equal((await worker.fetch(request(ticker), env, mock.ctx)).status, 400);
    }
    for (const query of ['ticker=AAPL&ticker=MSFT', 'ticker=AAPL&apikey=bad', 'ticker=AAPL&url=https://evil.example']) {
      const result = await worker.fetch(new Request(`https://worker.example/api/history?${query}`, { headers: { 'X-History-Key': 'history-key' } }), env, mock.ctx);
      assert.equal(result.status, 400);
    }
    const preflight = await worker.fetch(new Request('https://worker.example/api/history', { method: 'OPTIONS' }), env, mock.ctx);
    assert.ok(preflight.headers.get('Access-Control-Allow-Headers').includes('X-History-Key'));
    assert.equal((await worker.fetch(new Request(request(), { method: 'POST' }), env, mock.ctx)).status, 405);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('display license confirmation is mandatory before any cache read or provider credit use', async () => {
  const handle = await freshHandler(), mock = mocks(() => { throw new Error('must not fetch'); });
  let cacheReads = 0;
  globalThis.caches.default.match = async () => { cacheReads++; throw new Error('must not read cache'); };
  try {
    for (const confirmation of [undefined, 'false', 'TRUE', true]) {
      const result = await handle(request(), { ...env, HISTORY_DISPLAY_LICENSE_CONFIRMED: confirmation }, mock.ctx, {});
      assert.equal(result.status, 503);
      assert.equal((await result.json()).code, 'HISTORY_LICENSE_NOT_CONFIRMED');
    }
    assert.equal(mock.calls.length, 0);
    assert.equal(cacheReads, 0);
    assert.equal(mock.entries.size, 0);
  } finally { mock.restore(); }
});

test('fixed provider request uses header credentials and returns ascending split-adjusted prices privately', async () => {
  const handle = await freshHandler(), mock = mocks(url => json(fixture(url.searchParams.get('symbol'), [
    { datetime: day(2), close: '101.25' }, { datetime: day(3), close: 99 }
  ])));
  try {
    const result = await handle(request(), env, mock.ctx, {});
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
    const data = await result.json();
    assert.equal(data.adjustment, 'splits');
    assert.equal(data.source, 'Twelve Data');
    assert.equal(data.currency, 'USD');
    assert.deepEqual(data.bars, [{ date: day(3), close: 99 }, { date: day(2), close: 101.25 }]);
    assert.ok(data.warnings.some(text => text.startsWith('SPLITS_ONLY')));
    assert.ok(data.warnings.some(text => text.startsWith('SHORT_HISTORY')));
    assert.ok(!('iv' in data));
    assert.equal(mock.calls.length, 1);
    const { url, init } = mock.calls[0];
    assert.equal(url.origin, 'https://api.twelvedata.com');
    assert.equal(url.pathname, '/time_series');
    assert.equal(url.searchParams.get('interval'), '1day');
    assert.equal(url.searchParams.get('outputsize'), '600');
    assert.equal(url.searchParams.get('adjust'), 'splits');
    assert.equal(url.searchParams.get('country'), 'United States');
    assert.equal(init.headers.Authorization, 'apikey provider-secret');
    assert.equal(init.redirect, 'error');
    assert.ok(!url.toString().includes('secret'));
    assert.ok(!url.searchParams.has('apikey'));
    await mock.flush();
    assert.equal((await handle(request(), env, mock.ctx, {})).status, 200);
    assert.equal(mock.calls.length, 1);
    assert.equal((await handle(request('AAPL', null), env, mock.ctx, {})).status, 401);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.entries.size, 1);
    const cacheKey = [...mock.entries.keys()][0];
    assert.ok(!cacheKey.includes('provider-secret'));
    assert.ok(cacheKey.includes('schema=twelve-history-splits-v1'));
    assert.equal(mock.entries.get(cacheKey).headers.get('Cache-Control'), 'public, max-age=21600');
  } finally { mock.restore(); }
});

test('private options access key can be reused, but explicit history key takes precedence', async () => {
  const handle = await freshHandler(), mock = mocks();
  try {
    const fallbackEnv = { TWELVE_DATA_API_KEY: 'provider-secret', OPTIONS_ACCESS_KEY: 'options-key', HISTORY_DISPLAY_LICENSE_CONFIRMED: 'true' };
    assert.equal((await handle(request('AAPL', 'options-key'), fallbackEnv, mock.ctx, {})).status, 200);
    assert.equal((await handle(request('AAPL', 'options-key'), { ...fallbackEnv, HISTORY_ACCESS_KEY: 'different' }, mock.ctx, {})).status, 401);
  } finally { mock.restore(); }
});

test('normalization excludes current-session candles and rejects corrupt, future or mismatched data', () => {
  const now = Date.parse('2026-10-09T14:00:00Z');
  const rows = [{ datetime: '2026-10-07', close: '100.1' }, { datetime: '2026-10-08', close: '101.0' }, { datetime: '2026-10-09', close: '102.0' }];
  const normal = normalizeHistory(fixture('AAPL', rows), 'AAPL', now);
  assert.equal(normal.bars.length, 2);
  assert.equal(normal.bars.at(-1).date, '2026-10-08');
  assert.ok(normal.warnings.some(text => text.startsWith('CURRENT_SESSION_EXCLUDED')));
  for (const corrupt of [
    fixture('MSFT', rows), fixture('AAPL', [rows[0], rows[0]]),
    fixture('AAPL', [{ datetime: '2026-02-30', close: '100' }, rows[0]]),
    fixture('AAPL', [{ datetime: '2026-10-10', close: '100' }, rows[0]]),
    fixture('AAPL', [{ datetime: '2026-10-06', close: '' }, rows[0]]),
    fixture('AAPL', [{ datetime: '2026-10-06', close: 'NaN' }, rows[0]]),
    fixture('AAPL', [{ datetime: '2026-10-06', close: 0 }, rows[0]]),
    { ...fixture('AAPL', rows), meta: { ...fixture().meta, currency: 'CAD' } },
    { ...fixture('AAPL', rows), meta: { ...fixture().meta, exchange_timezone: 'Europe/London' } },
    fixture('AAPL', Array.from({ length: 601 }, () => rows[0]))
  ]) assert.throws(() => normalizeHistory(corrupt, 'AAPL', now), /HISTORY_UPSTREAM_FORMAT/);
  assert.throws(() => normalizeHistory(fixture('AAPL', [rows[0]]), 'AAPL', now), /HISTORY_UNAVAILABLE/);
});

test('provider HTTP and JSON errors remain sanitized and uncached', async () => {
  for (const [providerResponse, expectedStatus, code] of [
    [() => json({ message: 'provider-secret' }, 401), 502, 'HISTORY_PROVIDER_AUTH'],
    [() => json({ status: 'error', code: 429, message: 'provider-secret' }), 429, 'HISTORY_UPSTREAM_RATE_LIMIT'],
    [() => json({ status: 'error', code: 404, message: 'provider-secret' }), 404, 'HISTORY_UNAVAILABLE'],
    [() => new Response('{broken'), 502, 'HISTORY_UPSTREAM_FORMAT'],
    [() => json(fixture(), 200, { 'Content-Length': '1048577' }), 502, 'HISTORY_RESPONSE_TOO_LARGE'],
    [() => new Response('x'.repeat(1048577)), 502, 'HISTORY_RESPONSE_TOO_LARGE']
  ]) {
    const handle = await freshHandler(), mock = mocks(providerResponse);
    try {
      const result = await handle(request(), env, mock.ctx, {});
      assert.equal(result.status, expectedStatus);
      const body = await result.text();
      assert.ok(body.includes(code));
      assert.ok(!body.includes('provider-secret'));
      assert.equal(mock.entries.size, 0);
    } finally { mock.restore(); }
  }
});

test('same-ticker requests coalesce and limit new concurrent ticker refreshes', async () => {
  const handle = await freshHandler();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const mock = mocks(async url => { await gate; return json(fixture(url.searchParams.get('symbol'))); });
  try {
    const first = handle(request('AAPL'), env, mock.ctx, {});
    while (mock.calls.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    const same = handle(request('AAPL'), env, mock.ctx, {});
    const second = handle(request('MSFT'), env, mock.ctx, {});
    while (mock.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const busy = await handle(request('NVDA'), env, mock.ctx, {});
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).code, 'HISTORY_BUSY');
    release();
    const results = await Promise.all([first, same, second]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(mock.calls.length, 2);
  } finally { release(); mock.restore(); }
});

test('seven isolate-local starts per minute stop additional provider calls', async () => {
  const handle = await freshHandler(), mock = mocks(() => json({ status: 'error', code: 429 }));
  try {
    for (let index = 0; index < 7; index++) {
      const result = await handle(request(`STOCK${index}`), env, mock.ctx, {});
      assert.equal(result.status, 429);
      assert.equal((await result.json()).code, 'HISTORY_UPSTREAM_RATE_LIMIT');
    }
    const blocked = await handle(request('STOCK7'), env, mock.ctx, {});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');
    assert.equal((await blocked.json()).code, 'HISTORY_BUSY');
    assert.equal(mock.calls.length, 7);
  } finally { mock.restore(); }
});

test('upstream timeout aborts, fails explicitly and does not cache', async () => {
  const handle = await freshHandler(), savedTimeout = globalThis.setTimeout;
  const mock = mocks((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted provider-secret')), { once: true });
  }));
  // Exercise the actual timer/abort path without making the suite wait ten seconds.
  globalThis.setTimeout = (callback, ms, ...args) => savedTimeout(callback, ms === 10000 ? 5 : ms, ...args);
  try {
    const result = await handle(request(), env, mock.ctx, {});
    assert.equal(result.status, 504);
    assert.equal((await result.json()).code, 'HISTORY_UPSTREAM_TIMEOUT');
    assert.equal(mock.entries.size, 0);
  } finally { globalThis.setTimeout = savedTimeout; mock.restore(); }
});
