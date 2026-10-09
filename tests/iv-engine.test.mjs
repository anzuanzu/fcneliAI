import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSnapshot, summarizeSurface, addCalendarMonths, weekdayHoursBetween} from '../assets/iv-engine.mjs';

const now = new Date('2026-10-09T00:00:00Z');
function snapshot({spot = 100, expiries = ['2027-01-01', '2027-01-17'], strikes = [60, 65, 75, 80, 90, 100, 105, 110], ivs = [0.2, 0.4], asOf = now.toISOString()} = {}) {
  return {schemaVersion: 1, ticker: 'ABC', spot, spotAsOf: asOf, asOf, source: 'test-vendor', warnings: [],
    contracts: expiries.flatMap((expiry, ei) => strikes.flatMap(strike => ['put', 'call'].map(type => ({expiry, strike, type,
      bid: 1, ask: 1.1, iv: ivs[ei], ivAsOf: asOf, quoteAsOf: asOf, volume: 10, openInterest: 100}))))};
}

test('calendar month endpoints clamp instead of overflowing February', () => {
  assert.equal(addCalendarMonths('2027-01-31T13:30:00Z', 1).toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(addCalendarMonths('2028-01-31T13:30:00Z', 1).toISOString(), '2028-02-29T00:00:00.000Z');
  assert.throws(() => addCalendarMonths(now, NaN));
});
test('total variance interpolates across actual dates, not IV or sqrt(months)', () => {
  const summary = summarizeSurface(snapshot(), {months: 3, now});
  const tLow = (Date.parse('2027-01-01') - +now) / (365 * 86400000);
  const tHigh = (Date.parse('2027-01-17') - +now) / (365 * 86400000);
  const tTarget = (Date.parse('2027-01-09') - +now) / (365 * 86400000);
  assert.equal(summary.targetDate, '2027-01-09');
  assert.ok(Math.abs(summary.atm.iv - Math.sqrt((0.2 ** 2 * tLow + 0.4 ** 2 * tHigh) / 2 / tTarget)) < 1e-12);
  assert.equal(summary.atm.method, 'interpolated');
  assert.equal(summary.atm.extrapolated, false);
  assert.equal(summary.quality.status, 'good');
});
test('strike interpolation uses log moneyness and variance', () => {
  const raw = snapshot({expiries: ['2027-01-09'], strikes: [80, 90, 100], ivs: [0.3]});
  for (const c of raw.contracts) c.iv = c.strike === 80 ? 0.5 : 0.3;
  const summary = summarizeSurface(raw, {months: 3, now, kPct: 85});
  const w = Math.log(85 / 80) / Math.log(90 / 80);
  assert.ok(Math.abs(summary.k.iv - Math.sqrt(0.5 ** 2 * (1 - w) + 0.3 ** 2 * w)) < 1e-12);
  assert.deepEqual(summary.k.coverage[0].optionTypes, ['put']);
});
test('deep KI remains null when strike bracket is absent', () => {
  const summary = summarizeSurface(snapshot({strikes: [75, 80, 90, 100, 110]}), {months: 3, now, kiPct: 65});
  assert.equal(summary.ki, null);
  assert.ok(summary.atm);
  assert.equal(summary.quality.complete, false);
  assert.ok(summary.warnings.some(w => w.includes('KI has no valid')));
});
test('expiry extrapolation is never used', () => {
  const summary = summarizeSurface(snapshot({expiries: ['2027-01-01'], ivs: [0.3]}), {months: 3, now});
  assert.equal(summary.atm, null);
  assert.equal(summary.quality.status, 'missing');
});
test('an exact expiry and strike is labeled quoted', () => {
  const summary = summarizeSurface(snapshot({expiries: ['2027-01-09'], ivs: [0.3]}), {months: 3, now});
  assert.equal(summary.atm.method, 'quoted');
  assert.equal(summary.atm.iv, 0.3);
});
test('ATM can bracket OTM put below spot and OTM call above spot', () => {
  const raw = snapshot({strikes: [80, 90, 105, 110]});
  raw.contracts = raw.contracts.filter(c => c.type === 'put' ? c.strike < 100 : c.strike > 100);
  const summary = summarizeSurface(raw, {months: 3, now});
  assert.ok(summary.atm);
  assert.deepEqual(summary.atm.coverage[0].optionTypes, ['put', 'call']);
});
test('unknown units, invalid snapshot timestamp, future spot and invalid spot are rejected', () => {
  assert.throws(() => validateSnapshot({...snapshot(), ivUnit: 'percent'}, now), /units/);
  assert.throws(() => validateSnapshot({...snapshot(), spot: 0}, now), /positive/);
  assert.throws(() => validateSnapshot({...snapshot(), asOf: '2026-10-09 00:00:00'}, now), /timezone/);
  assert.throws(() => validateSnapshot({...snapshot(), spotAsOf: '2026-10-10T00:00:00Z'}, now), /future/);
});
test('malformed contracts and future contract timestamps are discarded; absent IV stays null', () => {
  const raw = snapshot();
  raw.contracts = [raw.contracts[0], {...raw.contracts[0], iv: null},
    {...raw.contracts[0], iv: 40}, {...raw.contracts[0], iv: 0},
    {...raw.contracts[0], expiry: '2027-02-30'}, {...raw.contracts[0], strike: -1},
    {...raw.contracts[0], ivAsOf: '2026-10-10T00:00:00Z'}];
  const validated = validateSnapshot(raw, now);
  assert.equal(validated.contracts.length, 2);
  assert.equal(validated.contracts[1].iv, null);
  assert.ok(validated.warnings.some(w => w.includes('5 malformed')));
});
test('snapshot chronology and impossible unspecified future dates are rejected', () => {
  assert.throws(() => validateSnapshot({...snapshot(), asOf: '2026-10-08T00:00:00Z'}, now), /later than snapshot/);
  const raw = snapshot();
  raw.contracts = [{...raw.contracts[0], ivAsOf: '2099-01-01 13:59:03', ivTimestampTimezone: 'unspecified'}];
  assert.equal(validateSnapshot(raw, now).contracts.length, 0);
});
test('crossed quotes, zero bids and wide spreads cannot generate IV estimates', () => {
  for (const overrides of [{bid: 2, ask: 1}, {bid: 0}, {bid: 0.1, ask: 2}]) {
    const raw = snapshot();
    raw.contracts = raw.contracts.map(c => ({...c, ...overrides}));
    assert.equal(summarizeSurface(raw, {months: 3, now}).atm, null);
  }
});
test('weekday age excludes weekends, and stale aligned data is flagged', () => {
  assert.equal(weekdayHoursBetween('2026-10-09T12:00:00Z', '2026-10-12T12:00:00Z'), 24);
  const summary = summarizeSurface(snapshot({asOf: '2026-10-02T00:00:00Z'}), {months: 3, now});
  assert.equal(summary.atm.quality, 'stale');
});
test('overall quality reflects stale KI even when ATM is good', () => {
  const raw = snapshot();
  raw.contracts = raw.contracts.map(c => c.strike === 65 ? {...c, ivAsOf: '2026-10-02T00:00:00Z', quoteAsOf: null} : c);
  const summary = summarizeSurface(raw, {months: 3, now});
  assert.equal(summary.atm.quality, 'good');
  assert.equal(summary.ki.quality, 'stale');
  assert.equal(summary.quality.status, 'stale');
});
test('weekday age handles centuries in constant bounded work and agrees with a daily reference', () => {
  function reference(first, second) {
    let a = Date.parse(first), b = Date.parse(second), total = 0;
    if (a > b) [a, b] = [b, a];
    while (a < b) {
      const d = new Date(a), end = Math.min(b, Math.floor(a / 86400000) * 86400000 + 86400000);
      if (![0, 6].includes(d.getUTCDay())) total += end - a;
      a = end;
    }
    return total / 3600000;
  }
  for (const [first, second] of [
    ['2026-10-09T12:23:00Z', '2026-10-12T13:17:00Z'],
    ['2026-10-10T12:23:00Z', '2026-10-25T13:17:00Z'],
    ['2026-10-25T13:17:00Z', '2026-10-10T12:23:00Z'],
    ['2026-10-11T01:00:00Z', '2026-10-11T02:00:00Z'],
    ['1900-01-01T00:00:00Z', '2026-10-09T00:00:00Z'],
  ]) assert.ok(Math.abs(weekdayHoursBetween(first, second) - reference(first, second)) < 1e-9);
});
test('untrustworthy vendor IV timezone is displayed as limited, never silently interpreted locally', () => {
  const raw = snapshot();
  raw.contracts = raw.contracts.map(c => ({...c, ivAsOf: '2026-10-09 13:59:03', ivTimestampTimezone: 'unspecified'}));
  const normalized = validateSnapshot(raw, now);
  assert.equal(normalized.contracts[0].ivAsOf, null);
  assert.equal(normalized.contracts[0].ivAsOfRaw, '2026-10-09 13:59:03');
  assert.equal(summarizeSurface(raw, {months: 3, now}).atm.quality, 'limited');
});
test('spot/quote and IV/quote mismatch cannot fabricate a current surface', () => {
  const raw = snapshot();
  raw.contracts = raw.contracts.map(c => ({...c, quoteAsOf: '2026-10-05T00:00:00Z', ivAsOf: '2026-10-05T00:00:00Z'}));
  const summary = summarizeSurface(raw, {months: 3, now});
  assert.equal(summary.atm, null);
  assert.ok(summary.quality.rejected.spotQuoteMisalignment > 0);
});
test('sparse/decreasing variance brackets produce limited estimates', () => {
  const summary = summarizeSurface(snapshot({ivs: [0.9, 0.1]}), {months: 3, now});
  assert.equal(summary.atm.quality, 'limited');
  assert.ok(summary.atm.warnings.some(w => w.includes('decreases')));
});

export {snapshot, now};
