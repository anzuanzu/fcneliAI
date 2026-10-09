import {validateSnapshot} from './iv-engine.mjs';
import {CSV_TEMPLATE, importSnapshots} from './iv-import.mjs';
import {validateHistory, summarizeHistoricalVolatility} from './historical-volatility.mjs';
import {historyFailure, historyRetrySeconds} from './history-errors.mjs';
import {IV_MONTHS, buildTermSummaries, renderTermCell, optionsChainUrl, queryTargets, validLevels} from './iv-table.mjs';

const $ = id => document.getElementById(id);
const snapshots = new Map(), histories = new Map(), labels = new Map();
let tableTerms = new Map();
let simulation = null, generation = 0, report = null, fetching = false;
let fetchEpoch = 0, fetchController = null;
let historyRetryAt = 0, historyRetryTimer = null;
const historyFetchLabel = $('historyFetch').textContent;
function updateHistoryFetch() {
  clearTimeout(historyRetryTimer);
  const seconds = Math.max(0, Math.ceil((historyRetryAt - Date.now()) / 1000));
  $('historyFetch').disabled = fetching || seconds > 0;
  $('historyFetch').textContent = seconds > 0 ? `請等待 ${seconds} 秒再查詢` : historyFetchLabel;
  if (seconds > 0) historyRetryTimer = setTimeout(updateHistoryFetch, 1000);
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '缺資料';
const qualityText = {good: '資料可用', limited: '資料受限', stale: '資料過期', missing: '缺資料'};
const context = () => window.getFcnResearchContext();
const historicalMode = () => $('ivMode').value === 'historical-estimate';
const scenarioText = {low:'低波動', base:'基準', high:'高波動＋相關性壓力'};
function updateMode() {
  const estimated = historicalMode();
  $('historyControls').hidden = !estimated; $('marketControls').hidden = estimated;
  $('marketApiControls').hidden = estimated; $('ivRhoField').hidden = estimated;
  $('ivModelNote').textContent = estimated
    ? '歷史估計使用各天期預測波動率與共同日期的歷史相關性；高波動情境另提高相關性。以風險中立模型計算票息，沒有把歷史資料變成市場 IV。利率及股息是你的輸入假設，未含財報跳躍、離散股息與銀行成本。'
    : '模型使用各股票該天期 ATM IV 的固定波動率與共同相關係數，未校準整個偏斜曲面、財報跳躍、離散股息或尾端相關性。利率、股息及相關係數都是你的輸入假設，並非即時市場資料。';
}
function describeError(message) {
  return String(message)
    .replace(/([A-Z0-9.^/-]+): (ATM|K|KI|KO) IV has no coverage; simulation disabled/g, '$1：$2 缺少有效 IV 覆蓋，此天期不試算')
    .replace(/([A-Z0-9.^/-]+): (ATM|K|KI|KO) IV quality is (good|limited|stale); trustworthy current IV is required/g,
      (_, ticker, level, quality) => `${ticker}：${level} ${qualityText[quality]}，需時間與品質可確認的 IV 才能試算`);
}

function tickers() {
  const typed = $('ivTickers').value.trim();
  const values = typed ? typed.split(/[\s,，]+/) : context().tickers;
  const unique = [...new Set(values.filter(Boolean).map(t => t.toUpperCase()))];
  if (unique.some(t => !/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/.test(t))) throw new Error('股票代碼格式不正確');
  if (unique.length > 20) throw new Error('每次最多研究 20 檔股票；商品模擬最多 6 檔');
  return unique;
}
function status(message, kind = '') {
  $('ivStatus').textContent = message; $('ivStatus').dataset.kind = kind;
}
function estimateCell(estimate) {
  if (!estimate) return '缺資料<small>不外推</small>';
  return `${percent(estimate.iv)}<small>${estimate.method === 'quoted' ? '合約 IV' : '插值 IV'} · ${qualityText[estimate.quality]}</small>`;
}
function renderSurface() {
  const params = context(), now = new Date();
  tableTerms = buildTermSummaries(snapshots, params, now);
  renderQueryGuide(params, now);
  if (historicalMode()) return renderHistorical();
  labels.clear();
  for (const [ticker, snapshot] of snapshots) {
    try {
      const summary = tableTerms.get(ticker)?.get(params.months);
      labels.set(ticker, summary.atm ? `${percent(summary.atm.iv)} · ${qualityText[summary.atm.quality]}` : '缺資料');
    } catch { labels.set(ticker, '資料不符'); }
  }
  let selected;
  try { selected = tickers(); } catch (error) { status(error.message, 'error'); return; }
  if (!selected.length) {
    $('ivSurface').innerHTML = '<p class="iv-note">請勾選股票，或在上方輸入研究代碼。即使股票行情暫時無法載入，仍可手動輸入代碼與匯入資料。</p>';
    $('ivDataDetails').replaceChildren(); return;
  }
  const rows = [], summaries = [];
  for (const ticker of selected) {
    const snapshot = snapshots.get(ticker);
    if (!snapshot) {
      rows.push(`<tr><td>${escape(ticker)}</td><td>3–6 個月</td><td colspan="7">尚未匯入選擇權資料</td></tr>`); continue;
    }
    for (const months of [3, 4, 5, 6]) {
      try {
        const summary = tableTerms.get(ticker)?.get(months);
        if (!summary) throw new Error(validLevels(params) ? '資料不符或無覆蓋' : '條件不符：需 0 < KI ≤ K ≤ 100%，且 K ≤ KO ≤ 200%');
        summaries.push(summary);
        const skew = summary.ki && summary.atm ? `${((summary.ki.iv - summary.atm.iv) * 100).toFixed(2)} pp` : '缺資料';
        rows.push(`<tr><td>${escape(ticker)}</td><td>${months} 個月<small>${summary.targetDate}</small></td><td>$${snapshot.spot.toFixed(2)}</td><td>${estimateCell(summary.atm)}</td><td>${estimateCell(summary.k)}</td><td>${estimateCell(summary.ki)}</td><td>${estimateCell(summary.ko)}</td><td>${skew}</td><td>${qualityText[summary.quality.status]}<small>${summary.quality.complete ? '四個價位皆有覆蓋' : '部分價位缺資料'}</small></td></tr>`);
      } catch (error) {
        rows.push(`<tr><td>${escape(ticker)}</td><td>${months} 個月</td><td colspan="7">${escape(error.message)}</td></tr>`);
      }
    }
  }
  $('ivSurface').innerHTML = `<p class="iv-note">所有 IV 為年化；KI−ATM 為百分點差。表格可左右捲動查看完整資料。</p><table class="iv-table"><thead><tr><th>股票</th><th>到期日</th><th>快照股價</th><th>ATM IV</th><th>K ${escape(params.kPct)}%</th><th>KI ${escape(params.kiPct)}%</th><th>KO ${escape(params.koPct)}%</th><th>KI−ATM</th><th>資料狀態</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  $('ivDataDetails').innerHTML = selected.filter(t => snapshots.has(t)).map(ticker => {
    const snapshot = snapshots.get(ticker), warnings = [...new Set(summaries.filter(s => s.ticker === ticker).flatMap(s => s.warnings))];
    const provider = typeof snapshot.source === 'string' ? snapshot.source : JSON.stringify(snapshot.source);
    return `<details class="iv-data-detail"><summary>${escape(ticker)} · 來源與覆蓋明細（${snapshot.contracts.length} 筆合約）</summary><p>來源：${escape(provider)}<br>快照時間：${escape(snapshot.asOf)}<br>股價時間：${escape(snapshot.spotAsOf)}</p><p class="iv-note">價差超過中間價 50%、零買價或交叉報價不使用。時間不明會標示受限；超過 72 個平日時數會標示過期。這是簡化品質檢查，未套用交易所假日日曆。價位或到期日缺少上下界時不外推。</p>${warnings.length ? `<ul>${warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul>` : ''}<details><summary>插值所用到期日、履約價與時間戳</summary><pre>${escape(JSON.stringify(summaries.filter(s => s.ticker === ticker).map(s => ({months:s.months, atm:s.atm?.coverage, k:s.k?.coverage, ki:s.ki?.coverage, ko:s.ko?.coverage})), null, 2))}</pre></details></details>`;
  }).join('');
}
function renderHistorical() {
  const params = context(), now = new Date();
  labels.clear();
  for (const [ticker, history] of histories) {
    try { const s = summarizeHistoricalVolatility(history, {...params,now}); labels.set(ticker, `${percent(s.forecastVolatility)} · 歷史估計`); }
    catch { labels.set(ticker, '歷史資料受限'); }
  }
  let selected; try { selected = tickers(); } catch(error) { $('historyStatus').textContent = error.message; return; }
  const rows = [], details = [];
  for (const ticker of selected) {
    const history = histories.get(ticker);
    if (!history) { rows.push(`<tr><td>${escape(ticker)}</td><td colspan="8">尚未取得歷史股價</td></tr>`); continue; }
    try {
      const summaries = [3,4,5,6].map(months => summarizeHistoricalVolatility(history,{now,months}));
      for (const s of summaries) {
        const low = summarizeHistoricalVolatility(history,{now,months:s.months,scenario:'low'});
        const high = summarizeHistoricalVolatility(history,{now,months:s.months,scenario:'high'});
        rows.push(`<tr><td>${escape(ticker)}</td><td>${s.months} 個月</td><td>${percent(s.windows[21])}</td><td>${percent(s.windows[63])}</td><td>${percent(s.windows[126])}</td><td>${percent(s.windows[252])}</td><td>${percent(s.forecastVolatility)}<small>EWMA ${percent(s.ewma)}</small></td><td>${percent(low.forecastVolatility)}～${percent(high.forecastVolatility)}<small>敏感度範圍，非信賴區間</small></td><td>${s.quality === 'good' ? '歷史資料可用' : '歷史資料受限'}<small>${s.observations} 筆日報酬 · ${escape(s.lastDate)}</small></td></tr>`);
      }
      const s = summaries[0];
      details.push(`<details class="iv-data-detail"><summary>${escape(ticker)} · 歷史來源與估計假設</summary><p>來源：${escape(s.source)}<br>最近完成收盤：${escape(s.lastDate)} · $${s.spot.toFixed(2)}<br>資料取得時間：${escape(s.asOf)}<br>調整方式：${escape(s.adjustment)}（拆股調整；現金股息仍可能造成價格報酬偏差）</p><p class="iv-note">HV 欄位為回看期間的年化歷史波動率，不是對應天期的市場 IV。情境不代表真實市場偏斜，無法從股價唯一推得 K／KI／KO 的 IV。</p>${s.warnings.length ? `<ul>${s.warnings.map(w=>`<li>${escape(w)}</li>`).join('')}</ul>` : ''}<pre>${escape(JSON.stringify(s.assumptions,null,2))}</pre></details>`);
    } catch(error) { rows.push(`<tr><td>${escape(ticker)}</td><td colspan="8">無法估計：${escape(error.message)}</td></tr>`); }
  }
  $('ivSurface').innerHTML = selected.length ? `<p class="iv-note">所有波動率皆為年化。預測值依各天期的平均預測變異數計算，未經市場 IV 校準；表格可左右捲動。</p><table class="iv-table"><thead><tr><th>股票</th><th>商品天期</th><th>HV 21 日</th><th>HV 63 日</th><th>HV 126 日</th><th>HV 252 日</th><th>基準預測波動率</th><th>低～高波動</th><th>歷史資料</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="iv-note">請勾選或輸入 1–6 檔研究股票，再自動取得歷史股價。</p>';
  $('ivDataDetails').innerHTML = details.join('');
}
window.fcnIvLabel = ticker => labels.get(ticker) || (historicalMode() ? '未取得歷史股價' : '未匯入');
window.fcnVolatilityTitle = () => historicalMode() ? '估計波動率' : 'ATM IV';
window.fcnIvTermCell = (ticker, months) => renderTermCell(tableTerms.get(ticker)?.get(months), context(), snapshots.has(ticker));
window.fcnOptionsChainUrl = optionsChainUrl;

function renderQueryGuide(params, now) {
  let selected;
  try { selected = tickers(); } catch { selected = []; }
  // A snapshot reference takes precedence over the scanner's newer stock quote,
  // so changing K/KI never silently changes the imported smile's moneyness.
  $('ivQueryGuide').innerHTML = selected.length ? selected.map(ticker => {
    const snapshot = snapshots.get(ticker), quote = window.getFcnStockQuote(ticker);
    const spot = snapshot?.spot ?? quote?.spot;
    const targets = queryTargets(spot, params, now);
    return `<div class="iv-query-card"><a href="${escape(optionsChainUrl(ticker, quote?.exchange))}" target="_blank" rel="noopener noreferrer">${escape(ticker)} ↗ TradingView 選擇權</a>${targets ? `<p>參考股價 $${spot.toFixed(2)} · ${snapshot ? '匯入快照' : '掃描行情，僅供查詢定位'}${snapshot ? ` · ${escape(snapshot.spotAsOf)}` : ''}<br>ATM $${targets.atm.toFixed(2)} ／ K ${escape(params.kPct)}% $${targets.k.toFixed(2)} ／ KI ${escape(params.kiPct)}% $${targets.ki.toFixed(2)}</p><p>${targets.dates.map(d=>`${d.months} 個月 <b>${d.date}</b>`).join(' · ')}</p>` : '<p>請匯入股價快照或載入股票行情，並填入有效 K／KI／KO，才能換算查詢價位。</p>'}${quote?.exchange ? '' : '<small>未確認交易所：在 TradingView 搜尋此代碼。</small>'}</div>`;
  }).join('') : '<p class="iv-note">勾選股票或輸入研究代碼後，這裡會列出查詢入口、目標到期日與 ATM／K／KI 履約價。</p>';
}
$('ivOpenImport').addEventListener('click', () => {
  $('ivResearchPanel').open = true;
  $('ivMode').value = 'market-iv'; updateMode(); invalidate();
  $('marketControls').scrollIntoView({behavior:'smooth', block:'center'});
});

function cancel(message = '已停止計算。') {
  generation++;
  if (simulation) simulation.terminate();
  simulation = null;
  $('ivCompare').disabled = false;
  $('ivCancel').hidden = true;
  if (message) $('ivSimulationStatus').textContent = message;
}
function stopFetch() {
  if ($('historySetupStatus').textContent.startsWith('正在檢查')) setupStatus('設定檢查已取消，請重新檢查。');
  fetchEpoch++;
  fetchController?.abort(); fetchController = null;
  fetching = false; $('ivFetch').disabled = false;
  updateHistoryFetch();
  $('historyCheck').disabled = false;
}
function invalidate() {
  stopFetch();
  cancel(null); report = null;
  $('ivExport').disabled = true;
  $('ivComparisons').replaceChildren();
  $('ivSimulationStatus').textContent = '資料或條件已變更，請重新計算。';
  renderSurface(); window.refreshFcnTable();
}
function download(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], {type: mime}));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('ivTemplate').addEventListener('click', () => download(CSV_TEMPLATE, 'iv-input-template.csv', 'text/csv;charset=utf-8'));
$('ivImport').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  stopFetch();
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('檔案過大，限 4 MB');
    const imported = importSnapshots(await file.text());
    for (const snapshot of imported) snapshots.set(snapshot.ticker, snapshot);
    $('ivMode').value = 'market-iv'; updateMode();
    if (!$('ivTickers').value.trim() && !context().tickers.length) $('ivTickers').value = imported.slice(0, 20).map(s => s.ticker).join(', ');
    invalidate();
    const warnings = imported.reduce((n, s) => n + s.warnings.length, 0);
    status(`已匯入 ${imported.length} 檔股票，${imported.reduce((n, s) => n + s.contracts.length, 0)} 筆合約。${warnings ? `有 ${warnings} 項資料提示，請展開來源與覆蓋明細。` : ''} 僅保留於本次頁面。`, 'success');
  } catch (error) { status(`匯入失敗：${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
$('ivUseSelection').addEventListener('click', () => { $('ivTickers').value = ''; invalidate(); });
$('ivClear').addEventListener('click', () => { snapshots.clear(); invalidate(); status('已清除全部匯入資料。'); });
$('historyClear').addEventListener('click', () => { histories.clear(); invalidate(); $('historyStatus').textContent = '已清除歷史股價。'; });
$('ivMode').addEventListener('change', () => { updateMode(); invalidate(); });
document.addEventListener('fcn-context-change', invalidate);
['ivTickers','ivRho','ivRate','ivDividend','ivLockout','ivKiObservation','ivPaths'].forEach(id => $(id).addEventListener('input', invalidate));

function renderComparisons() {
  const params = report.input;
  const estimated = params.mode === 'historical-estimate';
  const scenarioCell = row => estimated ? `<td>${escape(scenarioText[row.scenario])}</td>` : '';
  const correlations = estimated ? report.results.filter(r=>r.result && r.months===3).map(row=>`<details class="iv-data-detail"><summary>${escape(scenarioText[row.scenario])} · 相關性矩陣與模型限制</summary><p>矩陣股票順序：${escape(report.tickers.join(', '))}</p><pre>${escape(JSON.stringify({correlationMatrix:row.result.input.correlationMatrix,limitations:row.result.limitations},null,2))}</pre></details>`).join('') : '';
  $('ivComparisons').innerHTML = `<p class="iv-note">${estimated ? '歷史波動率情境試算（未校準市場 IV） · ' : ''}研究股票：${escape(report.tickers.join(', '))} · K ${params.kPct}% / KO ${params.koPct}% / KI ${params.kiPct}% · ${params.kiObservation === 'maturity' ? '到期 KI' : '每日近似收盤 KI'} · 首個 KO：第 ${params.lockoutMonths + 1} 月</p><table class="iv-table"><thead><tr>${estimated ? '<th>情境假設</th>' : ''}<th>天期</th><th>模型年化票息</th><th>預期累計票息（Q）</th><th>KO（Q）</th><th>KI（Q）</th><th>本金損失（Q）</th><th>預期存續月數</th></tr></thead><tbody>${report.results.map(row => {
    if (row.error) return `<tr>${scenarioCell(row)}<td>${row.months} 個月</td><td colspan="6">無法估算：${escape(describeError(row.error))}</td></tr>`;
    const r = row.result;
    return `<tr>${scenarioCell(row)}<td>${row.months} 個月</td><td>${percent(r.fairCouponAnnual)}<small>抽樣標準誤 ${percent(r.seCouponAnnual)}</small></td><td>${percent(r.expectedCouponPaid)}</td><td>${percent(r.probabilitiesQ.ko)}</td><td>${percent(r.probabilitiesQ.ki)}</td><td>${percent(r.probabilitiesQ.principalLoss)}</td><td>${(r.expectedLifeYears * 12).toFixed(2)}</td></tr>`;
  }).join('')}</tbody></table><p class="iv-note">預期累計票息是模型下收到的票息占本金比例，會受提前 KO 影響；本金損失另計。只有 Monte Carlo 抽樣誤差，沒有包含模型偏差。0% 可能只是本次抽樣未觀察到事件；研究匯出包含機率抽樣區間。${estimated ? '低／基準／高情境是固定波動率敏感度假設，不是票息預測區間或市場報價；K／KI／KO 僅改變支付條件。' : ''}</p>${correlations}`;
}
$('ivCompare').addEventListener('click', () => {
  try {
    const selected = tickers();
    if (!selected.length || selected.length > 6) throw new Error('商品模擬請選擇 1–6 檔股票');
    const estimated = historicalMode();
    if (selected.some(t => !(estimated ? histories : snapshots).has(t))) throw new Error(estimated ? '請先自動取得所有研究股票的歷史股價' : '請先匯入所有研究股票的選擇權資料');
    const params = context();
    const input = {...params, rho: Number($('ivRho').value), rate: Number($('ivRate').value) / 100,
      dividendYields: selected.map(() => Number($('ivDividend').value) / 100),
      lockoutMonths: Number($('ivLockout').value) - 1, kiObservation: $('ivKiObservation').value,
      paths: Number($('ivPaths').value), seed: 20261009, now: new Date().toISOString(), mode:estimated ? 'historical-estimate' : 'market-iv'};
    if (!(estimated ? ['ivRate','ivDividend','ivLockout'] : ['ivRho','ivRate','ivDividend','ivLockout']).every(id => $(id).value.trim() !== '' && $(id).checkValidity())) throw new Error('請填入有效的利率、股息率、相關係數及 KO 觀察月');
    if (estimated) delete input.rho;
    if (!(input.kiPct > 0 && input.kiPct <= input.kPct && input.kPct <= 100 && input.kPct <= input.koPct && input.koPct <= 200)) throw new Error('本模型需 0 < KI ≤ K ≤ 100%，且 K ≤ KO ≤ 200%');
    cancel(null);
    const id = generation;
    report = {schemaVersion: 1, createdAt: input.now, tickers: selected, input, results: [],
      ...(estimated ? {histories:selected.map(t=>histories.get(t))} : {snapshots:selected.map(t=>snapshots.get(t))}),
      reliance: estimated ? 'Historical-input risk-neutral GBM sensitivity research only. Forecast volatility and correlation are historical estimates, not market IV or implied dependence. Scenarios are assumptions, not confidence intervals or executable coupons. No fees, issuer credit, skew, discrete dividends, earnings jumps or tail dependence.' : 'Simplified constant ATM IV risk-neutral GBM research only. No market quote or real-world probability. No fees, issuer credit, skew calibration, discrete dividends, earnings jumps or tail dependence.'};
    $('ivCompare').disabled = true; $('ivCancel').hidden = false; $('ivExport').disabled = true;
    $('ivComparisons').replaceChildren();
    simulation = new Worker(new URL('./fcn-simulation-worker.mjs', import.meta.url), {type: 'module'});
    simulation.onmessage = ({data}) => {
      if (id !== generation) return;
      if (data.type === 'term') $('ivSimulationStatus').textContent = `正在計算 ${scenarioText[data.scenario] || ''} ${data.months} 個月條件…`;
      if (data.type === 'result') { report.results.push(data); renderComparisons(); }
      if (data.type === 'complete') {
        cancel(null);
        $('ivExport').disabled = !report.results.some(r => r.result);
        $('ivSimulationStatus').textContent = '比較完成。資料不足或受限的天期已列出原因；結果僅適用於上述條款與假設。';
      }
      if (data.type === 'error') { cancel(`計算失敗：${data.error}`); report = null; }
    };
    simulation.onerror = () => { cancel('計算模組載入失敗，請重新整理或以網站網址開啟頁面。'); report = null; };
    simulation.postMessage({...input, ...(estimated ? {histories:report.histories} : {snapshots:report.snapshots})});
  } catch (error) { $('ivSimulationStatus').textContent = error.message; }
});
$('ivCancel').addEventListener('click', () => { cancel(); report = null; $('ivComparisons').replaceChildren(); $('ivExport').disabled = true; });
$('ivExport').addEventListener('click', () => { if (report) download(JSON.stringify(report, null, 2), `fcn-research-${report.createdAt.slice(0, 10)}.json`, 'application/json'); });

const endpoint = new URL(window.FCNELI_OPTIONS_API_URL || window.FCNELI_SCAN_API_URL || location.origin);
if (endpoint.hostname !== 'scanner.tradingview.com') {
  if (!window.FCNELI_OPTIONS_API_URL) { endpoint.pathname = '/api/options'; endpoint.search = ''; }
  $('ivEndpoint').value = endpoint.toString();
}
$('ivFetch').addEventListener('click', async () => {
  if (fetching) return;
  let count = 0, errors = [], requestEpoch;
  const pending = new Map();
  try {
    const selected = tickers(); if (!selected.length) throw new Error('請先選擇或輸入研究股票');
    const api = new URL($('ivEndpoint').value);
    if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost','127.0.0.1'].includes(api.hostname))) throw new Error('API 需使用 HTTPS');
    invalidate();
    requestEpoch = fetchEpoch;
    fetchController = new AbortController();
    const signal = fetchController.signal;
    fetching = true; $('ivFetch').disabled = true;
    for (const ticker of selected) {
      status(`正在查詢 ${ticker}…`);
      api.searchParams.set('ticker', ticker);
      const headers = {}; const key = $('ivAccessKey').value;
      if (key) headers['X-Options-Key'] = key;
      try {
        const response = await fetch(api, {headers, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])});
        if (requestEpoch !== fetchEpoch) return;
        let body; try { body = await response.json(); } catch { throw new Error('接口尚未部署或未回傳 JSON'); }
        if (!response.ok) {
          const code = typeof body.error === 'string' ? body.error : body.code || body.error?.code;
          if (response.status === 404 || response.status === 503) throw new Error('自動查詢尚未設定，請先使用手動匯入');
          if (response.status === 401 || response.status === 403) throw new Error('查詢未授權，請確認 Worker 個人查詢密碼');
          throw new Error(`資料來源回應失敗 (${response.status}${code ? ` / ${code}` : ''})`);
        }
        const snapshot = validateSnapshot(body);
        if (snapshot.ticker.replaceAll('.', '/') !== ticker.replaceAll('.', '/')) throw new Error('回傳股票代碼不符');
        pending.set(ticker, {...snapshot, ticker}); count++;
      } catch (error) { if (requestEpoch !== fetchEpoch) return; errors.push(`${ticker}：${error.message}`); }
    }
    if (requestEpoch !== fetchEpoch) return;
    for (const [ticker, snapshot] of pending) snapshots.set(ticker, snapshot);
    invalidate(); status(`已取得 ${count} 檔資料。${errors.join('；')}`, errors.length ? 'error' : 'success');
  } catch (error) { status(error.message, 'error'); }
  finally { if (requestEpoch === fetchEpoch) stopFetch(); }
});
const historyEndpoint = new URL(window.FCNELI_HISTORY_API_URL || endpoint);
if (!window.FCNELI_HISTORY_API_URL) { historyEndpoint.pathname = '/api/history'; historyEndpoint.search = ''; }
$('historyEndpoint').value = historyEndpoint.toString();
function historyApiUrl() {
  const api = new URL($('historyEndpoint').value);
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost','127.0.0.1'].includes(api.hostname))) throw new Error('API 需使用 HTTPS');
  if (api.username || api.password || api.pathname !== '/api/history' || api.search || api.hash)
    throw new Error('請填 Worker 的 /api/history 網址，不要包含金鑰、參數或片段');
  return api;
}
function setupStatus(message, kind = '') {
  $('historySetupStatus').textContent = message; $('historySetupStatus').dataset.kind = kind;
}
['historyEndpoint','historyAccessKey'].forEach(id => $(id).addEventListener('input', () => {
  stopFetch(); setupStatus('設定已變更，請重新檢查 Worker 設定。');
}));
$('historyCheck').addEventListener('click', async () => {
  if (fetching) return;
  let requestEpoch;
  try {
    const api = historyApiUrl(); api.pathname += '/status';
    stopFetch(); requestEpoch = fetchEpoch;
    fetchController = new AbortController();
    fetching = true; $('historyCheck').disabled = true; $('historyFetch').disabled = true;
    setupStatus('正在檢查 Worker 設定（不查詢行情）…');
    const headers = {}; if ($('historyAccessKey').value) headers['X-History-Key'] = $('historyAccessKey').value;
    const response = await fetch(api, {headers, signal: AbortSignal.any([fetchController.signal, AbortSignal.timeout(10000)])});
    if (requestEpoch !== fetchEpoch) return;
    if (response.status === 404) throw new Error('請先部署新版 Worker，舊版尚無設定檢查接口');
    if (response.status === 403) throw new Error('網站來源不符，請檢查 Worker 的 ALLOWED_ORIGIN');
    if (!response.ok) throw new Error(`設定檢查失敗 (${response.status})`);
    let body; try { body = await response.json(); } catch { throw new Error('請確認網址並部署新版 Worker（接口未回傳 JSON）'); }
    if (requestEpoch !== fetchEpoch) return;
    if (body.schemaVersion !== 1 || body.kind !== 'history-configuration' ||
        ['providerConfigured','accessConfigured','usageConfirmed','configurationReady'].some(key => typeof body[key] !== 'boolean') ||
        ![true,false,null].includes(body.accessVerified) || body.providerConnectionTested !== false)
      throw new Error('設定檢查格式不符，請部署新版 Worker');
    const missing = [];
    if (!body.providerConfigured) missing.push('設定 TWELVE_DATA_API_KEY secret');
    if (!body.accessConfigured) missing.push('設定 HISTORY_ACCESS_KEY secret');
    if (!body.usageConfirmed) missing.push('核對帳戶個人研究與展示授權，再設定 HISTORY_DISPLAY_LICENSE_CONFIRMED=true');
    if (body.accessConfigured && body.accessVerified === false) missing.push('個人查詢密碼不符');
    setupStatus(missing.length ? `尚需：${missing.join('；')}。請參照個人使用設定指引。`
      : `Worker 設定齊全${body.accessVerified === true ? '，個人查詢密碼正確' : '；請輸入個人查詢密碼'}。尚未驗證真實金鑰、股票覆蓋或資料品質，取價成功後才能確認。`, missing.length ? 'error' : 'success');
  } catch(error) {
    if (requestEpoch === undefined || requestEpoch === fetchEpoch) setupStatus(error.message, 'error');
  } finally { if (requestEpoch === fetchEpoch) stopFetch(); }
});
$('historyFetch').addEventListener('click', async () => {
  if (fetching || historyRetryAt > Date.now()) return;
  let requestEpoch; const pending = new Map(), errors = [];
  try {
    const selected = tickers();
    if (!selected.length || selected.length > 6) throw new Error('自動取價每次請選擇 1–6 檔股票，避免超過免費額度');
    const api = historyApiUrl();
    if (api.username || api.password) throw new Error('API 網址不可包含密碼');
    invalidate(); requestEpoch = fetchEpoch;
    fetchController = new AbortController(); const signal = fetchController.signal;
    fetching = true; $('historyFetch').disabled = true; $('historyCheck').disabled = true;
    for (const ticker of selected) {
      $('historyStatus').textContent = `正在取得 ${ticker} 歷史股價…`;
      api.searchParams.set('ticker',ticker);
      try {
        const headers = {}; if ($('historyAccessKey').value) headers['X-History-Key'] = $('historyAccessKey').value;
        const response = await fetch(api,{headers,signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
        if (requestEpoch !== fetchEpoch) return;
        let body; try { body = await response.json(); } catch { throw new Error('歷史股價接口尚未部署或未回傳 JSON'); }
        if (!response.ok) {
          const failure = historyFailure(body, response.status);
          if (failure.rateLimited) {
            const seconds = historyRetrySeconds(body, response.headers.get('Retry-After'));
            historyRetryAt = Date.now() + seconds * 1000;
            failure.message += `；至少等待 ${seconds} 秒（不會自動重試）`;
            updateHistoryFetch();
          }
          errors.push(`${ticker}：${failure.message}`);
          if (failure.stopBatch) {
            const remaining = selected.slice(selected.indexOf(ticker) + 1);
            if (remaining.length) errors.push(`本次批次已停止；未查詢：${remaining.join('、')}`);
            break;
          }
          continue;
        }
        const history = validateHistory(body);
        if (history.ticker.replaceAll('.', '/') !== ticker.replaceAll('.', '/')) throw new Error('回傳股票代碼不符');
        pending.set(ticker,{...history,ticker});
      } catch(error) {
        if (requestEpoch !== fetchEpoch) return;
        errors.push(`${ticker}：${error.message}`);
        const remaining = selected.slice(selected.indexOf(ticker) + 1);
        if (remaining.length) errors.push(`本次批次已停止；未查詢：${remaining.join('、')}`);
        break;
      }
    }
    if (requestEpoch !== fetchEpoch) return;
    for (const [ticker,history] of pending) histories.set(ticker,history);
    invalidate(); $('historyStatus').textContent = `已取得 ${pending.size} 檔歷史股價。${errors.join('；')}${pending.size ? ' 請核對來源，再比較商品條件。' : ''}`;
    $('historyStatus').dataset.kind = errors.length ? 'error' : 'success';
  } catch(error) { $('historyStatus').textContent = error.message; $('historyStatus').dataset.kind = 'error'; }
  finally { if (requestEpoch === fetchEpoch) stopFetch(); }
});
updateMode();
renderSurface();
window.refreshFcnTable();
