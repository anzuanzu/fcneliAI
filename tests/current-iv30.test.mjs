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
