// All market inputs below are synthetic fixtures, never product defaults.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {addCalendarMonths} from '../assets/iv-engine.mjs';
const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (path.includes('..')) { res.writeHead(403); res.end(); return; }
    const file = root + (path === '/' ? 'index.html' : path.slice(1));
    const body = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const now = new Date(), asOf = now.toISOString();
function fixture(ticker, spot = 100) {
  return {schemaVersion:1,ticker,spot,spotAsOf:asOf,asOf,source:'SYNTHETIC TEST FIXTURE — NOT MARKET DATA',ivUnit:'annualized-decimal',
    contracts:[2,3,4,5,6,7,8].flatMap(months => {
      const expiry = addCalendarMonths(now,months).toISOString().slice(0,10);
      return [50,60,65,70,80,90,100,105,110,120].flatMap(pct => ['put','call'].map(type => ({expiry,strike:spot*pct/100,type,bid:2,ask:2.2,iv:.4+(100-pct)/1000,ivAsOf:asOf,quoteAsOf:asOf,volume:100,openInterest:1000})));
    })};
}
function historyFixture(ticker, phase = 0) {
  const dateParts = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const currentDate = ['year','month','day'].map(type=>dateParts.find(p=>p.type===type).value).join('-');
  let cursor = new Date(Date.parse(currentDate)-86400000); const dates = [];
  while (dates.length < 400) { if (![0,6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0,10)); cursor = new Date(+cursor-86400000); }
  let close = 100;
  return {schemaVersion:1,ticker,source:'SYNTHETIC HISTORY TEST FIXTURE — NOT MARKET DATA',adjustment:'splits',asOf,timezone:'America/New_York',currency:'USD',
    bars:dates.map((date,i)=>{close *= Math.exp(.0001+.012*Math.sin(i*1.71+phase)+.01*Math.cos(i*.79-phase)); return {date,close};}),warnings:[]};
}
const scan = {totalCount:4,data:['AAPL','MSFT','NVDA','BRK.B'].map(ticker => ({s:`NASDAQ:${ticker}`,d:[ticker,`Synthetic ${ticker}`,100,2,3,4,90,1e11,'Technology','Test','stock',1.2,2,95,94,93,1,3,5,120,80,60,1,1]}))};
let browser;
try {
  browser = await playwright.chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1100}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/scan') return route.fulfill({json:scan});
    if (url.origin !== base) return route.abort();
    return route.continue();
  });
  await page.goto(base);
  await page.waitForFunction(() => !!window.getFcnResearchContext && !!window.fcnIvLabel);
  await page.evaluate(() => { document.getElementById('dailyFocusModal')?.classList.remove('open'); });
  await page.locator('#ivResearchPanel summary').first().click();
  await page.waitForSelector('#tableBody td[data-label="Current IV30"]');
  assert.equal(await page.locator('#inputK').inputValue(),'70');
  assert.equal(await page.locator('#inputKI').inputValue(),'60');
  assert.equal(await page.locator('.table-container thead th').count(),9);
  assert.doesNotMatch(await page.locator('.table-container thead').innerText(),/估計波動率|板塊\/產業/);
  await page.locator('#ivOpenImport').click();
  assert.equal(await page.locator('#ivMode').inputValue(),'market-iv');
  assert.equal(await page.locator('#tableBody td[data-label="Current IV30"]').count(),4);
  assert.doesNotMatch(await page.locator('.table-container thead').innerText(),/[3-6] 個月 IV/);
  const iv30Cell = page.locator('#tableBody td[data-label="Current IV30"]').first();
  const sourceLookup = page.locator('#tableBody a[aria-label="AAPL Market Chameleon IV30 查詢"]');
  assert.match(await iv30Cell.innerText(),/—\s+尚未接入/);
  assert.equal(await sourceLookup.getAttribute('href'),'https://marketchameleon.com/Overview/AAPL/IV/');
  assert.equal(await sourceLookup.getAttribute('target'),'_blank');
  assert.equal(await page.locator('#tableBody a[aria-label="BRK.B Market Chameleon IV30 查詢"]').getAttribute('href'),'https://marketchameleon.com/volReports/VolatilityRankings');
  assert.match(await page.locator('.iv-table-toolbar').innerText(),/尚未接入.*不是 IV30 % Rank/);
  assert.equal(await page.locator('#tableBody td[data-label="查詢連結"] a.iv-chain-link').first().getAttribute('href'),'https://www.tradingview.com/symbols/NASDAQ-AAPL/options-chain/');
  await page.locator('#ivTickers').fill('AAPL, MSFT');
  await page.locator('#ivImport').setInputFiles({name:'synthetic-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([fixture('AAPL'),fixture('MSFT',200)]))});
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('已匯入 2'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  assert.match(await page.locator('#ivSurface').innerText(),/四個價位皆有覆蓋/);
  assert.match(await iv30Cell.innerText(),/尚未接入/,'option imports do not fabricate Market Chameleon IV30');
  assert.doesNotMatch(await iv30Cell.innerText(),/40\.00%|43\.00%|44\.00%/);
  assert.match(await page.locator('#ivQueryGuide').innerText(),/K 70% \$70\.00.*KI 60% \$60\.00/);
  assert.match(await page.locator('#ivQueryGuide').innerText(),/K 70% \$140\.00.*KI 60% \$120\.00/,'query guide uses imported snapshot spot instead of scanner spot');
  await page.locator('#ivMode').selectOption('historical-estimate');
  assert.match(await iv30Cell.innerText(),/尚未接入/,'mode switch leaves the source-only IV30 column unchanged');
  await page.locator('#ivMode').selectOption('market-iv');
  await page.locator('#ivPaths').selectOption('5000');
  await page.locator('#ivCompare').click();
  await page.waitForFunction(() => document.getElementById('ivSimulationStatus').textContent.includes('比較完成'),{timeout:30000});
  assert.equal(await page.locator('#ivComparisons tbody tr').count(),4);
  assert.doesNotMatch(await page.locator('#ivComparisons').innerText(),/無法估算/);
  assert.match(await page.locator('#ivComparisons').innerText(),/首個 KO：第 1 月/);
  assert.equal(await page.locator('#ivExport').isEnabled(),true);
  const screenshotDir = process.env.SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir,{recursive:true});
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/iv-desktop.png'});
    await page.locator('.table-container').screenshot({path:screenshotDir+'/iv-terms-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page should not overflow');
    assert.equal(await page.locator('#ivSurface thead').evaluate(e=>getComputedStyle(e).display),'table-header-group');
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/iv-mobile.png'});
    await page.locator('#tableBody tr').first().screenshot({path:screenshotDir+'/iv-terms-mobile.png'});
    await page.locator('#themeToggle').click();
    await page.setViewportSize({width:700,height:1000});
    assert.equal(await page.locator('#ivSurface thead tr').evaluate(e=>getComputedStyle(e).position),'static','tablet table header should remain visible');
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/iv-mobile-light.png'});
    await page.locator('#themeToggle').click();
    await page.setViewportSize({width:1440,height:1100});
  }
  await page.locator('#inputK').fill('85');
  await page.locator('#inputKI').fill('65');
  assert.match(await page.locator('#ivSurface thead').innerText(),/K 85%.*KI 65%/);
  assert.match(await page.locator('#ivSurface tbody tr').first().innerText(),/43\.50%/);
  assert.match(await iv30Cell.innerText(),/尚未接入/,'barrier edits do not change source-only IV30');
  assert.match(await page.locator('#ivQueryGuide').innerText(),/K 85% \$85\.00.*KI 65% \$65\.00/);
  assert.equal(await page.locator('#ivComparisons tbody tr').count(),0);
  assert.equal(await page.locator('#ivExport').isEnabled(),false);
  await page.locator('#ivLockout').fill('6');
  await page.locator('#ivCompare').click();
  await page.waitForFunction(() => document.getElementById('ivSimulationStatus').textContent.includes('比較完成'),{timeout:30000});
  assert.doesNotMatch(await page.locator('#ivComparisons').innerText(),/無法估算/);
  assert.match(await page.locator('#ivComparisons').innerText(),/首個 KO：第 6 月/);
  await page.locator('#ivImport').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('匯入失敗'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  // Access keys are never persisted; share class output matches dot notation.
  await page.locator('#ivTickers').fill('BRK.B');
  await page.getByText('日後啟用自動查詢',{exact:true}).click();
  await page.locator('#ivEndpoint').fill(base+'/api/options');
  await page.locator('#ivAccessKey').fill('test-private-gate');
  await page.route('**/api/options?*', route => route.fulfill({json:fixture('BRK/B')}));
  await page.locator('#ivFetch').click();
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('已取得 1'));
  assert.doesNotMatch(await page.locator('#ivSurface').innerText(),/尚未匯入/);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('test-private-gate')),false);
  // A late response may not repopulate explicitly cleared data.
  await page.unroute('**/api/options?*');
  await page.route('**/api/options?*', async route => { await new Promise(r => setTimeout(r,250)); try { await route.fulfill({json:fixture('BRK/B')}); } catch {} });
  await page.locator('#ivFetch').click();
  await page.locator('#ivClear').click();
  await page.waitForTimeout(400);
  assert.match(await page.locator('#ivSurface').innerText(),/尚未匯入/);
  assert.equal(await page.locator('#ivCompare').isEnabled(),true);
  // Missing deep strike must block estimates rather than extrapolate.
  const sparse = fixture('AAPL'); sparse.contracts = sparse.contracts.filter(c => c.strike>=80);
  await page.locator('#ivTickers').fill('AAPL');
  await page.locator('#ivImport').setInputFiles({name:'missing-ki.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sparse))});
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('已匯入 1'));
  assert.match(await page.locator('#ivSurface tbody tr').first().innerText(),/缺資料/);
  assert.match(await iv30Cell.innerText(),/尚未接入/);
  await page.locator('#ivCompare').click();
  await page.waitForFunction(() => document.getElementById('ivSimulationStatus').textContent.includes('比較完成'));
  assert.match(await page.locator('#ivComparisons').innerText(),/無法估算/);
  assert.equal(await page.locator('#ivExport').isEnabled(),false);
  // Independent workflow still works when original stock scan fails.
  await page.route('**/api/scan*', route => route.fulfill({status:403,json:{error:'fixture outage'}}));
  await page.reload();
  await page.waitForFunction(() => !!window.fcnIvLabel);
  await page.locator('#ivResearchPanel summary').first().click();
  await page.locator('#ivImport').setInputFiles({name:'standalone.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture('AAPL')))});
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('已匯入 1'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),4);
  assert.match(await page.locator('#tableBody').innerText(),/讀取數據失敗/);
  // Historical mode is distinct from option IV and works without a stock scan.
  await page.locator('#ivMode').selectOption('historical-estimate');
  await page.locator('#ivTickers').fill('AAPL, MSFT');
  await page.locator('#historyEndpoint').fill(base+'/api/history');
  await page.locator('#historyAccessKey').fill('synthetic-history-private-key');
  let setup = {schemaVersion:1, kind:'history-configuration', providerConfigured:false,
    accessConfigured:false, usageConfirmed:false, configurationReady:false,
    accessVerified:null, providerConnectionTested:false};
  let setupResponse = 200;
  await page.route('**/api/history/status', route => {
    assert.equal(route.request().headers()['x-history-key'],'synthetic-history-private-key');
    assert.equal(new URL(route.request().url()).search,'');
    return route.fulfill({status:setupResponse,json:setup});
  });
  await page.locator('#historyCheck').click();
  await page.waitForFunction(()=>document.getElementById('historySetupStatus').textContent.includes('TWELVE_DATA_API_KEY'));
  assert.match(await page.locator('#historySetupStatus').innerText(),/HISTORY_ACCESS_KEY/);
  setupResponse = 404;
  await page.locator('#historyCheck').click();
  await page.waitForFunction(()=>document.getElementById('historySetupStatus').textContent.includes('部署新版 Worker'));
  setupResponse = 200;
  setup = {...setup,providerConfigured:true,accessConfigured:true,usageConfirmed:true,configurationReady:true,accessVerified:false};
  await page.locator('#historyCheck').click();
  await page.waitForFunction(()=>document.getElementById('historySetupStatus').textContent.includes('密碼不符'));
  setup.accessVerified = true;
  await page.locator('#historyCheck').click();
  await page.waitForFunction(()=>document.getElementById('historySetupStatus').textContent.includes('設定齊全'));
  assert.match(await page.locator('#historySetupStatus').innerText(),/尚未驗證真實金鑰/);
  await page.locator('#historyEndpoint').fill(base+'/api/history?apikey=should-not-send');
  await page.locator('#historyCheck').click();
  await page.waitForFunction(()=>document.getElementById('historySetupStatus').textContent.includes('不要包含金鑰'));
  await page.locator('#historyEndpoint').fill(base+'/api/history');
  await page.route('**/api/history?*', route => {
    assert.equal(route.request().headers()['x-history-key'],'synthetic-history-private-key');
    const ticker = new URL(route.request().url()).searchParams.get('ticker');
    return route.fulfill({json:historyFixture(ticker,ticker==='MSFT' ? .9 : 0)});
  });
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('已取得 2'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  assert.match(await page.locator('#ivSurface').innerText(),/基準預測波動率/);
  assert.doesNotMatch(await page.locator('#ivSurface').innerText(),/ATM IV|合約 IV/);
  assert.doesNotMatch(await page.locator('#tableBody').innerText(),/歷史估計|EWMA|基準預測波動率/,'historical mode must not populate Current IV30');
  await page.locator('#ivPaths').selectOption('5000');
  await page.locator('#ivCompare').click();
  await page.waitForFunction(()=>document.getElementById('ivSimulationStatus').textContent.includes('比較完成'),{timeout:30000});
  assert.equal(await page.locator('#ivComparisons tbody tr').count(),12);
  assert.doesNotMatch(await page.locator('#ivComparisons').innerText(),/無法估算/);
  assert.match(await page.locator('#ivComparisons').innerText(),/未校準市場 IV/);
  assert.match(await page.locator('#ivComparisons').innerText(),/低波動|高波動＋相關性壓力/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#ivExport').click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(),'utf8'));
  assert.equal(exported.histories.length,2);
  assert.equal(exported.input.mode,'historical-estimate');
  assert.equal(exported.results.length,12);
  assert.equal(JSON.stringify(exported).includes('synthetic-history-private-key'),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('synthetic-history-private-key')),false);
  await page.unroute('**/api/scan*');
  await page.evaluate(() => fetchData());
  await page.waitForSelector('#tableBody td[data-label="Current IV30"]');
  assert.match(await iv30Cell.innerText(),/尚未接入/,'historical fetch does not fabricate IV30');
  if (screenshotDir) {
    await page.setViewportSize({width:1440,height:1100});
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/history-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/history-mobile.png'});
  }
  await page.locator('#inputKO').fill('105');
  assert.equal(await page.locator('#ivComparisons tbody tr').count(),0);
  assert.equal(await page.locator('#ivExport').isEnabled(),false);
  // Wrong ticker and provider configuration errors do not replace valid history.
  await page.unroute('**/api/history?*');
  await page.route('**/api/history?*',route=>route.fulfill({status:503,json:{code:'HISTORY_LICENSE_NOT_CONFIRMED',error:'disabled'}}));
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('展示授權'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  await page.unroute('**/api/history?*');
  await page.route('**/api/history?*',route=>route.fulfill({json:historyFixture('WRONG')}));
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('回傳股票代碼不符'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  // Late responses cannot repopulate cleared data or follow the next mode.
  await page.unroute('**/api/history?*');
  await page.route('**/api/history?*',async route=>{await new Promise(r=>setTimeout(r,250)); try {await route.fulfill({json:historyFixture('AAPL')});}catch{}});
  await page.locator('#historyFetch').click();
  await page.locator('#historyClear').click();
  await page.waitForTimeout(400);
  assert.match(await page.locator('#ivSurface').innerText(),/尚未取得歷史股價/);
  assert.equal(await page.locator('#historyFetch').isEnabled(),true);
  await page.unroute('**/api/history/status');
  let finishSetupCheck;
  const setupCheckGate = new Promise(resolve => { finishSetupCheck = resolve; });
  await page.route('**/api/history/status',async route=>{
    await setupCheckGate;
    try {await route.fulfill({json:setup});} catch {}
  });
  const setupCheckRequest = page.waitForRequest('**/api/history/status');
  await page.locator('#historyCheck').click();
  await setupCheckRequest;
  await page.locator('#historyClear').click();
  finishSetupCheck();
  await page.waitForTimeout(350);
  assert.match(await page.locator('#historySetupStatus').innerText(),/已取消/);
  assert.equal(await page.locator('#historyCheck').isEnabled(),true);
  await page.locator('#ivCompare').click();
  assert.match(await page.locator('#ivSimulationStatus').innerText(),/所有研究股票的歷史股價/);
  // Fatal provider credentials stop the batch instead of spending credits for each symbol.
  await page.unroute('**/api/history?*');
  let historyCalls = [];
  await page.locator('#ivTickers').fill('NVDA,AAPL,GOOG,MSFT,AMZN,SPCX');
  await page.route('**/api/history?*',route=>{
    historyCalls.push(new URL(route.request().url()).searchParams.get('ticker'));
    return route.fulfill({status:502,json:{code:'HISTORY_PROVIDER_AUTH',error:'must-never-display-secret'}});
  });
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('API 金鑰被拒絕'));
  assert.deepEqual(historyCalls,['NVDA']);
  assert.match(await page.locator('#historyStatus').innerText(),/未查詢：AAPL、GOOG、MSFT、AMZN、SPCX/);
  assert.doesNotMatch(await page.locator('#historyStatus').innerText(),/must-never-display-secret/);
  // A missing symbol is a per-ticker issue, not an undeployed Worker.
  await page.unroute('**/api/history?*'); historyCalls = [];
  await page.locator('#ivTickers').fill('SPCX,MSFT');
  await page.route('**/api/history?*',route=>{
    const ticker = new URL(route.request().url()).searchParams.get('ticker'); historyCalls.push(ticker);
    return route.fulfill(ticker==='SPCX' ? {status:404,json:{code:'HISTORY_UNAVAILABLE'}} : {json:historyFixture(ticker)});
  });
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('已取得 1'));
  assert.deepEqual(historyCalls,['SPCX','MSFT']);
  assert.doesNotMatch(await page.locator('#historyStatus').innerText(),/部署新版/);
  // Stop on quota, commit earlier successes, retain cooldown across clear/condition changes,
  // leave the metadata check usable and never schedule an automatic provider retry.
  await page.unroute('**/api/history?*'); historyCalls = [];
  await page.locator('#ivTickers').fill('AAPL,NVDA,GOOG,MSFT,AMZN,SPCX');
  await page.route('**/api/history?*',route=>{
    const ticker = new URL(route.request().url()).searchParams.get('ticker'); historyCalls.push(ticker);
    return route.fulfill(ticker==='AAPL' ? {json:historyFixture(ticker)}
      : {status:429,json:{code:'HISTORY_UPSTREAM_RATE_LIMIT',retryAfterSeconds:2}});
  });
  await page.locator('#historyFetch').click();
  await page.waitForFunction(()=>document.getElementById('historyStatus').textContent.includes('HISTORY_UPSTREAM_RATE_LIMIT'));
  assert.deepEqual(historyCalls,['AAPL','NVDA']);
  assert.match(await page.locator('#historyStatus').innerText(),/已取得 1.*未查詢：GOOG、MSFT、AMZN、SPCX/);
  assert.equal(await page.locator('#historyFetch').isEnabled(),false);
  assert.equal(await page.locator('#historyCheck').isEnabled(),true);
  await page.locator('#historyClear').click();
  assert.equal(await page.locator('#historyFetch').isEnabled(),false);
  await page.waitForFunction(()=>!document.getElementById('historyFetch').disabled);
  assert.deepEqual(historyCalls,['AAPL','NVDA'],'countdown must not make automatic requests');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page should not overflow');
  // Source lookup remains available when the optional research module fails.
  const failedPage = await browser.newPage();
  await failedPage.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/scan') return route.fulfill({json:scan});
    if (url.pathname.endsWith('/iv-ui.mjs') || url.origin !== base) return route.abort();
    return route.continue();
  });
  await failedPage.goto(base);
  await failedPage.waitForSelector('#tableBody td[data-label="Current IV30"]');
  await failedPage.waitForFunction(()=>document.getElementById('ivOpenImport').disabled);
  assert.match(await failedPage.locator('#tableBody td[data-label="Current IV30"]').first().innerText(),/尚未接入/);
  assert.equal(await failedPage.locator('#tableBody a[aria-label="AAPL Market Chameleon IV30 查詢"]').getAttribute('href'),'https://marketchameleon.com/Overview/AAPL/IV/');
  await failedPage.close();
  assert.deepEqual(errors,[]);
  console.log('Browser smoke passed: IV regression; Worker setup checks, missing settings/password/old deployment/unsafe URL/cancellation; historical fetch, 12 scenario comparisons, source/labels, export/key privacy, unavailable license, mismatched ticker, missing history, scan outage, mobile.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
