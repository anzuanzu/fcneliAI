import {addCalendarMonths, summarizeSurface} from './iv-engine.mjs';
import {summarizeHistoricalVolatility} from './historical-volatility.mjs';

export const IV_MONTHS = [3, 4, 5, 6];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const quality = {good:'可用', limited:'受限', stale:'過期'};

export function validLevels({kPct, kiPct, koPct}) {
  return [kPct, kiPct, koPct].every(Number.isFinite) && kiPct > 0 && kiPct <= kPct && kPct <= 100 && kPct <= koPct && koPct <= 200;
}

// Market mode only reads option snapshots. Historical mode has a separate
// renderer and labels, never fabricated strike-specific IV.
export function buildTermSummaries(snapshots, params, now = new Date()) {
  const terms = new Map();
  if (!validLevels(params)) return terms;
  for (const [ticker, snapshot] of snapshots) {
    const byMonth = new Map();
    for (const months of IV_MONTHS) {
      try { byMonth.set(months, summarizeSurface(snapshot, {...params, months, now})); }
      catch { byMonth.set(months, null); }
    }
    terms.set(ticker, byMonth);
  }
  return terms;
}

export function renderTermCell(summary, params, hasSnapshot = false) {
  if (!validLevels(params)) return '<span class="iv-cell-note">條件不符<br>需 0 &lt; KI ≤ K ≤ 100<br>K ≤ KO ≤ 200</span>';
  const levels = [['atm','ATM'], ['k',`K ${params.kPct}%`], ['ki',`KI ${params.kiPct}%`]];
  const title = summary ? `到期目標 ${summary.targetDate}；參考股價 $${summary.spot.toFixed(2)}；快照 ${summary.asOf}；來源 ${typeof summary.source === 'string' ? summary.source : JSON.stringify(summary.source)}` : '';
  const lines = levels.map(([key,label]) => {
    const estimate = summary?.[key];
    return `<div class="iv-cell-line"><span>${escape(label)}</span><div>${estimate ? `<strong>${(estimate.iv * 100).toFixed(2)}%</strong><small class="iv-quality-${estimate.quality}">${estimate.method === 'quoted' ? '合約' : '插值'} · ${quality[estimate.quality]}</small>` : '<strong>—</strong><small>缺資料</small>'}</div></div>`;
  }).join('');
  return `<div class="iv-term-cell" title="${escape(title)}">${lines}<small class="iv-cell-note">${summary ? escape(summary.targetDate) : hasSnapshot ? '資料不符或無覆蓋' : '尚未匯入'}</small></div>`;
}

export function buildHistoricalTerms(histories, now = new Date()) {
  const terms = new Map();
  for (const [ticker, history] of histories) {
    terms.set(ticker, new Map(IV_MONTHS.map(months => {
      try { return [months, {summary:summarizeHistoricalVolatility(history,{months,now})}]; }
      catch (error) { return [months, {error:error.message}]; }
    })));
  }
  return terms;
}

export function renderHistoricalTermCell(term, params) {
  if (!term) return '<div class="iv-term-cell"><strong>—</strong><small>尚未取得歷史股價</small><small>勾選後按「自動取得並估算」</small></div>';
  if (term.error) return `<div class="iv-term-cell"><strong>無法估算</strong><small>${escape(term.error)}</small><small>請重新取得有效歷史股價</small></div>`;
  const s = term.summary, pct = v => `${(v*100).toFixed(2)}%`;
  const title = `來源 ${s.source}；最近收盤 ${s.lastDate} $${s.spot.toFixed(2)}；取得時間 ${s.asOf}；低高範圍為敏感度假設，非信賴區間`;
  const {low,high} = s.assumptions.scenarioMultipliers;
  const barriers = validLevels(params)
    ? `<div class="iv-cell-line"><span>K ${escape(params.kPct)}%</span><strong>$${(s.spot*params.kPct/100).toFixed(2)}</strong></div><div class="iv-cell-line"><span>KI ${escape(params.kiPct)}%</span><strong>$${(s.spot*params.kiPct/100).toFixed(2)}</strong></div>`
    : '<small>條件不符：需 0 &lt; KI ≤ K ≤ 100，K ≤ KO ≤ 200</small>';
  return `<div class="iv-term-cell iv-history-cell" title="${escape(title)}"><strong class="iv-history-value">${pct(s.forecastVolatility)}</strong><small>歷史估計 · ${s.quality === 'good' ? '可用' : '受限'}</small><small>低／高 ${pct(s.forecastVolatility*low)}–${pct(s.forecastVolatility*high)}</small>${barriers}<small>收盤 ${escape(s.lastDate)}</small></div>`;
}

export function optionsChainUrl(ticker, exchange) {
  if (!/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/.test(ticker) || !/^[A-Z][A-Z0-9_]{0,19}$/.test(exchange || '')) return 'https://www.tradingview.com/options/';
  return `https://www.tradingview.com/symbols/${encodeURIComponent(exchange)}-${encodeURIComponent(ticker.replaceAll('/', '.'))}/options-chain/`;
}

export function queryTargets(spot, params, now = new Date()) {
  if (!(Number.isFinite(spot) && spot > 0) || !validLevels(params)) return null;
  return {atm:spot, k:spot * params.kPct / 100, ki:spot * params.kiPct / 100,
    dates: IV_MONTHS.map(months => ({months, date:addCalendarMonths(now, months).toISOString().slice(0,10)}))};
}
