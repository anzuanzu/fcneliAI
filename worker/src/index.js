const TRADINGVIEW_SCAN_URL = 'https://scanner.tradingview.com/america/scan';

const COLUMNS = [
  'name', 'description', 'close', 'Perf.W', 'Perf.1M', 'Volatility.W',
  'SMA200', 'market_cap_basic', 'sector', 'industry', 'type',
  'beta_1_year', 'ATR'
];

function scannerPayload() {
  return {
    filter: [{ left: 'type', operation: 'equal', right: 'stock' }],
    options: { lang: 'en' },
    range: [0, 15000],
    sort: { sortBy: 'name', sortOrder: 'asc' },
    columns: COLUMNS
  };
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || requestOrigin || '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (url.pathname !== '/api/scan') return jsonResponse({ error: 'Not found' }, 404, headers);
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedHeaders = new Headers(cached.headers);
      Object.entries(headers).forEach(([key, value]) => cachedHeaders.set(key, value));
      return new Response(cached.body, { headers: cachedHeaders });
    }

    try {
      const upstream = await fetch(TRADINGVIEW_SCAN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(scannerPayload())
      });
      if (!upstream.ok) {
        return jsonResponse({ error: `Upstream request failed (${upstream.status})` }, 502, headers);
      }

      const data = await upstream.json();
      if (!Array.isArray(data.data)) return jsonResponse({ error: 'Unexpected upstream response' }, 502, headers);

      const response = jsonResponse(data, 200, {
        ...headers,
        'Cache-Control': 'public, max-age=300, s-maxage=600'
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return jsonResponse({ error: 'Unable to refresh market data' }, 502, headers);
    }
  }
};
