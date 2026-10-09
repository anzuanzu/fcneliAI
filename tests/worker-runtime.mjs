// Use workerd, not Node's fetch implementation: their redirect modes differ.
// Only synthetic prices/credentials; all external network access is disabled.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {Miniflare, Response: RuntimeResponse} = await import(process.env.MINIFLARE_MODULE_PATH || 'miniflare');
const replies = []; let providerCalls = 0;
const base = {
  modules:true, modulesRules:[{type:'ESModule',include:['**/*.js']}],
  scriptPath:fileURLToPath(new URL('../worker/src/index.js',import.meta.url)), cf:false,
  compatibilityDate:'2026-07-17',
  // All subrequests terminate here. Nothing can contact an external network.
  outboundService:request=>{
    assert.equal(new URL(request.url).origin,'https://api.twelvedata.com');
    assert.equal(request.headers.get('Authorization'),'apikey synthetic-provider-key');
    assert.ok(!new URL(request.url).searchParams.has('apikey'));
    providerCalls++;
    assert.ok(replies.length,'unexpected extra subrequest or redirect follow');
    const {status,data,headers} = replies.shift();
    return new RuntimeResponse(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
  },
  bindings:{TWELVE_DATA_API_KEY:'synthetic-provider-key', HISTORY_ACCESS_KEY:'synthetic-private-key',
    HISTORY_DISPLAY_LICENSE_CONFIRMED:'true',ALLOWED_ORIGIN:'https://anzuanzu.github.io'}
};
const request = ticker => [`https://worker.example/api/history?ticker=${ticker}`, {
  headers:{'X-History-Key':'synthetic-private-key',Origin:'https://anzuanzu.github.io'}
}];
function intercept(status, data, headers={}) { replies.push({status,data,headers}); }
const date = offset=>new Date(Date.now()-offset*86400000).toISOString().slice(0,10);
intercept(200,{status:'ok',meta:{symbol:'AAPL',interval:'1day',currency:'USD',exchange_timezone:'America/New_York'},
  values:[{datetime:date(3),close:'100'},{datetime:date(2),close:'101'}]});
const worker = new Miniflare(base);
try {
  const ok = await worker.dispatchFetch(...request('AAPL'));
  assert.equal(ok.status,200,'workerd must reach the provider and accept the split-adjusted response');
  const history = await ok.json();
  assert.equal(history.ticker,'AAPL'); assert.equal(history.bars.length,2);
  assert.equal((await worker.dispatchFetch(...request('AAPL'))).status,200,'repeat uses internal cache');
  intercept(302,{}, {location:'https://credential-leak.example/?key=must-not-follow'});
  const redirect = await worker.dispatchFetch(...request('NVDA'));
  assert.equal(redirect.status,502);
  assert.equal((await redirect.json()).code,'HISTORY_UPSTREAM_REDIRECT');
  assert.equal(replies.length,0);
  assert.equal(providerCalls,2,'only the original AAPL and NVDA requests may contact the provider');
  console.log('Worker runtime passed: real workerd fetch, header authentication, history normalization, private cache and redirect refusal; no external network.');
} finally { await worker.dispose(); }
