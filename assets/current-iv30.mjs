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
  if (![...byTicker.values()].some(Number.isFinite)) throw new Error('IV30_EMPTY_VALUES');
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

export function acceptIV30(previous,raw,now=new Date()) {
  const next=validateIV30(raw,now);
  if (previous && Date.parse(next.observedAt)<Date.parse(previous.observedAt)) throw new Error('IV30_OLDER_SNAPSHOT');
  return next;
}

export function validateUpdateStatus(raw,now=new Date()) {
  if (raw?.schemaVersion!==1 || !['success','failed'].includes(raw.outcome) ||
      typeof raw.attemptedAt!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(raw.attemptedAt) ||
      !Number.isFinite(Date.parse(raw.attemptedAt)) || Date.parse(raw.attemptedAt)>+now+300000) throw new Error('IV30_STATUS_INVALID');
  return {outcome:raw.outcome,attemptedAt:raw.attemptedAt};
}

// Poll the shared published file, never the source site. Hidden tabs pause;
// returning to a tab checks immediately, and refresh() prevents overlap.
export function startIV30Polling(refresh,{document,window,setInterval,clearInterval}) {
  const visible=()=>{if(document.visibilityState==='visible') refresh();};
  const timer=setInterval(visible,5*60*1000);
  document.addEventListener('visibilitychange',visible);
  window.addEventListener('focus',visible);
  return ()=>{
    clearInterval(timer);
    document.removeEventListener('visibilitychange',visible);
    window.removeEventListener('focus',visible);
  };
}

if (typeof window !== 'undefined') {
  let snapshot=null,state='loading',busy=false,updateStatus=null;
  window.fcnCurrentIv30Cell = (ticker,url) => renderIV30Cell(snapshot,ticker,url,state);
  window.fcnCurrentIv30Value = ticker => snapshot?.byTicker.get(ticker);
  window.fcnCompareIv30 = compareIV30;
  async function readJSON(file,limit) {
    const response=await fetch(new URL(`./${file}?t=${Date.now()}`,import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('IV30_FETCH_FAILED');
    const text=await response.text();
    if(text.length>limit) throw new Error('IV30_FILE_TOO_LARGE');
    return JSON.parse(text);
  }
  async function refresh() {
    if (busy) return;
    busy=true;
    const button=document.getElementById('iv30Reload'),status=document.getElementById('iv30Status');
    button.disabled=true;status.textContent='正在讀取 IV30 快照…';
    try {
      const [data,report]=await Promise.allSettled([readJSON('current-iv30.json',1000000),readJSON('iv30-update-status.json',10000)]);
      if(data.status==='rejected') throw data.reason;
      snapshot=acceptIV30(snapshot,data.value);state='ready';
      if(report.status==='fulfilled') {
        try {
          const next=validateUpdateStatus(report.value);
          if(!updateStatus || Date.parse(next.attemptedAt)>=Date.parse(updateStatus.attemptedAt)) updateStatus=next;
        } catch { /* A status file cannot replace validated stock data. */ }
      }
      const fetched=new Date(snapshot.observedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const failed=updateStatus?.outcome==='failed' && Date.parse(updateStatus.attemptedAt)>=Date.parse(snapshot.observedAt);
      const reportNote=failed ? `最近擷取失敗（台北 ${new Date(updateStatus.attemptedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}）；保留最後成功快照。` : '';
      status.textContent=`已載入 ${snapshot.byTicker.size.toLocaleString('zh-TW')} 檔 IV30；取得時間（台北）${fetched}${snapshot.stale ? ' · 快照已過期' : ''}。${reportNote}頁面每 5 分鐘自動檢查。原站未提供報價更新時間。`;
    } catch {
      state='failed';
      if(snapshot) snapshot.stale=weekdayHoursBetween(snapshot.observedAt,new Date())>24;
      status.textContent=snapshot ? '重新讀取失敗；保留上次快照，請核對取得時間或開啟來源查詢。' : 'IV30 快照載入失敗，請重新讀取或開啟來源查詢。';
    } finally { busy=false;button.disabled=false;window.refreshFcnTable?.(); }
  }
  document.getElementById('iv30Reload').addEventListener('click',refresh);
  startIV30Polling(refresh,{document,window,setInterval,clearInterval});
  refresh();
}
