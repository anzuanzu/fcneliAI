import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { canonicalTicker, selectExpirations } from '../worker/src/options.js';
import { validateSnapshot } from '../assets/iv-engine.mjs';

const env = { TRADIER_TOKEN: 'broker-secret', OPTIONS_ACCESS_KEY: 'personal-key', ALLOWED_ORIGIN: 'https://anzuanzu.github.io' };
const origin = env.ALLOWED_ORIGIN;
function request(ticker = 'AAPL', key = env.OPTIONS_ACCESS_KEY) {
  return new Request(`https://worker.example/api/options?ticker=${encodeURIComponent(ticker)}`, {
    headers: { Origin: origin, ...(key ? { 'X-Options-Key': key } : {}) }
  });
}
function installMocks(upstream) {
  const savedFetch = globalThis.fetch, savedCaches = globalThis.caches;
  const entries = new Map(), pending = [], calls = [];
  globalThis.caches = { default: {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, value) => { entries.set(key.url, value.clone()); }
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
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const futureExpiry = () => new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10);
function contract(extra = {}) {
  return {
    underlying: 'AAPL', expiration_date: futureExpiry(), strike: 100, option_type: 'put',
    bid: 2, ask: 2.2, bid_date: Date.now(), ask_date: Date.now(), volume: 50, open_interest: 300,
    greeks: { mid_iv: 0.3577, updated_at: '2026-10-09 13:59:03' }, ...extra
  };
}
function provider(rows = [contract()]) {
  return url => {
    if (url.pathname.endsWith('/quotes')) return json({ quotes: { quote: { symbol: 'AAPL', last: 105, trade_date: Date.now() } } });
    if (url.pathname.endsWith('/expirations')) return json({ expirations: { date: [futureExpiry()] } });
    if (url.pathname.endsWith('/chains')) return json({ options: { option: rows } });
    throw new Error('Unexpected provider endpoint');
  };
}

test('unconfigured endpoint never substitutes volatility or contacts a provider', async () => {
  const mock = installMocks(() => { throw new Error('must not call'); });
  try {
    const result = await worker.fetch(request(), {}, mock.ctx);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, 'OPTIONS_NOT_CONFIGURED');
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('account data defaults closed; a key is required even on a cache hit', async () => {
  const mock = installMocks(provider());
  try {
    const disabled = await worker.fetch(request(), { TRADIER_TOKEN: env.TRADIER_TOKEN }, mock.ctx);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).code, 'OPTIONS_ACCESS_NOT_CONFIGURED');
    const unauthenticated = await worker.fetch(request('AAPL', null), env, mock.ctx);
    assert.equal(unauthenticated.status, 401);
    const deniedOrigin = await worker.fetch(new Request(request(), { headers: { Origin: 'https://other.example', 'X-Options-Key': 'personal-key' } }), env, mock.ctx);
    assert.equal(deniedOrigin.status, 403);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('ticker validation accepts share classes and rejects injection/lists/custom queries', async () => {
  assert.equal(canonicalTicker(' brk.b '), 'BRK/B');
  assert.equal(canonicalTicker('AAPL,MSFT'), null);
  assert.equal(canonicalTicker('https://evil.test'), null);
  assert.equal(canonicalTicker('AAPL&token=123'), null);
  const mock = installMocks(provider());
  try {
    for (const invalid of ['AAPL,MSFT', '', '../secret']) {
      const result = await worker.fetch(request(invalid), env, mock.ctx);
      assert.equal(result.status, 400);
    }
    const result = await worker.fetch(new Request('https://worker.example/api/options?ticker=AAPL&url=https://evil.test', { headers: { 'X-Options-Key': 'personal-key' } }), env, mock.ctx);
    assert.equal(result.status, 400);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('normalizes actual decimal IV, preserves ambiguous provider timestamp, and caches privately', async () => {
  const mock = installMocks(provider());
  try {
    const result = await worker.fetch(request(), env, mock.ctx);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
    const data = await result.json();
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.source, 'Tradier / ORATS');
    assert.equal(data.ivUnit, 'annualized-decimal');
    assert.equal(data.contracts[0].iv, 0.3577);
    assert.equal(data.contracts[0].ivAsOf, '2026-10-09 13:59:03');
    assert.equal(data.contracts[0].ivTimestampTimezone, 'unspecified');
    assert.ok(data.spotAsOf.endsWith('Z'));
    assert.ok(data.contracts[0].quoteAsOf.endsWith('Z'));
    assert.ok(data.warnings.some(item => item.startsWith('IV_TIMEZONE_UNSPECIFIED')));
    assert.ok(data.warnings.some(item => item.startsWith('HOURLY_IV')));
    assert.equal(mock.calls.length, 3);
    for (const call of mock.calls) {
      assert.equal(call.url.hostname, 'api.tradier.com');
      assert.equal(call.init.headers.Authorization, 'Bearer broker-secret');
      assert.equal(call.init.redirect, 'error');
      assert.ok(!call.url.toString().includes('broker-secret'));
    }
    assert.equal(mock.calls.find(call => call.url.pathname.endsWith('/chains')).url.searchParams.get('greeks'), 'true');
    await mock.flush();
    assert.equal((await worker.fetch(request(), env, mock.ctx)).status, 200);
    assert.equal(mock.calls.length, 3);
    assert.equal((await worker.fetch(request('AAPL', null), env, mock.ctx)).status, 401);
    assert.equal(mock.calls.length, 3);
    const keys = [...mock.entries.keys()];
    assert.ok(keys[0].includes('schema=tradier-options-v1'));
    assert.ok(!keys[0].includes('broker-secret'));
  } finally { mock.restore(); }
});

test('provider authentication errors are sanitized and not cached', async () => {
  const mock = installMocks(() => json({ secret: 'broker-secret' }, 401));
  try {
    const result = await worker.fetch(request(), env, mock.ctx);
    assert.equal(result.status, 502);
    const body = await result.text();
    assert.ok(body.includes('OPTIONS_PROVIDER_AUTH'));
    assert.ok(!body.includes('broker-secret'));
    assert.equal(mock.entries.size, 0);
  } finally { mock.restore(); }
});

test('actual normalized adapter response is accepted by the shared research engine', async () => {
  const timestamp = new Date().toISOString();
  const mock = installMocks(provider([contract({ greeks: { mid_iv: 0.3, updated_at: timestamp } })]));
  try {
    const result = await worker.fetch(request(), env, mock.ctx);
    assert.equal(result.status, 200);
    const actualAdapterResponse = await result.json();
    const snapshot = validateSnapshot(actualAdapterResponse);
    assert.equal(snapshot.ticker, 'AAPL');
    assert.equal(snapshot.source, 'Tradier / ORATS');
    assert.equal(snapshot.ivUnit, 'annualized-decimal');
    assert.equal(snapshot.contracts.length, 1);
    assert.equal(snapshot.contracts[0].iv, 0.3);
    assert.equal(snapshot.contracts[0].ivAsOf, timestamp);
    assert.equal(snapshot.contracts[0].ivTimestampTimezone, 'explicit');
    assert.equal(snapshot.spot, actualAdapterResponse.spot);
    assert.equal(snapshot.spotAsOf, actualAdapterResponse.spotAsOf);
  } finally { mock.restore(); }
});

test('malformed provider schemas fail instead of returning fabricated data', async () => {
  const mock = installMocks(() => json({ unexpected: true }));
  try {
    const result = await worker.fetch(request(), env, mock.ctx);
    assert.equal(result.status, 502);
    assert.equal((await result.json()).code, 'OPTIONS_UPSTREAM_FORMAT');
  } finally { mock.restore(); }
});

test('missing IV stays null and nonstandard/wrong-underlying contracts are excluded', async () => {
  const mock = installMocks(provider([
    contract({ greeks: {} }), contract({ strike: 95, greeks: { mid_iv: '0.3', updated_at: 'bad' } }),
    contract({ underlying: 'MSFT' }), contract({ contract_size: 10 }), contract({ strike: -1 })
  ]));
  try {
    const result = await worker.fetch(request(), env, mock.ctx);
    const data = await result.json();
    assert.equal(result.status, 200);
    assert.equal(data.contracts.length, 2);
    assert.ok(data.contracts.every(item => item.iv === null && item.ivAsOf === null));
    assert.ok(data.warnings.some(item => item.startsWith('MISSING_IV')));
    assert.ok(data.warnings.some(item => item.startsWith('NONSTANDARD_CONTRACTS')));
  } finally { mock.restore(); }
});

test('monthly expiry selection is sorted, deduplicated, bounded and avoids distant chains', () => {
  const now = Date.UTC(2026, 0, 1);
  const dates = Array.from({ length: 52 }, (_, i) => new Date(now + (i + 1) * 7 * 86400000).toISOString().slice(0, 10));
  const selected = selectExpirations([...dates, dates[0], 'malformed', '2026-02-31'], now);
  assert.equal(selected.length, 9);
  assert.deepEqual(selected, [...new Set(selected)].sort());
  assert.ok(selected.every(date => Date.parse(date) - now >= 14 * 86400000));
  assert.ok(selected.every(date => Date.parse(date) - now <= 310 * 86400000));
});

test('public data must be explicitly enabled and expiry fanout never exceeds eleven calls', async () => {
  const { handleOptions } = await import('../worker/src/options.js?fanout-test');
  const dates = Array.from({ length: 52 }, (_, i) => new Date(Date.now() + (i + 1) * 7 * 86400000).toISOString().slice(0, 10));
  const mock = installMocks(url => {
    if (url.pathname.endsWith('/quotes')) return json({ quotes: { quote: { symbol: 'AAPL', last: 105, trade_date: Date.now() } } });
    if (url.pathname.endsWith('/expirations')) return json({ expirations: { date: dates } });
    return json({ options: { option: [] } });
  });
  try {
    const result = await handleOptions(request('AAPL', null), { TRADIER_TOKEN: env.TRADIER_TOKEN, ALLOW_PUBLIC_OPTIONS: 'true' }, mock.ctx, {});
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.expirations.length, 9);
    assert.equal(mock.calls.length, 11);
    assert.ok(!mock.calls.some(call => call.url.searchParams.has('token')));
  } finally { mock.restore(); }
});

test('isolate refresh budget limits uncached ticker requests before further provider use', async () => {
  const { handleOptions } = await import('../worker/src/options.js?budget-test');
  const mock = installMocks(() => json({ sensitiveProviderDetail: true }, 429));
  try {
    for (let i = 0; i < 6; i++) {
      const result = await handleOptions(request(`STOCK${i}`), env, mock.ctx, {});
      assert.equal(result.status, 502);
      assert.equal((await result.json()).code, 'OPTIONS_UPSTREAM_RATE_LIMIT');
    }
    const count = mock.calls.length;
    const blocked = await handleOptions(request('STOCK6'), env, mock.ctx, {});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');
    assert.equal((await blocked.json()).code, 'OPTIONS_BUSY');
    assert.equal(mock.calls.length, count);
  } finally { mock.restore(); }
});

test('existing scan route/payload/cache stay unchanged and preflight accepts the personal key', async () => {
  const mock = installMocks((url, init) => {
    assert.equal(url.toString(), 'https://scanner.tradingview.com/america/scan');
    assert.equal(init.method, 'POST');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.filter, [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }]);
    assert.ok(payload.columns.includes('Volatility.W'));
    return json({ data: [{ s: 'NASDAQ:AAPL', d: ['AAPL'] }], totalCount: 1 });
  });
  try {
    const preflight = await worker.fetch(new Request('https://worker.example/api/options', { method: 'OPTIONS', headers: { Origin: origin } }), env, mock.ctx);
    assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('GET'));
    assert.ok(preflight.headers.get('Access-Control-Allow-Headers').includes('X-Options-Key'));
    const scan = new Request('https://worker.example/api/scan', { method: 'POST', headers: { Origin: origin } });
    const result = await worker.fetch(scan, env, mock.ctx);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data[0].s, 'NASDAQ:AAPL');
    await mock.flush();
    assert.equal((await worker.fetch(scan, env, mock.ctx)).status, 200);
    assert.equal(mock.calls.length, 1);
    assert.equal((await worker.fetch(new Request('https://worker.example/api/scan'), env, mock.ctx)).status, 405);
  } finally { mock.restore(); }
});
