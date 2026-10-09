// Personal research data only. Production brokerage endpoint is deliberately fixed.
// Provider docs: https://docs.tradier.com/docs/market-data
const BASE_URL = 'https://api.tradier.com/v1/markets/';
const SCHEMA = 'tradier-options-v1';
const MAX_EXPIRIES = 9;
const MAX_CONTRACTS = 8000;
const MAX_CHAIN_ROWS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_SECONDS = 300;
const REQUEST_DEADLINE_MS = 25000;
const UPSTREAM_TIMEOUT_MS = 6000;
// Per-isolate safeguards are not a global account quota. See DEPLOYMENT.md.
const inFlight = new Map();
let requestStarts = [];

function response(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }
  });
}

function failure(code, error, status, headers) {
  return response({ schemaVersion: 1, code, error, contracts: [] }, status, headers);
}

export function canonicalTicker(input) {
  if (typeof input !== 'string') return null;
  const ticker = input.trim().toUpperCase();
  // Tradier uses slash for share classes; never accept lists or arbitrary URLs.
  return /^[A-Z][A-Z0-9]{0,9}(?:[./][A-Z0-9]{1,2})?$/.test(ticker) ? ticker.replace('.', '/') : null;
}

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

function epochTime(value) {
  const n = finite(value);
  if (n === null || n <= 0) return null;
  // Tradier quote examples use ms, while older OpenAPI examples use seconds.
  const ms = n < 1e12 ? n * 1000 : n;
  if (ms < Date.UTC(2000, 0, 1) || ms > Date.now() + 60000) return null;
  return new Date(ms).toISOString();
}

function ivTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    if (!dateOnly(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23 ||
      Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
    const ms = Date.parse(value.replace(' ', 'T'));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // The official example omits TZ. Preserve it, never infer UTC or browser TZ.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const validationTime = Date.parse(value.replace(' ', 'T') + 'Z');
  // UTC is used only to validate calendar fields, not to assign a timezone.
  return Number.isFinite(validationTime) && new Date(validationTime).toISOString().slice(0, 19).replace('T', ' ') === value ? value : null;
}

function dateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function selectExpirations(dates, now = Date.now()) {
  const day = 86400000;
  const available = [...new Set(dates.filter(dateOnly))].sort().filter(date => {
    const days = (Date.parse(`${date}T21:00:00Z`) - now) / day;
    return days >= 14 && days <= 310;
  });
  const selected = new Set();
  for (let month = 1; month <= MAX_EXPIRIES; month++) {
    const target = now + month * 365.25 / 12 * day;
    const nearest = available.reduce((best, date) =>
      !best || Math.abs(Date.parse(date) - target) < Math.abs(Date.parse(best) - target) ? date : best, null);
    if (nearest) selected.add(nearest);
  }
  return [...selected].sort();
}

class ProviderError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

async function readBoundedJson(upstream) {
  const declared = Number(upstream.headers.get('Content-Length'));
  if (declared > MAX_BODY_BYTES) throw new ProviderError('OPTIONS_RESPONSE_TOO_LARGE');
  if (!upstream.body) throw new ProviderError('OPTIONS_UPSTREAM_FORMAT');
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ProviderError('OPTIONS_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ProviderError('OPTIONS_UPSTREAM_FORMAT'); }
}

async function providerGet(path, params, token, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProviderError('OPTIONS_UPSTREAM_TIMEOUT', 504);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, UPSTREAM_TIMEOUT_MS));
  try {
    const url = new URL(path, BASE_URL);
    Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, String(value)));
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!upstream.ok) {
      // Never forward provider error bodies (they can contain credentials/details).
      throw new ProviderError(upstream.status === 429 ? 'OPTIONS_UPSTREAM_RATE_LIMIT' :
        upstream.status === 401 || upstream.status === 403 ? 'OPTIONS_PROVIDER_AUTH' : 'OPTIONS_UPSTREAM_FAILED');
    }
    const data = await readBoundedJson(upstream);
    if (!data || typeof data !== 'object' || data.errors || data.fault) throw new ProviderError('OPTIONS_UPSTREAM_FORMAT');
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(controller.signal.aborted ? 'OPTIONS_UPSTREAM_TIMEOUT' : 'OPTIONS_UPSTREAM_FAILED', controller.signal.aborted ? 504 : 502);
  } finally { clearTimeout(timer); }
}

