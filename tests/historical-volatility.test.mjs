import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHistory, summarizeHistoricalVolatility, estimateBasket, choleskyCorrelation} from '../assets/historical-volatility.mjs';

const now = '2026-10-09T12:00:00Z';
export function history(ticker = 'ABC', count = 300, returnAt = i => i % 2 ? 0.01 : -0.01) {
  const dates = [], date = new Date('2026-10-08T00:00:00Z');
  while (dates.length <= count) {
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  dates.reverse();
  let price = 100;
  return {schemaVersion: 1, ticker, source: 'synthetic-test-only', adjustment: 'splits',
    currency: 'USD', timezone: 'America/New_York', asOf: now, warnings: [],
    bars: dates.map((date, i) => ({date, close: i ? price *= Math.exp(returnAt(i)) : price}))};
}

test('annual HV uses sample log-return standard deviation times sqrt252', () => {
  const result = summarizeHistoricalVolatility(history(), {now});
  assert.ok(Math.abs(result.windows[252] - 0.01 * Math.sqrt(252 * 252 / 251)) < 1e-12);
  assert.ok(Math.abs(result.windows[126] - 0.01 * Math.sqrt(252 * 126 / 125)) < 1e-12);
  assert.equal(result.observations, 300);
  assert.equal(result.quality, 'good');
  assert.equal(result.assumptions.volatilityUnit, 'annualized-decimal');
});
test('horizon variance integrates time without multiplying annual volatility by sqrtmonths', () => {
  const three = summarizeHistoricalVolatility(history(), {now, months: 3});
  const six = summarizeHistoricalVolatility(history(), {now, months: 6});
  assert.ok(six.forecastVolatility / three.forecastVolatility < 1.01);
  assert.ok(six.forecastVolatility / three.forecastVolatility > 0.99);
  assert.equal(six.integratedVariance, six.forecastVolatility ** 2 * 0.5);
  const high = summarizeHistoricalVolatility(history(), {now, scenario: 'high'});
  const low = summarizeHistoricalVolatility(history(), {now, scenario: 'low'});
  assert.equal(high.forecastVolatility / three.forecastVolatility, 1.25);
  assert.equal(low.forecastVolatility / three.forecastVolatility, 0.8);
  assert.equal(high.assumptions.sensitivityIsConfidenceInterval, false);
});
test('recent high variance reverts downward over longer forecast tenor', () => {
  const raw = history('ABC', 300, i => (i % 2 ? 1 : -1) * (i > 270 ? 0.04 : 0.005));
  assert.ok(summarizeHistoricalVolatility(raw, {now, months: 3}).forecastVolatility > summarizeHistoricalVolatility(raw, {now, months: 6}).forecastVolatility);
});
test('minimum history, split adjustment, duplicate dates, completed dates and explicit clocks are enforced', () => {
  assert.throws(() => validateHistory(history('ABC', 125), now), /127/);
  assert.throws(() => validateHistory({...history(), adjustment: 'none'}, now), /split-adjusted/);
  assert.throws(() => validateHistory({...history(), timezone: 'unknown'}, now), /timezone/);
  assert.throws(() => validateHistory({...history(), asOf: '2026-10-09T12:00:00'}, now), /timezone/);
  const duplicate = history(); duplicate.bars.push(duplicate.bars.at(-1));
  assert.throws(() => validateHistory(duplicate, now), /Duplicate/);
  const current = history(); current.bars.at(-1).date = '2026-10-09';
  assert.throws(() => validateHistory(current, now), /completed/);
  const zero = history(); zero.bars[10].close = 0;
  assert.throws(() => validateHistory(zero, now), /close/);
  const stale = history(); stale.bars = stale.bars.slice(0, -10);
  assert.throws(() => validateHistory(stale, now), /stale/);
});
test('normal missing weekday holiday frequency is acknowledged but every-other-weekday data is rejected', () => {
  const holidays = history(); holidays.bars = holidays.bars.filter((_, i) => i % 25 !== 1);
  const parsed = validateHistory(holidays, now);
  assert.ok(parsed.missingWeekdayRatio < 0.05);
  assert.ok(parsed.warnings.some(w => w.includes('holidays')));
  const sparse = history('ABC', 600); sparse.bars = sparse.bars.filter((_, i) => i % 2 === 0);
  assert.throws(() => validateHistory(sparse, now), /10%/);
});
test('insufficient long-run history remains usable and explicitly limited', () => {
  const result = summarizeHistoricalVolatility(history('ABC', 126), {now});
  assert.equal(result.windows[252], null);
  assert.equal(result.quality, 'limited');
  assert.equal(result.assumptions.longRunDays, 126);
});
test('correlation uses identical aligned return intervals, shrinks, and stress stays positive definite', () => {
  const first = history('AAA'), second = history('BBB', 300, i => i % 2 ? -0.01 : 0.01), third = history('CCC', 300, i => Math.sin(i) * 0.02);
  const base = estimateBasket([first, second, third], {now}), high = estimateBasket([first, second, third], {now, scenario: 'high'});
  assert.equal(base.correlationObservations, 126);
  assert.ok(Math.abs(base.correlationMatrix[0][1] + 0.95) < 1e-12);
  assert.ok(Math.abs(high.correlationMatrix[0][1] - (0.8 * base.correlationMatrix[0][1] + 0.2)) < 1e-12);
  const lower = choleskyCorrelation(high.correlationMatrix);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const reconstructed = lower[i].reduce((sum, value, k) => sum + value * lower[j][k], 0);
    assert.ok(Math.abs(reconstructed - high.correlationMatrix[i][j]) < 1e-12);
  }
  const missing = history('BBB'); missing.bars.splice(missing.bars.length - 30, 1);
  const aligned = estimateBasket([first, missing], {now});
  assert.equal(aligned.correlationObservations, 126); // extra earlier dates replace two excluded intervals
  assert.throws(() => estimateBasket([first, first], {now}), /Duplicate/);
});
test('unaligned baskets with individually fresh valid data are blocked', () => {
  const basket = Array.from({length: 6}, (_, index) => {
    const raw = history(`AAA${index}`);
    raw.bars = raw.bars.filter((_, i) => i === 300 || i % 14 !== index * 2 + 1);
    validateHistory(raw, now); // each series is individually above the daily-density threshold
    return raw;
  });
  assert.throws(() => estimateBasket(basket, {now}), /60 common/);
});
