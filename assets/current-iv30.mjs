import {weekdayHoursBetween} from './iv-engine.mjs';
export const IV30_SOURCE = 'https://marketchameleon.com/volReports/VolatilityRankings';
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function validateIV30(raw, now = new Date()) {
  if (raw?.schemaVersion!==1 || raw.source!=='Market Chameleon' || raw.sourceUrl!==IV30_SOURCE || raw.ivUnit!=='annualized-percent' || raw.sourceAsOf!==null) throw new Error('IV30_SOURCE_INVALID');
  if (typeof raw.observedAt!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt)) || Date.parse(raw.observedAt)>+now+300000) throw new Error('IV30_TIME_INVALID');
  if (!Array.isArray(raw.records) || !raw.records.length || raw.records.length>10000) throw new Error('IV30_RECORDS_INVALID');
  const byTicker = new Map();
  for (const r of raw.records) {
    if (!/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/.test(r?.ticker || '') || byTicker.has(r.ticker)) throw new Error('IV30_SYMBOL_INVALID');
    if (r.iv30Percent!==null && (!Number.isFinite(r.iv30Percent) || r.iv30Percent<=0 || r.iv30Percent>1000)) throw new Error('IV30_VALUE_INVALID');
    byTicker.set(r.ticker,r.iv30Percent);
  }
  // This is snapshot age, not quote age: the public table provides no quote timestamp.
  return {byTicker,observedAt:raw.observedAt,stale:weekdayHoursBetween(raw.observedAt,now)>24};
}

export function renderIV30Cell(snapshot,ticker,url,state='missing') {
  const value = snapshot?.byTicker.get(ticker);
  const fetched = snapshot ? new Date(snapshot.observedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '';
  const note = Number.isFinite(value) ? snapshot.stale ? '快照過期' : '來源快照' : snapshot ? snapshot.byTicker.has(ticker) ? '來源缺值' : '來源未覆蓋' : state==='loading' ? '載入 IV30…' : state==='failed' ? '資料載入失敗' : '尚未接入';
  const title = snapshot ? `取得時間（台北）：${fetched}；原站未提供報價更新時間；此值為 30 天隱含波動率的年化百分比` : '';
  return `<div class="iv30-cell" title="${escape(title)}"><strong class="${snapshot?.stale ? 'iv30-stale' : ''}">${Number.isFinite(value) ? value.toFixed(1)+'%' : '—'}</strong><small>${note}</small>${snapshot ? `<small>取得 ${escape(fetched)}</small>` : ''}<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" class="iv-chain-link" aria-label="${escape(ticker)} Market Chameleon IV30 查詢">查詢 IV30 ↗</a></div>`;
}

export function compareIV30(a,b,direction='desc') {
  const hasA=Number.isFinite(a), hasB=Number.isFinite(b);
  if (!hasA || !hasB) return hasA ? -1 : hasB ? 1 : 0;
  return direction==='asc' ? a-b : b-a;
}

if (typeof window !== 'undefined') {
  let snapshot=null,state='loading',busy=false;
  window.fcnCurrentIv30Cell = (ticker,url) => renderIV30Cell(snapshot,ticker,url,state);
  window.fcnCurrentIv30Value = ticker => snapshot?.byTicker.get(ticker);
  window.fcnCompareIv30 = compareIV30;
  async function refresh() {
    if (busy) return;
    busy=true;
    const button=document.getElementById('iv30Reload'),status=document.getElementById('iv30Status');
    button.disabled=true;status.textContent='正在讀取 IV30 快照…';
    try {
      const response=await fetch(new URL(`./current-iv30.json?t=${Date.now()}`,import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('IV30_FETCH_FAILED');
      const text=await response.text();
      if(text.length>1000000) throw new Error('IV30_FILE_TOO_LARGE');
      snapshot=validateIV30(JSON.parse(text));state='ready';
      const fetched=new Date(snapshot.observedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      status.textContent=`已載入 ${snapshot.byTicker.size.toLocaleString('zh-TW')} 檔 IV30；取得時間（台北）${fetched}${snapshot.stale ? ' · 快照已過期' : ''}。原站未提供報價更新時間。`;
    } catch {
      state='failed';
      status.textContent=snapshot ? '重新讀取失敗；保留上次快照，請核對取得時間或開啟來源查詢。' : 'IV30 快照載入失敗，請重新讀取或開啟來源查詢。';
    } finally { busy=false;button.disabled=false;window.refreshFcnTable?.(); }
  }
  document.getElementById('iv30Reload').addEventListener('click',refresh);
  refresh();
}
