import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateFcn, compareFcnTerms, evaluateFcnPath, redemptionForPath, validateFcnParameters, buildObservationSchedule} from '../assets/fcn-model.mjs';

const now = new Date('2026-10-09T00:00:00Z');
function snapshot(ticker = 'ABC', iv = 0.3) {
  const asOf = now.toISOString();
  return {schemaVersion: 1, ticker, spot: 100, spotAsOf: asOf, asOf, source: 'test-vendor', warnings: [],
    contracts: ['2026-12-26', '2027-01-23', '2027-02-20', '2027-03-20', '2027-04-17', '2027-05-15']
      .flatMap(expiry => [60, 65, 75, 80, 90, 100, 110].flatMap(strike => ['put', 'call'].map(type => ({expiry, strike, type, bid: 1, ask: 1.1, iv, ivAsOf: asOf, quoteAsOf: asOf}))))};
}
function params(extra = {}) { return {snapshots: [snapshot(), snapshot('XYZ')], months: 3, paths: 200, now, seed: 12345, ...extra}; }

function history() {
  const dates = [], date = new Date('2026-10-08T00:00:00Z');
  while (dates.length < 301) {
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return {schemaVersion: 1, ticker: 'ABC', source: 'synthetic-test-only', adjustment: 'splits',
    currency: 'USD', timezone: 'America/New_York', asOf: '2026-10-09T12:00:00Z',
    bars: dates.reverse().map((date, i) => ({date, close: i % 2 ? 100 * Math.exp(0.03) : 100}))};
}

test('historical estimates have separate inputs and explicit model assumptions, with increasing volatility sensitivity', async () => {
  const input = {mode: 'historical-estimate', histories: [history()],
    now: '2026-10-09T12:00:00Z', months: 6, paths: 1000, seed: 77, kPct: 80, kiPct: 80,
    koPct: 200, lockoutMonths: 6, kiObservation: 'maturity'};
  const low = await simulateFcn({...input, scenario: 'low'}), high = await simulateFcn({...input, scenario: 'high'});
  assert.equal(low.model, 'historical-input-Q-correlated-GBM');
  assert.equal(low.estimatedModel, true);
  assert.equal(low.surfaces.length, 0);
  assert.equal(low.estimates[0].source, 'synthetic-test-only');
  assert.ok(high.fairCouponAnnual > low.fairCouponAnnual);
  assert.ok(high.input.volatilities[0] > low.input.volatilities[0]);
  assert.ok(low.limitations.some(line => line.includes('assumed Q inputs')));
  assert.ok(low.limitations.some(line => line.includes('not confidence intervals')));
  assert.deepEqual(low.input.correlationMatrix, [[1]]);
  assert.equal(low.input.rho, undefined);
  assert.equal(low.input.histories, undefined);
  await assert.rejects(simulateFcn({...input, histories: undefined, snapshots: [snapshot()]}), /price histories/);
  await assert.rejects(simulateFcn({...input, mode: 'market-iv', snapshots: []}), /IV snapshots/);
});

test('valid uniform correlation is bounded for PSD common-factor construction', () => {
  for (const rho of [-0.1, 1, NaN]) assert.throws(() => validateFcnParameters(params({rho})), /rho/);
  assert.equal(validateFcnParameters(params({rho: 0.95})).rho, 0.95);
  assert.throws(() => validateFcnParameters(params({dividendYields: [0.01]})), /dividend/);
  assert.throws(() => validateFcnParameters(params({snapshots: [snapshot(), snapshot()]})), /Duplicate/);
});
test('KI followed by final recovery to K pays par; lower final payoff uses worst/K', () => {
  assert.equal(redemptionForPath({worstFinal: 0.5, knockedIn: true, knockedOut: false, kPct: 80}), 0.625);
  assert.equal(redemptionForPath({worstFinal: 0.81, knockedIn: true, knockedOut: false, kPct: 80}), 1);
  assert.equal(redemptionForPath({worstFinal: 0.5, knockedIn: false, knockedOut: false, kPct: 80}), 1);
});
test('KO stops future KI, principal loss, and coupon accrual', () => {
  const result = evaluateFcnPath({lockoutMonths: 0, levels: [
    {prices: [1.1, 1.05], timeYears: 1 / 12, month: 1},
    {prices: [0.4, 0.5], timeYears: 3 / 12, month: 3},
  ]});
  assert.equal(result.knockedOut, true);
  assert.equal(result.knockedIn, false);
  assert.equal(result.redemption, 1);
  assert.equal(result.timeYears, 1 / 12);
});
test('KI before KO remains a triggered event but KO pays par', () => {
  const result = evaluateFcnPath({lockoutMonths: 0, levels: [
    {prices: [0.6, 1], timeYears: 0.01},
    {prices: [1.1, 1.1], timeYears: 1 / 12, month: 1},
  ]});
  assert.equal(result.knockedIn, true);
  assert.equal(result.knockedOut, true);
  assert.equal(result.redemption, 1);
});
test('maturity-only KI ignores earlier dip and daily-close KI does not', () => {
  const levels = [{prices: [0.6, 1], timeYears: 0.01}, {prices: [0.7, 1], timeYears: 0.25, month: 3}];
  assert.equal(evaluateFcnPath({levels, kiObservation: 'maturity'}).redemption, 1);
  assert.ok(Math.abs(evaluateFcnPath({levels, kiObservation: 'daily-close'}).redemption - 0.875) < 1e-12);
});
test('KO requires every underlying to clear threshold and respects lockout', () => {
  const result = evaluateFcnPath({levels: [
    {prices: [1.1, 1.1], timeYears: 1 / 12, month: 1},
    {prices: [1.1, 0.9], timeYears: 2 / 12, month: 2},
    {prices: [0.6, 1.1], timeYears: 3 / 12, month: 3},
  ]});
  assert.equal(result.knockedOut, false);
  assert.ok(Math.abs(result.redemption - 0.75) < 1e-12);
});
test('observation schedule rolls weekend valuation back but preserves calendar maturity payment', () => {
  const schedule = buildObservationSchedule(now, 3, 1);
  assert.equal(schedule.maturity.toISOString().slice(0, 10), '2027-01-09');
  assert.equal(schedule.finalValuation.toISOString().slice(0, 10), '2027-01-08');
  assert.ok(schedule.steps.every(s => ![0, 6].includes(s.date.getUTCDay())));
  assert.equal(schedule.steps.at(-1).observation.maturity, true);
  assert.equal(schedule.steps.find(s => s.observation?.month === 1).observation.koEligible, false);
});
test('simulation is deterministic and reports uncertainty with explicit Q limitations', async () => {
  const a = await simulateFcn(params()), b = await simulateFcn(params());
  assert.equal(a.fairCouponAnnual, b.fairCouponAnnual);
  assert.deepEqual(a.probabilitiesQ, b.probabilitiesQ);
  assert.ok(Number.isFinite(a.fairCouponAnnual));
  assert.ok(a.seCouponAnnual >= 0);
  assert.ok(a.confidence95CouponAnnual[0] <= a.fairCouponAnnual);
  assert.ok(a.confidence95CouponAnnual[1] >= a.fairCouponAnnual);
  assert.ok(Math.abs(a.expectedCouponPaid - a.fairCouponAnnual * a.expectedLifeYears) < 1e-12);
  assert.ok(a.limitations.some(x => x.includes('risk-neutral (Q)')));
  assert.ok(a.limitations.some(x => x.includes('full skew')));
  assert.ok(a.limitations.some(x => x.includes('zero')));
});
test('fixed no-loss early KO coupon solves discounted cashflow identity', async () => {
  const result = await simulateFcn(params({snapshots: [snapshot('ABC', 0.00001)], rate: 0.04, koPct: 90, lockoutMonths: 0}));
  assert.equal(result.probabilitiesQ.ko, 1);
  assert.equal(result.probabilitiesQ.principalLoss, 0);
  assert.ok(result.probabilityConfidence95Q.principalLoss[1] > 0);
  const life = result.expectedLifeYears;
  assert.ok(Math.abs(result.fairCouponAnnual - Math.expm1(0.04 * life) / life) < 1e-10);
});
test('first KO in month six disables KO for a three-month or four-month product', async () => {
  for (const months of [3, 4]) {
    const result = await simulateFcn(params({months, lockoutMonths: 5, koPct: 90, snapshots: [snapshot('ABC', 0.00001)]}));
    assert.equal(result.probabilitiesQ.ko, 0);
    assert.equal(result.input.firstKoMonth, null);
    assert.ok(Math.abs(result.expectedLifeYears - (Date.parse(result.targetDate) - +now) / (365 * 86400000)) < 1e-12);
  }
});
test('single-stock maturity KI=K without KO matches an independent European put price within sampling uncertainty', async () => {
  // With KI=K observed only at maturity, redemption is min(1, S_T/K).
  // Its discounted value is exp(-rT) minus the European put value/K.
  // Choose a weekday maturity so final valuation and payment dates coincide.
  const sigma = 0.3, r = 0.04, strike = 0.8;
  const result = await simulateFcn(params({months: 4, paths: 50000, snapshots: [snapshot('ABC', sigma)],
    kPct: 80, kiPct: 80, kiObservation: 'maturity', lockoutMonths: 6, rate: r, dividendYields: [0]}));
  function cdf(z) {
    const x = Math.abs(z), t = 1 / (1 + 0.2316419 * x);
    const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) *
      (0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
    return z < 0 ? tail : 1 - tail;
  }
  const T = (Date.parse(result.targetDate) - +now) / (365 * 86400000);
  assert.equal(result.finalValuationDate, result.targetDate);
  const d1 = (Math.log(1 / strike) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const put = strike * Math.exp(-r * T) * cdf(-d2) - cdf(-d1);
  const analyticCoupon = (1 - Math.exp(-r * T) + put / strike) / (T * Math.exp(-r * T));
  assert.ok(analyticCoupon >= result.confidence95CouponAnnual[0] && analyticCoupon <= result.confidence95CouponAnnual[1],
    `Monte Carlo ${result.fairCouponAnnual} +/- ${1.96 * result.seCouponAnnual}, analytic ${analyticCoupon}`);
});
test('missing, stale, or unknown-time IV blocks simulation rather than substituting historical volatility', async () => {
  const absent = snapshot(); absent.contracts = absent.contracts.filter(c => c.strike >= 75);
  await assert.rejects(() => simulateFcn(params({snapshots: [absent]})), /KI IV has no coverage/);
  const stale = snapshot(); stale.spotAsOf = stale.asOf = '2026-10-01T00:00:00Z';
  stale.contracts = stale.contracts.map(c => ({...c, ivAsOf: stale.asOf, quoteAsOf: stale.asOf}));
  await assert.rejects(() => simulateFcn(params({snapshots: [stale]})), /quality is stale/);
  const unknown = snapshot(); unknown.contracts = unknown.contracts.map(c => ({...c, ivAsOf: '2026-10-09 13:59:03', ivTimestampTimezone: 'unspecified'}));
  await assert.rejects(() => simulateFcn(params({snapshots: [unknown]})), /quality is limited/);
});
test('term comparisons preserve seed and use all 3–6 month calendar dates', async () => {
  const results = await compareFcnTerms(params());
  assert.deepEqual(results.map(r => r.months), [3, 4, 5, 6]);
  assert.deepEqual(results.map(r => r.targetDate), ['2027-01-09', '2027-02-09', '2027-03-09', '2027-04-09']);
  assert.ok(results.every(r => r.seed === 12345));
});
test('abort signal stops nonblocking simulation', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => simulateFcn(params({signal: controller.signal})), /cancelled/);
});
