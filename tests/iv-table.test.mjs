import test from 'node:test';
import assert from 'node:assert/strict';
import {addCalendarMonths} from '../assets/iv-engine.mjs';
import {buildTermSummaries, renderTermCell, buildHistoricalTerms, renderHistoricalTermCell, optionsChainUrl, queryTargets} from '../assets/iv-table.mjs';

const now = new Date('2026-10-10T00:00:00Z');
const params = {kPct:70, kiPct:60, koPct:100};
const asOf = now.toISOString();
function fixture() {
  return {schemaVersion:1, ticker:'ABC', spot:200, asOf, spotAsOf:asOf, source:'test-only <vendor>',
    contracts:[3,4,5,6].flatMap(months => [50,60,70,80,90,100].flatMap(pct => ['put','call'].map(type => ({
      expiry:addCalendarMonths(now,months).toISOString().slice(0,10), strike:200*pct/100,
      type, bid:1, ask:1.1, iv: .3 + months*.01 + (100-pct)*.001, ivAsOf:asOf, quoteAsOf:asOf
    }))))};
}
test('all four calendar terms retain their own IV and recompute K/KI against the snapshot price', () => {
  const snapshots = new Map([['ABC',fixture()]]);
  const initial = buildTermSummaries(snapshots,params,now).get('ABC');
  const changed = buildTermSummaries(snapshots,{...params,kPct:80,kiPct:70},now).get('ABC');
  for (const months of [3,4,5,6]) {
    const a = initial.get(months), b = changed.get(months);
    assert.ok(Math.abs(a.atm.iv - (.3+months*.01))<1e-12);
    assert.equal(a.k.strike,140); assert.equal(a.ki.strike,120);
    assert.equal(b.k.strike,160); assert.equal(b.ki.strike,140);
    assert.equal(a.atm.iv,b.atm.iv);
    assert.ok(b.k.iv < a.k.iv && b.ki.iv < a.ki.iv);
  }
});
test('missing strike or expiry coverage stays missing and stale values are visibly identified', () => {
  const raw = fixture(); raw.contracts = raw.contracts.filter(c => c.strike>=140 && c.expiry<'2027-04-01');
  const terms = buildTermSummaries(new Map([['ABC',raw]]), params, now).get('ABC');
  assert.equal(terms.get(3).ki,null); assert.ok(terms.get(3).atm);
  assert.equal(terms.get(6).atm,null);
  assert.match(renderTermCell(terms.get(3),params,true),/KI 60%<\/span><div><strong>—<\/strong><small>缺資料/);
  const staleRaw = fixture(); staleRaw.asOf = staleRaw.spotAsOf = '2026-10-01T00:00:00Z';
  staleRaw.contracts.forEach(c=>{c.quoteAsOf=c.ivAsOf=staleRaw.asOf;});
  const stale = buildTermSummaries(new Map([['ABC',staleRaw]]),params,now).get('ABC').get(3);
  assert.match(renderTermCell(stale,params,true),/合約 · 過期/);
  assert.match(renderTermCell(stale,params,true),/test-only &lt;vendor&gt;/);
});
test('invalid barriers and absent snapshots never turn into numeric IV', () => {
  assert.equal(buildTermSummaries(new Map([['ABC',fixture()]]),{...params,kPct:50},now).size,0);
  assert.match(renderTermCell(null,{...params,kPct:50}),/條件不符/);
  assert.match(renderTermCell(null,params),/尚未匯入/);
  assert.doesNotMatch(renderTermCell(null,params),/0\.00%/);
});
test('query targets use calendar months, clamp month ends, and preserve exchange/share class links', () => {
  const targets = queryTargets(200,params,new Date('2026-11-30T20:00:00Z'));
  assert.equal(targets.k,140); assert.equal(targets.ki,120);
  assert.deepEqual(targets.dates.map(d=>d.date),['2027-02-28','2027-03-30','2027-04-30','2027-05-30']);
  assert.equal(queryTargets(null,params),null);
  assert.equal(optionsChainUrl('NVDA','NASDAQ'),'https://www.tradingview.com/symbols/NASDAQ-NVDA/options-chain/');
  assert.equal(optionsChainUrl('BRK/B','NYSE'),'https://www.tradingview.com/symbols/NYSE-BRK.B/options-chain/');
  assert.equal(optionsChainUrl('BRK.B','NYSE'),'https://www.tradingview.com/symbols/NYSE-BRK.B/options-chain/');
  assert.equal(optionsChainUrl('AAPL',null),'https://www.tradingview.com/options/');
});

test('historical cells show independent tenor estimates and closing-price barriers without manufacturing IV', () => {
  const dates = [], cursor = new Date('2026-10-08T00:00:00Z');
  while (dates.length < 301) {
    if (![0,6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0,10));
    cursor.setUTCDate(cursor.getUTCDate()-1);
  }
  let close = 100;
  const raw = {schemaVersion:1,ticker:'ABC',source:'synthetic <history>',adjustment:'splits',asOf,currency:'USD',
    timezone:'America/New_York',bars:dates.map((date,i)=>({date,close:close*=Math.exp((i%2 ? 1 : -1)*(i>270 ? .03 : .01))}))};
  const terms = buildHistoricalTerms(new Map([['ABC',raw]]),now).get('ABC');
  const summary = terms.get(3).summary;
  assert.ok(summary.forecastVolatility>terms.get(6).summary.forecastVolatility);
  for (const months of [3,4,5,6]) {
    const cell = renderHistoricalTermCell(terms.get(months),params);
    assert.match(cell,/歷史估計 · 可用/);
    assert.match(cell,/低／高/);
    assert.match(cell,new RegExp(`\\$${(raw.bars.at(-1).close*.7).toFixed(2).replace('.', '\\.')}<`));
    assert.match(cell,/synthetic &lt;history&gt;/);
    assert.doesNotMatch(cell,/ATM|合約|插值|IV/);
    assert.equal(terms.get(months).summary.spot,raw.bars.at(-1).close);
  }
  const changed = renderHistoricalTermCell(terms.get(3),{...params,kPct:80});
  assert.match(changed,/K 80%/);
  assert.match(changed,new RegExp((summary.forecastVolatility*100).toFixed(2).replace('.','\\.')+'%'));
  assert.match(renderHistoricalTermCell(null,params),/尚未取得歷史股價/);
  const old = {...raw,asOf:'2026-09-20T00:00:00Z'};
  const errors = buildHistoricalTerms(new Map([['ABC',old]]),new Date('2026-11-01')).get('ABC');
  assert.match(renderHistoricalTermCell(errors.get(3),params),/無法估算/);
});