function normalizeContract(row, expiry, ticker) {
  const strike = finite(row.strike);
  if (!strike || strike <= 0 || !['put', 'call'].includes(row.option_type) ||
    row.expiration_date !== expiry || canonicalTicker(row.underlying) !== ticker ||
    (row.contract_size !== undefined && row.contract_size !== 100)) return null;
  const bid = finite(row.bid), ask = finite(row.ask);
  const rawIv = finite(row.greeks?.mid_iv);
  const ivAsOf = ivTime(row.greeks?.updated_at);
  const bidAsOf = epochTime(row.bid_date), askAsOf = epochTime(row.ask_date);
  // Both sides must be timestamped; conservatively use the older one.
  const quoteAsOf = bidAsOf && askAsOf ? (bidAsOf < askAsOf ? bidAsOf : askAsOf) : null;
  return {
    expiry, strike, type: row.option_type, bid, ask,
    iv: rawIv !== null && rawIv > 0 && rawIv <= 5 ? rawIv : null,
    ivAsOf, quoteAsOf,
    ivTimestampTimezone: ivAsOf?.endsWith('Z') ? 'UTC' : 'unspecified',
    volume: finite(row.volume), openInterest: finite(row.open_interest)
  };
}

async function loadOptions(ticker, token) {
  const now = Date.now(), deadline = now + REQUEST_DEADLINE_MS;
  const initial = await Promise.allSettled([
    providerGet('quotes', { symbols: ticker }, token, deadline),
    providerGet('options/expirations', { symbol: ticker, includeAllRoots: false }, token, deadline)
  ]);
  const initialFailure = initial.find(result => result.status === 'rejected');
  if (initialFailure) throw initialFailure.reason;
  const [quoteData, expiryData] = initial.map(result => result.value);
  if (!quoteData.quotes || !Object.hasOwn(quoteData.quotes, 'quote') ||
    !expiryData.expirations || !Object.hasOwn(expiryData.expirations, 'date')) throw new ProviderError('OPTIONS_UPSTREAM_FORMAT');
  const quote = list(quoteData.quotes.quote).find(item => canonicalTicker(item.symbol) === ticker);
  if (!quote || !finite(quote.last) || quote.last <= 0) throw new ProviderError('OPTIONS_UNAVAILABLE', 404);
  const dates = Array.isArray(expiryData.expirations.date) ? expiryData.expirations.date :
    typeof expiryData.expirations.date === 'string' ? [expiryData.expirations.date] : [];
  const expiries = selectExpirations(dates, now);
  const warnings = new Set(['HOURLY_IV: Tradier / ORATS IV updates hourly; quotes and IV may describe different market times.']);
  if (!expiries.length) warnings.add('NO_EXPIRIES: No listed option expiry in the supported 14–310 day interval.');
  const contracts = [];
  let cursor = 0, invalidRows = 0;
  // Max 3 simultaneous chains and 11 provider calls per uncached ticker.
  async function loadChain() {
    while (cursor < expiries.length) {
      const expiry = expiries[cursor++];
      const data = await providerGet('options/chains', { symbol: ticker, expiration: expiry, greeks: true }, token, deadline);
      if (!data.options || !Object.hasOwn(data.options, 'option')) throw new ProviderError('OPTIONS_UPSTREAM_FORMAT');
      const rows = list(data.options.option);
      if (rows.length > MAX_CHAIN_ROWS) throw new ProviderError('OPTIONS_RESPONSE_TOO_LARGE');
      for (const row of rows) {
        const contract = row && typeof row === 'object' ? normalizeContract(row, expiry, ticker) : null;
        if (!contract) { invalidRows++; continue; }
        if (contracts.length >= MAX_CONTRACTS) throw new ProviderError('OPTIONS_RESPONSE_TOO_LARGE');
        contracts.push(contract);
        if (contract.iv === null) warnings.add('MISSING_IV: Some contracts have no valid provider mid IV; no historical-volatility substitution.');
        if (!contract.ivAsOf) warnings.add('MISSING_IV_TIME: Some provider IV timestamps are missing or malformed.');
        else if (contract.ivTimestampTimezone === 'unspecified') warnings.add('IV_TIMEZONE_UNSPECIFIED: Provider IV timestamps have no timezone; preserve raw times and verify with provider before quantitative use.');
        if (!contract.quoteAsOf) warnings.add('MISSING_QUOTE_TIME: Some contracts have no usable bid/ask timestamps.');
        if (contract.bid === null || contract.ask === null || contract.bid < 0 || contract.ask <= contract.bid)
          warnings.add('INVALID_QUOTES: Some contracts have missing, crossed or zero-width quotes; filter before estimating a surface.');
      }
    }
  }
  // Wait for every started request even on failure, preserving the concurrency cap.
  const chains = await Promise.allSettled(Array.from({ length: Math.min(3, expiries.length) }, loadChain));
  const chainFailure = chains.find(result => result.status === 'rejected');
  if (chainFailure) throw chainFailure.reason;
  if (invalidRows) warnings.add('NONSTANDARD_CONTRACTS: Malformed, different-underlying or nonstandard-size contracts were excluded.');
  const spotAsOf = epochTime(quote.trade_date);
  if (!spotAsOf) warnings.add('MISSING_SPOT_TIME: Underlying last-trade timestamp is unavailable.');
  const oldestQuote = contracts.map(c => c.quoteAsOf).filter(Boolean).sort()[0];
  if (oldestQuote && spotAsOf && Math.abs(Date.parse(spotAsOf) - Date.parse(oldestQuote)) > 900000)
    warnings.add('SPOT_OPTION_TIME_MISMATCH: Spot and some option quotes differ by more than 15 minutes.');
  if (spotAsOf && Date.now() - Date.parse(spotAsOf) > 900000)
    warnings.add('STALE_SPOT: Last trade is older than 15 minutes; market may be closed.');
  if (oldestQuote && Date.now() - Date.parse(oldestQuote) > 900000)
    warnings.add('STALE_QUOTES: Some option bid/ask quotes are older than 15 minutes.');
  contracts.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.type.localeCompare(b.type));
  return {
    schemaVersion: 1, ticker, spot: quote.last, spotAsOf, asOf: new Date().toISOString(),
    source: 'Tradier / ORATS', ivUnit: 'annualized-decimal', ivField: 'greeks.mid_iv',
    expirations: expiries, contracts, warnings: [...warnings]
  };
}

