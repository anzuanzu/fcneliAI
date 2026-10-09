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
  await page.waitForSelector('#tableBody td[data-label="估計波動率"]');
  await page.locator('#ivMode').selectOption('market-iv');
  assert.equal(await page.locator('#tableBody td[data-label="ATM IV"]').count(),4);
  await page.locator('#ivTickers').fill('AAPL, MSFT');
  await page.locator('#ivImport').setInputFiles({name:'synthetic-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([fixture('AAPL'),fixture('MSFT')]))});
  await page.waitForFunction(() => document.getElementById('ivStatus').textContent.includes('已匯入 2'));
  assert.equal(await page.locator('#ivSurface tbody tr').count(),8);
  assert.match(await page.locator('#ivSurface').innerText(),/四個價位皆有覆蓋/);
  assert.match(await page.locator('#tableBody').innerText(),/40\.00%/);
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
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page should not overflow');
    assert.equal(await page.locator('#ivSurface thead').evaluate(e=>getComputedStyle(e).display),'table-header-group');
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/iv-mobile.png'});
    await page.locator('#themeToggle').click();
    await page.setViewportSize({width:700,height:1000});
    assert.equal(await page.locator('#ivSurface thead tr').evaluate(e=>getComputedStyle(e).position),'static','tablet table header should remain visible');
    await page.locator('#ivResearchPanel').screenshot({path:screenshotDir+'/iv-mobile-light.png'});
    await page.locator('#themeToggle').click();
    await page.setViewportSize({width:1440,height:1100});
  }
  await page.locator('#inputK').fill('85');
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
  await page.route('**/api/history/status',async route=>{
    await new Promise(r=>setTimeout(r,250));
    try {await route.fulfill({json:setup});} catch {}
  });
  await page.locator('#historyCheck').click();
  await page.locator('#historyClear').click();
  await page.waitForTimeout(350);
  assert.match(await page.locator('#historySetupStatus').innerText(),/已取消/);
  assert.equal(await page.locator('#historyCheck').isEnabled(),true);
  await page.locator('#ivCompare').click();
  assert.match(await page.locator('#ivSimulationStatus').innerText(),/所有研究股票的歷史股價/);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page should not overflow');
  assert.deepEqual(errors,[]);
  console.log('Browser smoke passed: IV regression; Worker setup checks, missing settings/password/old deployment/unsafe URL/cancellation; historical fetch, 12 scenario comparisons, source/labels, export/key privacy, unavailable license, mismatched ticker, missing history, scan outage, mobile.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
