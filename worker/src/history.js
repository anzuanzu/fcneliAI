// Private historical-price research. No options IV or public redistribution.
// https://support.twelvedata.com/en/articles/5179064-are-the-prices-adjusted
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';
const SCHEMA = 'twelve-history-splits-v1';
const MAX_BARS = 600;
const MAX_BYTES = 1024 * 1024;
const CACHE_SECONDS = 21600;
const TIMEOUT_MS = 10000;
// Isolate-local limits reserve capacity below Basic's 8/min and 800/day.
// They cannot enforce one account quota across different Cloudflare edges.
const inFlight = new Map();
let requestStarts = [];
let dailyBudget = { date: '', starts: 0 };

export function historyTicker(value) {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{0,9}(?:[./][A-Z0-9]{1,2})?$/.test(ticker) ? ticker.replace('/', '.') : null;
}

function respond(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }
  });
}
function failure(code, status, headers, error = 'Historical prices are unavailable. Check the Worker configuration or retry later.') {
  return respond({ schemaVersion: 1, code, error, bars: [] }, status, headers);
}
class HistoryError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
function dateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function marketDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function dateRange(now) {
  const today = marketDate(now);
  const endDate = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  // ACT-day range accommodates leap years and stays within MAX_BARS weekdays.
  const startDate = new Date(Date.parse(today) - 731 * 86400000).toISOString().slice(0, 10);
  return { today, startDate, endDate };
}
function closeNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1e9 ? number : null;
}

export function normalizeHistory(data, ticker, now = Date.now()) {
  const { today, startDate } = dateRange(now);
  if (!data || typeof data !== 'object' || data.status !== 'ok' || !data.meta ||
    historyTicker(data.meta.symbol) !== ticker || data.meta.interval !== '1day' ||
    data.meta.currency !== 'USD' || data.meta.exchange_timezone !== 'America/New_York' ||
    !Array.isArray(data.values) || data.values.length > MAX_BARS)
    throw new HistoryError('HISTORY_UPSTREAM_FORMAT');
  const bars = [], dates = new Set();
  let excludedCurrent = false;
  for (const row of data.values) {
    if (!row || !dateOnly(row.datetime) || dates.has(row.datetime) || row.datetime > today)
      throw new HistoryError('HISTORY_UPSTREAM_FORMAT');
    dates.add(row.datetime);
    const close = closeNumber(row.close);
    if (close === null) throw new HistoryError('HISTORY_UPSTREAM_FORMAT');
    // Never use a potentially partial current-session candle as a daily return.
    if (row.datetime === today) { excludedCurrent = true; continue; }
    if (row.datetime >= startDate) bars.push({ date: row.datetime, close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 2) throw new HistoryError('HISTORY_UNAVAILABLE', 404);
  const warnings = [
    'ESTIMATED_VOLATILITY_ONLY: Daily historical closes are not market option implied volatility.',
    'SPLITS_ONLY: Prices request split adjustment, not dividend adjustment; ex-dividend moves and corporate-action timing can affect estimates.',
    'DAILY_CLOSE_ONLY: Latest completed daily bar is used, not a live underlying quote.'
  ];
  if (excludedCurrent) warnings.push('CURRENT_SESSION_EXCLUDED: The provider current-session candle was excluded.');
  if (bars.length < 253) warnings.push('SHORT_HISTORY: Fewer than 253 daily closes; a full 252-return window is unavailable.');
  if (Date.parse(today) - Date.parse(bars.at(-1).date) > 7 * 86400000)
    warnings.push('STALE_HISTORY: Last daily close is more than 7 calendar days old; verify trading status and source coverage.');
  return {
    schemaVersion: 1, ticker, source: 'Twelve Data', adjustment: 'splits',
    asOf: new Date(now).toISOString(), timezone: data.meta.exchange_timezone,
    currency: data.meta.currency, bars, warnings
  };
}

async function boundedJson(upstream) {
  if (Number(upstream.headers.get('Content-Length')) > MAX_BYTES || !upstream.body)
    throw new HistoryError('HISTORY_RESPONSE_TOO_LARGE');
  const reader = upstream.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new HistoryError('HISTORY_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HistoryError('HISTORY_UPSTREAM_FORMAT'); }
}
function providerFailure(code) {
  const n = Number(code);
  if (n === 429) return new HistoryError('HISTORY_UPSTREAM_RATE_LIMIT', 429);
  if (n === 401 || n === 403) return new HistoryError('HISTORY_PROVIDER_AUTH');
  if (n === 400 || n === 404) return new HistoryError('HISTORY_UNAVAILABLE', 404);
  return new HistoryError('HISTORY_UPSTREAM_FAILED');
}
async function loadHistory(ticker, token, now) {
  const { startDate, endDate } = dateRange(now);
  const url = new URL(PROVIDER_URL);
  Object.entries({
    symbol: ticker, country: 'United States', interval: '1day', outputsize: MAX_BARS,
    start_date: startDate, end_date: endDate, adjust: 'splits', order: 'ASC', format: 'JSON'
  }).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `apikey ${token}` },
      signal: controller.signal, redirect: 'error'
    });
    // Do not forward provider error text or URLs; credentials remain server-side.
    if (!upstream.ok) throw providerFailure(upstream.status);
    const data = await boundedJson(upstream);
    if (data?.status === 'error') throw providerFailure(data.code);
    return normalizeHistory(data, ticker, now);
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError(controller.signal.aborted ? 'HISTORY_UPSTREAM_TIMEOUT' : 'HISTORY_UPSTREAM_FAILED', controller.signal.aborted ? 504 : 502);
  } finally { clearTimeout(timer); }
}
async function scopeFor(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Configuration only: never contact the provider, inspect cached prices, or echo secrets.
export function handleHistoryStatus(request, env, headers) {
  if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, headers, 'Use GET /api/history/status.');
  const origin = request.headers.get('Origin');
  if (origin && env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN)
    return failure('HISTORY_ORIGIN_DENIED', 403, headers);
  if (new URL(request.url).search)
    return failure('INVALID_QUERY', 400, headers, 'The configuration check accepts no query parameters.');
  const accessKey = env.HISTORY_ACCESS_KEY || env.OPTIONS_ACCESS_KEY;
  const suppliedKey = request.headers.get('X-History-Key');
  const providerConfigured = Boolean(env.TWELVE_DATA_API_KEY);
  const accessConfigured = Boolean(accessKey);
  const usageConfirmed = env.HISTORY_DISPLAY_LICENSE_CONFIRMED === 'true';
  return respond({
    schemaVersion: 1, kind: 'history-configuration', source: 'Twelve Data',
    providerConfigured, accessConfigured, usageConfirmed,
    accessVerified: suppliedKey ? Boolean(accessKey && suppliedKey === accessKey) : null,
    configurationReady: providerConfigured && accessConfigured && usageConfirmed,
    providerConnectionTested: false
  }, 200, headers);
}

