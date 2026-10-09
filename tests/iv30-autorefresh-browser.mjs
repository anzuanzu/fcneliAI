// Synthetic publication fixtures. No external source or account calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const playwright=await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/') {res.setHeader('Content-Type','text/html');res.end(`<button id="iv30Reload">Reload</button><p id="iv30Status"></p><div id="cell"></div><script>window.refreshFcnTable=()=>{document.getElementById('cell').innerHTML=window.fcnCurrentIv30Cell('NVDA','https://example.test/');};</script><script type="module" src="/assets/current-iv30.mjs"></script>`);return;}
  if(['/assets/current-iv30.mjs','/assets/iv-engine.mjs'].includes(path)) {res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('..'+path,import.meta.url)));return;}
  res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'chrome'});
const now=new Date('2026-10-09T20:00:00Z');
let raw={schemaVersion:1,source:'Market Chameleon',sourceUrl:'https://marketchameleon.com/volReports/VolatilityRankings',ivUnit:'annualized-percent',sourceAsOf:null,observedAt:now.toISOString(),records:[{ticker:'NVDA',iv30Percent:29.4}]};
let report={schemaVersion:1,outcome:'success',attemptedAt:now.toISOString()},requests=0,fail=false,gate;
async function setup(page) {
  await page.clock.install({time:new Date(raw.observedAt)});
  await page.route('**/assets/current-iv30.json?*',async route=>{requests++;if(gate) await gate;await route.fulfill(fail ? {status:503,body:'failure fixture'} : {json:raw});});
  await page.route('**/assets/iv30-update-status.json?*',route=>route.fulfill({json:report}));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>document.getElementById('iv30Status').textContent.includes('已載入'));
}
try {
  const page=await browser.newPage();await setup(page);
  assert.match(await page.locator('#cell').innerText(),/29\.4%/);
  raw={...raw,observedAt:'2026-10-09T20:01:00Z',records:[{ticker:'NVDA',iv30Percent:33.1}]};
  await page.clock.runFor(300000);
  await page.waitForFunction(()=>window.fcnCurrentIv30Value('NVDA')===33.1);
  assert.equal(requests,2,'five-minute automatic check loads a new shared publication');
  raw={...raw,observedAt:'2026-10-09T19:59:00Z',records:[{ticker:'NVDA',iv30Percent:1}]};
  await page.clock.runFor(300000);
  await page.waitForFunction(()=>document.getElementById('iv30Status').textContent.includes('保留上次快照'));
  assert.equal(await page.evaluate(()=>window.fcnCurrentIv30Value('NVDA')),33.1,'older CDN files cannot roll back accepted data');
  fail=true;await page.locator('#iv30Reload').click();
  await page.waitForFunction(()=>!document.getElementById('iv30Reload').disabled);
  assert.match(await page.locator('#cell').innerText(),/33\.1%/);
  fail=false;raw={...raw,observedAt:'2026-10-09T20:10:00Z',records:[{ticker:'NVDA',iv30Percent:44.2}]};
  report={...report,outcome:'failed',attemptedAt:'2026-10-09T20:10:00Z'};
  await page.locator('#iv30Reload').click();
  await page.waitForFunction(()=>document.getElementById('iv30Status').textContent.includes('最近擷取失敗'));
  assert.match(await page.locator('#cell').innerText(),/44\.2%/);
  await page.evaluate(()=>{window.testVisibility='hidden';Object.defineProperty(document,'visibilityState',{get:()=>window.testVisibility});document.dispatchEvent(new Event('visibilitychange'));});
  const beforeHidden=requests;await page.clock.runFor(300000);assert.equal(requests,beforeHidden,'hidden tabs pause polling');
  let release;gate=new Promise(resolve=>release=resolve);
  await page.evaluate(()=>{window.testVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.getElementById('iv30Reload').disabled);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(requests,beforeHidden+1,'returning to the tab starts one check and suppresses overlapping refreshes');
  release();gate=null;await page.waitForFunction(()=>!document.getElementById('iv30Reload').disabled);
  const otherContext=await browser.newContext(),other=await otherContext.newPage();await setup(other);
  assert.equal(await other.evaluate(()=>window.fcnCurrentIv30Value('NVDA')),44.2,'another user receives the same published snapshot');
  console.log('IV30 automatic reload passed: new publication, older snapshot rejection, failure retention/status, hidden pause, visibility resume, overlap guard, shared data across users.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
