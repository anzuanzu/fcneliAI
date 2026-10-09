import test from 'node:test';
import assert from 'node:assert/strict';
import {importSnapshots, parseCsv, CSV_COLUMNS, CSV_TEMPLATE} from '../assets/iv-import.mjs';
const now = new Date('2026-10-09T12:00:00Z');
const row = ['AAPL','100','2026-10-09T10:00:00Z','2026-10-09T10:00:00Z','User supplied, vendor export','2027-01-15','80','put','2','2.2','35','2026-10-09T10:00:00Z','2026-10-09T10:00:00Z','100','1000'];
const csv = values => [CSV_COLUMNS,values].map(r => r.map(v => String(v).includes(',') ? `"${v}"` : v).join(',')).join('\r\n');
test('CSV percent IV becomes decimal exactly once and source quoting is preserved', () => {
  const [s] = importSnapshots(csv(row), now);
  assert.equal(s.contracts[0].iv,.35); assert.equal(s.source,'User supplied, vendor export');
});
test('CSV missing IV remains null and unknown time is marked, never filled from spot', () => {
  const missing = [...row]; missing[10] = ''; missing[11] = '';
  const [s] = importSnapshots(csv(missing), now);
  assert.equal(s.contracts[0].iv,null); assert.equal(s.contracts[0].ivAsOf,null);
});
test('CSV metadata mismatch across same ticker fails rather than mixing spots/times', () => {
  const changed = [...row]; changed[1] = '120';
  assert.throws(() => importSnapshots(csv(row)+'\n'+csv(changed).split('\r\n')[1], now), /必須一致/);
});
test('CSV never treats blank spot as zero or guesses percent-unit JSON', () => {
  const changed = [...row]; changed[1] = '';
  assert.throws(() => importSnapshots(csv(changed), now), /spot 不可空白/);
  const [s] = importSnapshots(csv(row), now);
  assert.throws(() => importSnapshots(JSON.stringify({...s,ivUnit:'percent'}),now), /IV units/);
});
test('JSON snapshot wrapper and arrays supported; duplicate tickers rejected atomically', () => {
  const [s] = importSnapshots(csv(row), now);
  assert.equal(importSnapshots(JSON.stringify({snapshots:[s]}),now)[0].ticker,'AAPL');
  assert.throws(() => importSnapshots(JSON.stringify([s,s]),now), /只能有一份/);
});
test('CSV parser handles BOM, embedded newline, escaped quote and rejects malformed cells', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x\ny","a""b"'),[['a','b'],['x\ny','a"b']]);
  assert.throws(() => parseCsv('a,"b'), /未關閉/);
  assert.throws(() => parseCsv('a,"b"oops'), /額外文字/);
});
test('blank template cannot be mistaken for populated real option data', () => {
  assert.throws(() => importSnapshots(CSV_TEMPLATE,now), /不可空白/);
});
test('future or missing top-level timestamp rejects imported batch', () => {
  const changed = [...row]; changed[2] = '2026-12-09T10:00:00Z';
  assert.throws(() => importSnapshots(csv(changed),now), /future/);
});
