import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseRows,saveSnapshot} from '../scripts/market-chameleon-iv30.mjs';
import {validateIV30,renderIV30Cell,compareIV30,IV30_SOURCE} from '../assets/current-iv30.mjs';
const now=new Date('2026-10-09T22:00:00Z');
const fixture=()=>({schemaVersion:1,source:'Market Chameleon',sourceUrl:IV30_SOURCE,ivUnit:'annualized-percent',observedAt:now.toISOString(),sourceAsOf:null,records:[{ticker:'NVDA',iv30Percent:29.4},{ticker:'BRK.B',iv30Percent:null}]});

test('public table parser locates Current IV30 by heading, not percentile rank or a fixed position',()=>{
  assert.deepEqual(parseRows(['IV30 % Rank','Symbol','Current\nIV30'],[['94%','NVDA','29.4']]),[{ticker:'NVDA',iv30Percent:29.4}]);
  assert.deepEqual(parseRows(['Symbol','CurrentIV30'],[['MSFT','124.6'],['BRK.B','—']]),[{ticker:'MSFT',iv30Percent:124.6},{ticker:'BRK.B',iv30Percent:null}]);
  assert.throws(()=>parseRows(['Symbol','IV30 % Rank'],[['NVDA','90%']]),/HEADER/);
  assert.throws(()=>parseRows(['Symbol','Current IV30'],[['NVDA','bad']]),/VALUE/);
  assert.throws(()=>parseRows(['Symbol','Current IV30'],[['NVDA','0']]),/VALUE/);
  assert.throws(()=>parseRows(['Symbol','Current IV30'],[['NVDA','29.4','extra']]),/ROW/);
});
test('IV30 validates explicit percent units, source, observation clock and unique exact tickers',()=>{
  const raw=fixture();assert.equal(validateIV30(raw,now).byTicker.get('NVDA'),29.4);
  for (const change of [{ivUnit:'annualized-decimal'},{source:'historical estimate'},{observedAt:'2026-10-09T22:00:00'},{observedAt:'2026-10-10T22:00:00Z'},{sourceAsOf:'2026-10-09T22:00:00Z'}]) assert.throws(()=>validateIV30({...raw,...change},now));
  assert.throws(()=>validateIV30({...raw,records:[...raw.records,raw.records[0]]},now),/SYMBOL/);
  assert.throws(()=>validateIV30({...raw,records:[{ticker:'NVDA',iv30Percent:'29.4'}]},now),/VALUE/);
  assert.throws(()=>validateIV30({...raw,records:[{ticker:'NVDA',iv30Percent:null}]},now),/EMPTY_VALUES/);
});
test('snapshot freshness does not invent a quote timestamp, and missing coverage is not zero',()=>{
  const snapshot=validateIV30(fixture(),now);
  assert.match(renderIV30Cell(snapshot,'NVDA',IV30_SOURCE),/29\.4%/);
  assert.doesNotMatch(renderIV30Cell(snapshot,'NVDA',IV30_SOURCE),/2940/);
  assert.match(renderIV30Cell(snapshot,'NVDA',IV30_SOURCE),/取得時間.*原站未提供報價更新時間/);
  assert.match(renderIV30Cell(snapshot,'BRK.B',IV30_SOURCE),/來源缺值/);
  assert.match(renderIV30Cell(snapshot,'BRK/B',IV30_SOURCE),/來源未覆蓋/);
  assert.match(renderIV30Cell(null,'NVDA',IV30_SOURCE,'failed'),/資料載入失敗/);
  assert.equal(validateIV30(fixture(),new Date('2026-10-11T22:00:00Z')).stale,false);
  assert.equal(validateIV30(fixture(),new Date('2026-10-13T22:00:00Z')).stale,true);
  assert.match(renderIV30Cell(validateIV30(fixture(),new Date('2026-10-13T22:00:00Z')),'NVDA',IV30_SOURCE),/快照過期/);
});
test('IV30 sort is numeric and missing entries stay last in both directions',()=>{
  const values=[9.2,null,124.6,37.8,undefined];
  assert.deepEqual([...values].sort((a,b)=>compareIV30(a,b,'desc')).slice(0,3),[124.6,37.8,9.2]);
  assert.deepEqual([...values].sort((a,b)=>compareIV30(a,b,'asc')).slice(0,3),[9.2,37.8,124.6]);
});
test('invalid refresh never replaces the previous snapshot; valid data uses an atomic file replacement',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fcneli-iv30-'));
  try {
    const path=join(dir,'snapshot.json');await writeFile(path,'previous data');
    await assert.rejects(saveSnapshot({...fixture(),records:[]},path));
    assert.equal(await readFile(path,'utf8'),'previous data');
    await saveSnapshot({...fixture(),observedAt:new Date().toISOString()},path);
    assert.equal(JSON.parse(await readFile(path,'utf8')).records[0].iv30Percent,29.4);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('published older snapshots never replace the latest accepted data',async()=>{
  const {acceptIV30,validateUpdateStatus}=await import('../assets/current-iv30.mjs');
  const previous=validateIV30(fixture(),now);
  assert.throws(()=>acceptIV30(previous,{...fixture(),observedAt:'2026-10-08T22:00:00Z'},now),/OLDER/);
  assert.equal(acceptIV30(previous,fixture(),now).byTicker.get('NVDA'),29.4);
  assert.equal(validateUpdateStatus({schemaVersion:1,outcome:'failed',attemptedAt:now.toISOString()},now).outcome,'failed');
  assert.throws(()=>validateUpdateStatus({schemaVersion:1,outcome:'success',attemptedAt:'2026-10-10T22:00:00Z'},now));
});
test('automatic polling pauses hidden pages and resumes on visibility and focus',async()=>{
  const {startIV30Polling}=await import('../assets/current-iv30.mjs');
  const document=new EventTarget(),window=new EventTarget();document.visibilityState='visible';
  let calls=0,tick,cleared;
  const stop=startIV30Polling(()=>calls++,{document,window,setInterval:(fn,ms)=>{assert.equal(ms,300000);tick=fn;return 42;},clearInterval:id=>cleared=id});
  tick();assert.equal(calls,1);
  document.visibilityState='hidden';tick();window.dispatchEvent(new Event('focus'));assert.equal(calls,1);
  document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));assert.equal(calls,3);
  stop();assert.equal(cleared,42);window.dispatchEvent(new Event('focus'));assert.equal(calls,3);
});
test('crawler transport retry excludes access blocks and invalid data',async()=>{
  const {isTransportFailure}=await import('../scripts/market-chameleon-iv30.mjs');
  assert.equal(isTransportFailure(new Error('net::ERR_HTTP2_PROTOCOL_ERROR')),true);
  assert.equal(isTransportFailure({name:'TimeoutError'}),true);
  for(const code of ['IV30_SOURCE_HTTP_403','IV30_SOURCE_HTTP_429','IV30_COUNT_CHANGED','IV30_DUPLICATE_SYMBOL']) assert.equal(isTransportFailure(new Error(code)),false);
});