async function partition(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function handleOptions(request, env, ctx, headers) {
  if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 'Use GET /api/options?ticker=SYMBOL.', 405, headers);
  if (!env.TRADIER_TOKEN) return failure('OPTIONS_NOT_CONFIGURED', 'Options data is not configured. The owner must add a production Tradier token to the Worker.', 503, headers);
  if (env.OPTIONS_ACCESS_KEY) {
    if (request.headers.get('X-Options-Key') !== env.OPTIONS_ACCESS_KEY)
      return failure('OPTIONS_ACCESS_REQUIRED', 'Enter the personal options access key. It is separate from the broker token.', 401, headers);
  } else if (env.ALLOW_PUBLIC_OPTIONS !== 'true') {
    return failure('OPTIONS_ACCESS_NOT_CONFIGURED', 'Set a personal OPTIONS_ACCESS_KEY, or explicitly enable public data only after obtaining redistribution rights.', 503, headers);
  }
  const origin = request.headers.get('Origin');
  if (origin && env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN)
    return failure('OPTIONS_ORIGIN_DENIED', 'This website origin is not allowed.', 403, headers);
  const url = new URL(request.url);
  const ticker = canonicalTicker(url.searchParams.get('ticker'));
  if (!ticker || url.searchParams.getAll('ticker').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ticker'))
    return failure('INVALID_TICKER', 'Provide one US stock ticker; lists and custom query parameters are not accepted.', 400, headers);
  try {
    const scope = await partition(env.TRADIER_TOKEN);
    const cacheUrl = new URL('/api/options', url.origin);
    cacheUrl.searchParams.set('schema', SCHEMA);
    cacheUrl.searchParams.set('ticker', ticker);
    cacheUrl.searchParams.set('scope', scope);
    const cacheKey = new Request(cacheUrl.toString());
    const cached = await caches.default.match(cacheKey);
    if (cached) return response(await cached.json(), 200, headers);
    const taskKey = `${scope}:${ticker}`;
    let task = inFlight.get(taskKey);
    if (!task) {
      const now = Date.now();
      requestStarts = requestStarts.filter(time => now - time < 60000);
      if (inFlight.size >= 2 || requestStarts.length >= 6)
        return failure('OPTIONS_BUSY', 'Options refresh is busy. Retry after a minute.', 429, { ...headers, 'Retry-After': '60' });
      requestStarts.push(now);
      task = loadOptions(ticker, env.TRADIER_TOKEN);
      inFlight.set(taskKey, task);
      task.finally(() => inFlight.delete(taskKey)).catch(() => {});
    }
    const data = await task;
    const cachedResponse = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
    });
    // Public cache policy is only internal to Cache API; callers always receive no-store.
    ctx.waitUntil(caches.default.put(cacheKey, cachedResponse).catch(() => {}));
    return response(data, 200, headers);
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'OPTIONS_UPSTREAM_FAILED';
    return failure(code, 'Unable to retrieve validated production option data. Check credentials/provider status and retry; no estimated IV was substituted.',
      error instanceof ProviderError ? error.status : 502, headers);
  }
}
