import {summarizeSurface, validateSnapshot} from './iv-engine.mjs';
import {CSV_TEMPLATE, importSnapshots} from './iv-import.mjs';

const $ = id => document.getElementById(id);
const snapshots = new Map(), labels = new Map();
let simulation = null, generation = 0, report = null, fetching = false;
let fetchEpoch = 0, fetchController = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '缺資料';
const qualityText = {good: '資料可用', limited: '資料受限', stale: '資料過期', missing: '缺資料'};
const context = () => window.getFcnResearchContext();
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
  labels.clear();
  $('ivColumnTenor').textContent = `${params.months}M`;
  for (const [ticker, snapshot] of snapshots) {
    try {
      const summary = summarizeSurface(snapshot, {...params, now});
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
        const summary = summarizeSurface(snapshot, {...params, months, now});
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
window.fcnIvLabel = ticker => labels.get(ticker) || '未匯入';

function cancel(message = '已停止計算。') {
  generation++;
  if (simulation) simulation.terminate();
  simulation = null;
  $('ivCompare').disabled = false;
  $('ivCancel').hidden = true;
  if (message) $('ivSimulationStatus').textContent = message;
}
function stopFetch() {
  fetchEpoch++;
  fetchController?.abort(); fetchController = null;
  fetching = false; $('ivFetch').disabled = false;
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
    if (!$('ivTickers').value.trim() && !context().tickers.length) $('ivTickers').value = imported.slice(0, 20).map(s => s.ticker).join(', ');
    invalidate();
    const warnings = imported.reduce((n, s) => n + s.warnings.length, 0);
    status(`已匯入 ${imported.length} 檔股票，${imported.reduce((n, s) => n + s.contracts.length, 0)} 筆合約。${warnings ? `有 ${warnings} 項資料提示，請展開來源與覆蓋明細。` : ''} 僅保留於本次頁面。`, 'success');
  } catch (error) { status(`匯入失敗：${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
$('ivUseSelection').addEventListener('click', () => { $('ivTickers').value = ''; invalidate(); });
$('ivClear').addEventListener('click', () => { snapshots.clear(); invalidate(); status('已清除全部匯入資料。'); });
document.addEventListener('fcn-context-change', invalidate);
['ivTickers','ivRho','ivRate','ivDividend','ivLockout','ivKiObservation','ivPaths'].forEach(id => $(id).addEventListener('input', invalidate));

function renderComparisons() {
  const params = report.input;
  $('ivComparisons').innerHTML = `<p class="iv-note">研究股票：${escape(report.tickers.join(', '))} · K ${params.kPct}% / KO ${params.koPct}% / KI ${params.kiPct}% · ${params.kiObservation === 'maturity' ? '到期 KI' : '每日近似收盤 KI'} · 首個 KO：第 ${params.lockoutMonths + 1} 月</p><table class="iv-table"><thead><tr><th>天期</th><th>模型年化票息</th><th>預期累計票息（Q）</th><th>KO（Q）</th><th>KI（Q）</th><th>本金損失（Q）</th><th>預期存續月數</th></tr></thead><tbody>${report.results.map(row => {
    if (row.error) return `<tr><td>${row.months} 個月</td><td colspan="6">無法估算：${escape(describeError(row.error))}</td></tr>`;
    const r = row.result;
    return `<tr><td>${row.months} 個月</td><td>${percent(r.fairCouponAnnual)}<small>抽樣標準誤 ${percent(r.seCouponAnnual)}</small></td><td>${percent(r.expectedCouponPaid)}</td><td>${percent(r.probabilitiesQ.ko)}</td><td>${percent(r.probabilitiesQ.ki)}</td><td>${percent(r.probabilitiesQ.principalLoss)}</td><td>${(r.expectedLifeYears * 12).toFixed(2)}</td></tr>`;
  }).join('')}</tbody></table><p class="iv-note">預期累計票息是模型下收到的票息占本金比例，會受提前 KO 影響；本金損失另計。只有 Monte Carlo 抽樣誤差，沒有包含模型偏差。</p>`;
}
$('ivCompare').addEventListener('click', () => {
  try {
    const selected = tickers();
    if (!selected.length || selected.length > 6) throw new Error('商品模擬請選擇 1–6 檔股票');
    if (selected.some(t => !snapshots.has(t))) throw new Error('請先匯入所有研究股票的選擇權資料');
    const params = context();
    const input = {...params, rho: Number($('ivRho').value), rate: Number($('ivRate').value) / 100,
      dividendYields: selected.map(() => Number($('ivDividend').value) / 100),
      lockoutMonths: Number($('ivLockout').value) - 1, kiObservation: $('ivKiObservation').value,
      paths: Number($('ivPaths').value), seed: 20261009, now: new Date().toISOString()};
    if (!['ivRho','ivRate','ivDividend','ivLockout'].every(id => $(id).value.trim() !== '' && $(id).checkValidity())) throw new Error('請填入有效的利率、股息率、相關係數及 KO 觀察月');
    if (!(input.kiPct > 0 && input.kiPct <= input.kPct && input.kPct <= 100 && input.kPct <= input.koPct && input.koPct <= 200)) throw new Error('本模型需 0 < KI ≤ K ≤ 100%，且 K ≤ KO ≤ 200%');
    cancel(null);
    const id = generation;
    report = {schemaVersion: 1, createdAt: input.now, tickers: selected, input, results: [],
      snapshots: selected.map(t => snapshots.get(t)),
      reliance: 'Simplified constant ATM IV risk-neutral GBM research only. No market quote or real-world probability. No fees, issuer credit, skew calibration, discrete dividends, earnings jumps or tail dependence.'};
    $('ivCompare').disabled = true; $('ivCancel').hidden = false; $('ivExport').disabled = true;
    $('ivComparisons').replaceChildren();
    simulation = new Worker(new URL('./fcn-simulation-worker.mjs', import.meta.url), {type: 'module'});
    simulation.onmessage = ({data}) => {
      if (id !== generation) return;
      if (data.type === 'term') $('ivSimulationStatus').textContent = `正在計算 ${data.months} 個月條件…`;
      if (data.type === 'result') { report.results.push(data); renderComparisons(); }
      if (data.type === 'complete') {
        cancel(null);
        $('ivExport').disabled = !report.results.some(r => r.result);
        $('ivSimulationStatus').textContent = '比較完成。資料不足或受限的天期已列出原因；結果僅適用於上述條款與假設。';
      }
      if (data.type === 'error') { cancel(`計算失敗：${data.error}`); report = null; }
    };
    simulation.onerror = () => { cancel('計算模組載入失敗，請重新整理或以網站網址開啟頁面。'); report = null; };
    simulation.postMessage({...input, snapshots: report.snapshots});
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
renderSurface();
