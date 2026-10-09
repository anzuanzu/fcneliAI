import {writeFile, rename, mkdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {validateIV30} from '../assets/current-iv30.mjs';

export const SOURCE_URL = 'https://marketchameleon.com/volReports/VolatilityRankings';
const normalHeader = value => value.replace(/\s+/g, '').trim();

export function parseRows(headers, rows) {
  const labels = headers.map(normalHeader);
  const symbolIndex = labels.indexOf('Symbol'), ivIndex = labels.indexOf('CurrentIV30');
  if (symbolIndex < 0 || ivIndex < 0 || labels.filter(h=>h==='CurrentIV30').length!==1) throw new Error('IV30_HEADER_CHANGED');
  return rows.map(cells => {
    if (cells.length !== headers.length) throw new Error('IV30_ROW_CHANGED');
    const ticker = cells[symbolIndex].trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/.test(ticker)) throw new Error('IV30_SYMBOL_INVALID');
    const raw = cells[ivIndex].trim();
    const iv30Percent = /^(?:-|—|N\/A|NA)?$/.test(raw) ? null : /^\d+(?:\.\d+)?%?$/.test(raw) ? Number(raw.replace('%','')) : NaN;
    if (iv30Percent !== null && (!Number.isFinite(iv30Percent) || iv30Percent<=0 || iv30Percent>1000)) throw new Error('IV30_VALUE_INVALID');
    return {ticker, iv30Percent};
  });
}

// Read only the visible public table. No login, stealth, proxy rotation, private
// endpoints or challenge handling. Any block/error preserves the previous file.
export async function collectIV30(page, sourceUrl = SOURCE_URL) {
  const response = await page.goto(sourceUrl, {waitUntil:'commit',timeout:45000});
  if (!response?.ok()) throw new Error(`IV30_SOURCE_HTTP_${response?.status() ?? 'FAILED'}`);
  if (new URL(page.url()).origin!==new URL(sourceUrl).origin) throw new Error('IV30_SOURCE_REDIRECT');
  // DataTables inserts a one-cell loading row before its asynchronous data
  // arrives. Changing page size then cancels that request and can stall forever.
  await page.locator('#iv_rankings_report_tbl tbody tr:first-child td:nth-child(2)').waitFor({timeout:45000});
  const initialInfo = await page.locator('#iv_rankings_report_tbl_wrapper').innerText();
  const initialTotal = Number(initialInfo.match(/of\s+([\d,]+)\s+entries/)?.[1]?.replaceAll(',',''));
  if (!(initialTotal>0)) throw new Error('IV30_COUNT_MISSING');
  await page.locator('select[name="iv_rankings_report_tbl_length"]').selectOption('100');
  await page.locator(`#iv_rankings_report_tbl tbody tr:nth-child(${Math.min(100,initialTotal)}) td:nth-child(2)`).waitFor({timeout:45000});
  const table = page.locator('#iv_rankings_report_tbl');
  const records = new Map();
  let expected;
  for (let pages = 0; pages < 100; pages++) {
    const headers = await table.locator('thead tr').last().locator('th').allInnerTexts();
    const rows = await table.locator('tbody tr').evaluateAll(elements=>elements.map(tr=>[...tr.querySelectorAll('td')].map(td=>td.innerText)));
    if (!rows.length) throw new Error('IV30_EMPTY_TABLE');
    const parsed = parseRows(headers, rows);
    const info = await page.locator('#iv_rankings_report_tbl_wrapper').innerText();
    const count = info.match(/Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+([\d,]+)\s+entries/);
    if (!count) throw new Error('IV30_COUNT_MISSING');
    const total = Number(count[1].replaceAll(',',''));
    if (!(total>0 && total<=10000) || (expected !== undefined && expected !== total)) throw new Error('IV30_COUNT_CHANGED');
    expected = total;
    for (const record of parsed) {
      if (records.has(record.ticker)) throw new Error('IV30_DUPLICATE_SYMBOL');
      records.set(record.ticker,record);
    }
    const next = page.locator('#iv_rankings_report_tbl_next');
    if ((await next.getAttribute('class') || '').split(/\s+/).includes('disabled')) {
      if (records.size!==expected || ![...records.values()].some(r=>r.iv30Percent!==null)) throw new Error('IV30_INCOMPLETE_TABLE');
      return {schemaVersion:1,source:'Market Chameleon',sourceUrl:SOURCE_URL,ivUnit:'annualized-percent',
        observedAt:new Date().toISOString(),sourceAsOf:null,coverage:'volume-qualified-ranking',
        records:[...records.values()].sort((a,b)=>a.ticker.localeCompare(b.ticker))};
    }
    const previousFirst = parsed[0].ticker, symbolIndex = headers.map(normalHeader).indexOf('Symbol');
    await next.click();
    await page.waitForFunction(({previousFirst,symbolIndex,columns}) => {
      const row=document.querySelector('#iv_rankings_report_tbl tbody tr');
      const ticker=row?.children[symbolIndex]?.innerText.trim().toUpperCase();
      return row?.children.length===columns && /^[A-Z0-9][A-Z0-9.^/-]{0,19}$/.test(ticker || '') && ticker!==previousFirst;
    }, {previousFirst,symbolIndex,columns:headers.length},{timeout:45000});
    // Follow the normal public table pagination; no per-symbol queries.
  }
  throw new Error('IV30_PAGE_LIMIT');
}

export async function saveSnapshot(snapshot, output) {
  validateIV30(snapshot);
  await mkdir(dirname(output),{recursive:true});
  const temporary = `${output}.tmp`;
  await writeFile(temporary,JSON.stringify(snapshot,null,2)+'\n');
  await rename(temporary,output);
}

export function isTransportFailure(error) {
  return error?.name==='TimeoutError' || /net::ERR_(?:HTTP2_PROTOCOL_ERROR|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)/.test(error?.message || '');
}

async function main() {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
  const output = resolve(process.argv[2] || 'assets/current-iv30.json');
  // Try the browser's normal protocol first. A single HTTP/1.1 fallback is
  // limited to transport errors; access denials and invalid tables fail closed.
  let useHTTP1=false;
  for (let attempt=0; attempt<2; attempt++) {
    const browser = await playwright.chromium.launch({headless:process.env.IV30_HEADLESS==='true',channel:process.env.BROWSER_CHANNEL || 'chrome',args:useHTTP1 ? ['--disable-http2'] : []});
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const snapshot = await collectIV30(page);
      await saveSnapshot(snapshot,output);
      console.log(`IV30 collected: ${snapshot.records.length} symbols; observed ${snapshot.observedAt}; source update time unavailable.`);
      return;
    } catch (error) {
      if (attempt || !isTransportFailure(error)) throw error;
      useHTTP1=/net::ERR_HTTP2_PROTOCOL_ERROR/.test(error.message || '');
      console.warn(`IV30 transient load failure; retrying once${useHTTP1 ? ' with HTTP/1.1' : ' with the same normal browser protocol'}.`);
      await new Promise(resolve=>setTimeout(resolve,3000));
    } finally { await browser.close(); }
  }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(`IV30 refresh failed (${error.message}); previous snapshot preserved. No challenge bypass is attempted.`);process.exitCode=1;});
}