test('visible-browser captures require full coverage and reject duplicate tickers atomically',async()=>{
  const {visibleSnapshot,importVisibleIV30}=await import('../scripts/import-visible-iv30.mjs');
  const capture={sourceUrl:IV30_SOURCE,observedAt:new Date().toISOString(),expectedTotal:2,headers:['Symbol','CurrentIV30'],rows:[['NVDA','29.4'],['AAPL','26.0']]};
  assert.equal(visibleSnapshot(capture).records.length,2);
  assert.throws(()=>visibleSnapshot({...capture,expectedTotal:3}),/INCOMPLETE/);
  assert.throws(()=>visibleSnapshot({...capture,rows:[['NVDA','29.4'],['NVDA','30.1']]}),/SYMBOL/);
  const dir=await mkdtemp(join(tmpdir(),'iv30-visible-test-')),output=join(dir,'snapshot.json');
  try {
    await saveSnapshot({...fixture(),observedAt:capture.observedAt},output);
    const previous=await readFile(output,'utf8');
    await assert.rejects(importVisibleIV30({...capture,expectedTotal:3},output));
    assert.equal(await readFile(output,'utf8'),previous);
    await assert.rejects(importVisibleIV30({...capture,observedAt:'2026-10-08T00:00:00Z'},output),/OLDER/);
    assert.equal(await readFile(output,'utf8'),previous);
  } finally {await rm(dir,{recursive:true,force:true});}
});
