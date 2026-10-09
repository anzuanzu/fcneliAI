// Synthetic public-table fixtures only; no external source requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {collectIV30} from '../scripts/market-chameleon-iv30.mjs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser=await playwright.chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'chrome'});
function html(mode) {
  return `<!doctype html><div id="iv_rankings_report_tbl_wrapper"><select name="iv_rankings_report_tbl_length"><option value="50">50</option><option value="100">100</option></select><table id="iv_rankings_report_tbl"><thead><tr><th>IV30 % Rank</th><th>Symbol</th><th>Current IV30</th></tr></thead><tbody></tbody></table><p id="info"></p><a id="iv_rankings_report_tbl_next" href="#">Next</a></div><script>
  const mode=${JSON.stringify(mode)};let start=0,size=50;
  function render(){
    const end=Math.min(start+size,201);
    document.querySelector('tbody').innerHTML=Array.from({length:end-start},(_,j)=>{const i=start+j,code=mode==='duplicate'&&i===200?'TEST000':'TEST'+String(i).padStart(3,'0');return '<tr><td>94%</td><td>'+code+'</td><td>'+(i===17?'-':'29.4')+'</td></tr>';}).join('');
    document.getElementById('info').textContent='Showing '+(start+1)+' to '+end+' of '+(mode==='count'&&start>0?202:201)+' entries';
    document.getElementById('iv_rankings_report_tbl_next').className=end===201?'paginate_button next disabled':'paginate_button next';
  }
  document.querySelector('select').onchange=e=>{size=+e.target.value;start=0;render();};
  document.getElementById('iv_rankings_report_tbl_next').onclick=e=>{e.preventDefault();start+=size;render();};if(mode==='loading'){document.querySelector('tbody').innerHTML='<tr><td colspan="3">Loading...</td></tr>';const pending=setTimeout(render,150);document.querySelector('select').onchange=e=>{clearTimeout(pending);size=+e.target.value;start=0;setTimeout(render,50);};}else render();
  </script>`;
}
try {
  for (const [mode,error] of [['good',null],['loading',null],['duplicate',/DUPLICATE/],['count',/COUNT_CHANGED/],['blocked',/SOURCE_HTTP_403/]]) {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({status:mode==='blocked'?403:200,contentType:'text/html',body:html(mode)}));
    if(error) await assert.rejects(collectIV30(page,'https://synthetic-iv30.example/'),error);
    else {
      const snapshot=await collectIV30(page,'https://synthetic-iv30.example/');
      assert.equal(snapshot.records.length,201);
      assert.equal(snapshot.records.find(r=>r.ticker==='TEST000').iv30Percent,29.4);
      assert.equal(snapshot.records.find(r=>r.ticker==='TEST017').iv30Percent,null);
      assert.equal(snapshot.sourceAsOf,null);
    }
    await page.close();
  }
  console.log('IV30 crawler browser fixtures passed: 201 rows across three pages, named Current IV30 field, missing value, duplicate/count changes, HTTP access block.');
} finally {await browser.close();}