export async function handleHistory(request, env, ctx, headers) {
  if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, headers, 'Use GET /api/history?ticker=SYMBOL.');
  if (!env.TWELVE_DATA_API_KEY) return failure('HISTORY_NOT_CONFIGURED', 503, headers, 'Add TWELVE_DATA_API_KEY as a Worker secret to enable automatic daily history.');
  const accessKey = env.HISTORY_ACCESS_KEY || env.OPTIONS_ACCESS_KEY;
  if (!accessKey) return failure('HISTORY_ACCESS_NOT_CONFIGURED', 503, headers, 'Set a private HISTORY_ACCESS_KEY. Individual data plans do not grant public redistribution rights.');
  if (request.headers.get('X-History-Key') !== accessKey)
    return failure('HISTORY_ACCESS_REQUIRED', 401, headers, 'Enter the private history access key; do not enter the provider API key in the website.');
  if (env.HISTORY_DISPLAY_LICENSE_CONFIRMED !== 'true')
    return failure('HISTORY_LICENSE_NOT_CONFIRMED', 503, headers,
      'Confirm that your account permits this personal research and private display before enabling history. This setting does not verify account permissions or require a commercial subscription.');
  const origin = request.headers.get('Origin');
  if (origin && env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN)
    return failure('HISTORY_ORIGIN_DENIED', 403, headers);
  const url = new URL(request.url), ticker = historyTicker(url.searchParams.get('ticker'));
  if (!ticker || url.searchParams.getAll('ticker').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ticker'))
    return failure('INVALID_TICKER', 400, headers, 'Provide one US ticker; batches and custom query parameters are not accepted.');
  try {
    const now = Date.now(), date = marketDate(now), scope = await scopeFor(env.TWELVE_DATA_API_KEY);
    const cacheUrl = new URL('/api/history', url.origin);
    Object.entries({ schema: SCHEMA, ticker, date, scope }).forEach(([name, value]) => cacheUrl.searchParams.set(name, value));
    const cacheKey = new Request(cacheUrl.toString());
    const cached = await caches.default.match(cacheKey);
    if (cached) return respond(await cached.json(), 200, headers);
    const taskKey = `${scope}:${date}:${ticker}`;
    let task = inFlight.get(taskKey);
    if (!task) {
      requestStarts = requestStarts.filter(time => now - time < 60000);
      const utcDate = new Date(now).toISOString().slice(0, 10);
      if (dailyBudget.date !== utcDate) dailyBudget = { date: utcDate, starts: 0 };
      if (inFlight.size >= 2 || requestStarts.length >= 7 || dailyBudget.starts >= 700)
        return failure('HISTORY_BUSY', 429, { ...headers, 'Retry-After': '60' }, 'History refresh quota is busy. Retry later; cache hits do not use provider credits.');
      requestStarts.push(now); dailyBudget.starts++;
      task = loadHistory(ticker, env.TWELVE_DATA_API_KEY, now);
      inFlight.set(taskKey, task);
      task.finally(() => inFlight.delete(taskKey)).catch(() => {});
    }
    const data = await task;
    const cacheResponse = respond(data, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    // Cache API entry is internal. Browser responses always remain private.
    cacheResponse.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    ctx.waitUntil(caches.default.put(cacheKey, cacheResponse));
    return respond(data, 200, headers);
  } catch (error) {
    const code = error instanceof HistoryError ? error.code : 'HISTORY_UPSTREAM_FAILED';
    const status = error instanceof HistoryError ? error.status : 502;
    return failure(code, status, status === 429 ? { ...headers, 'Retry-After': '60' } : headers);
  }
}
