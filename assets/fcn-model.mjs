import {addCalendarMonths, summarizeSurface} from './iv-engine.mjs';

const DAY = 86400000;
const YEAR = 365 * DAY;
const LIMITATIONS = [
  'Research model only; fair coupon is not an executable issuer quote and excludes issuer credit, funding spread, fees, tax, stock borrowing, and hedging costs.',
  'All reported probabilities are risk-neutral (Q), not forecasts of real-world frequency or investor risk.',
  'Correlated GBM uses constant maturity ATM vendor IV and a user-specified uniform correlation. It does not calibrate the full skew, forward volatility, jumps, stochastic volatility, or implied correlation.',
  'Observation dates use UTC calendar weekdays; exchange holidays and actual market close times are not modeled. Monthly KO and final valuation roll back to the preceding weekday; cash payment occurs on the unadjusted calendar date.',
  'Coupon is unconditional, accrues ACT/365 from inception until redemption, and is paid once at redemption. This does not model conditional/memory coupons or periodic coupon payments.',
  'Monte Carlo confidence bands describe sampling error only; they do not quantify data uncertainty, model error, or unobserved rare events.',
];

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function utcDay(v) {
  const date = v instanceof Date ? v : new Date(v);
  if (!Number.isFinite(+date)) throw new Error('now must be a valid date');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function previousWeekday(value) {
  const date = new Date(value);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
  return date;
}

// Uniform positive correlation is PSD for any supported basket size:
// Z_i = sqrt(rho) Z_common + sqrt(1-rho) Z_idiosyncratic,i.
export function validateFcnParameters(input) {
  const {snapshots, months, kPct = 80, kiPct = 65, koPct = 100,
    rho = 0.5, rate = 0.04, lockoutMonths = 1, paths = 10000,
    seed = 20261009, kiObservation = 'daily-close', dividendYields} = input || {};
  if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 8) throw new Error('Select between 1 and 8 IV snapshots');
  if (!Number.isInteger(months) || months < 3 || months > 6) throw new Error('months must be 3, 4, 5, or 6');
  if (!finite(kPct) || kPct <= 0 || kPct > 100 || !finite(kiPct) || kiPct <= 0 || kiPct > kPct || !finite(koPct) || koPct < kPct || koPct > 200) throw new Error('Require 0 < KI <= K <= 100 and K <= KO <= 200 (percent of each initial price)');
  if (!finite(rho) || rho < 0 || rho > 0.95) throw new Error('Uniform correlation rho must be between 0 and 0.95');
  if (!finite(rate) || rate < -0.1 || rate > 0.5) throw new Error('rate must be an annualized decimal between -0.1 and 0.5');
  if (!Number.isInteger(lockoutMonths) || lockoutMonths < 0 || lockoutMonths > 6) throw new Error('lockoutMonths must be an integer between 0 and 6; values at or beyond tenor disable KO');
  if (!Number.isInteger(paths) || paths < 200 || paths > 50000) throw new Error('paths must be an integer between 200 and 50000');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer');
  if (!['daily-close', 'maturity'].includes(kiObservation)) throw new Error('kiObservation must be daily-close or maturity');
  const yields = dividendYields ?? snapshots.map(() => 0);
  if (!Array.isArray(yields) || yields.length !== snapshots.length || yields.some(v => !finite(v) || v < 0 || v > 0.5)) throw new Error('dividendYields must contain one annualized decimal in [0, 0.5] per underlying');
  const tickers = snapshots.map(s => s?.ticker?.toUpperCase());
  if (new Set(tickers).size !== tickers.length) throw new Error('Duplicate basket tickers are not allowed');
  return {snapshots, months, kPct, kiPct, koPct, rho, rate, lockoutMonths, paths, seed, kiObservation, dividendYields: [...yields]};
}

export function buildObservationSchedule(nowValue, months, lockoutMonths = 1) {
  const start = utcDay(nowValue), maturity = addCalendarMonths(start, months);
  const observations = new Map();
  for (let month = 1; month <= months; month++) {
    const payment = addCalendarMonths(start, month);
    const date = previousWeekday(payment);
    const maturityObservation = month === months;
    observations.set(+date, {month, date, payment, koEligible: month > lockoutMonths, maturity: maturityObservation});
  }
  const finalValuation = previousWeekday(maturity), steps = [];
  let previous = start;
  for (let date = new Date(+start + DAY); +date <= +finalValuation; date = new Date(+date + DAY)) {
    if ([0, 6].includes(date.getUTCDay())) continue;
    steps.push({date, dt: (+date - +previous) / YEAR, observation: observations.get(+date) || null});
    previous = date;
  }
  return {start, maturity, finalValuation, steps};
}

function normalGenerator(seed) {
  let state = seed >>> 0;
  let spare = null;
  function uniform() {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  return () => {
    if (spare !== null) { const z = spare; spare = null; return z; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), Number.EPSILON)));
    const theta = 2 * Math.PI * uniform();
    spare = radius * Math.sin(theta);
    return radius * Math.cos(theta);
  };
}
function pathSeed(seed, path) {
  let h = (seed ^ Math.imul(path + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ h >>> 16, 0x85ebca6b);
  h = Math.imul(h ^ h >>> 13, 0xc2b2ae35);
  return (h ^ h >>> 16) >>> 0;
}

// Payoff helper is also useful for auditing product assumptions. Prices are
// normalized to each underlying's initial price, and not to the option strike.
export function redemptionForPath({worstFinal, knockedIn, knockedOut, kPct}) {
  if (!finite(worstFinal) || worstFinal < 0 || !finite(kPct) || kPct <= 0 || kPct > 100) throw new Error('Invalid payoff input');
  return knockedOut || !knockedIn || worstFinal >= kPct / 100 ? 1 : Math.min(1, worstFinal / (kPct / 100));
}

// evaluateFcnPath exposes cashflows for deterministic scenario checks without
// pretending those scenarios are market forecasts.
export function evaluateFcnPath({levels, kPct = 80, kiPct = 65, koPct = 100,
  kiObservation = 'daily-close', lockoutMonths = 1, rate = 0.04}) {
  if (!Array.isArray(levels) || !levels.length || levels.some(row => !Array.isArray(row.prices) || !row.prices.length || row.prices.some(p => !finite(p) || p < 0) || !finite(row.timeYears) || row.timeYears <= 0)) throw new Error('Invalid path observations');
  if (!['daily-close', 'maturity'].includes(kiObservation)) throw new Error('Invalid KI observation rule');
  let knockedIn = false;
  for (let index = 0; index < levels.length; index++) {
    const row = levels[index], worst = Math.min(...row.prices), isFinal = index === levels.length - 1;
    if ((kiObservation === 'daily-close' || isFinal) && worst <= kiPct / 100) knockedIn = true;
    const ko = row.month != null && row.month > lockoutMonths && worst >= koPct / 100;
    if (ko || isFinal) {
      const redemption = redemptionForPath({worstFinal: worst, knockedIn, knockedOut: ko, kPct});
      return {redemption, knockedIn, knockedOut: ko, principalLoss: redemption < 1,
        timeYears: row.timeYears, discountedRedemption: redemption * Math.exp(-rate * row.timeYears),
        discountedCouponAccrual: row.timeYears * Math.exp(-rate * row.timeYears)};
    }
  }
}

export async function simulateFcn(input) {
  const p = validateFcnParameters(input);
  const now = input.now === undefined ? new Date() : new Date(input.now);
  if (!Number.isFinite(+now)) throw new Error('now must be a valid date');
  const surfaces = p.snapshots.map(s => summarizeSurface(s, {months: p.months, now, kPct: p.kPct, kiPct: p.kiPct, koPct: p.koPct}));
  for (const s of surfaces) for (const key of ['atm', 'k', 'ki', 'ko']) {
    if (!s[key]) throw new Error(`${s.ticker}: ${key.toUpperCase()} IV has no coverage; simulation disabled`);
    if (s[key].quality !== 'good') throw new Error(`${s.ticker}: ${key.toUpperCase()} IV quality is ${s[key].quality}; trustworthy current IV is required`);
  }
  const volatilities = surfaces.map(s => s.atm.iv);
  const schedule = buildObservationSchedule(now, p.months, p.lockoutMonths);
  const commonScale = Math.sqrt(p.rho), independentScale = Math.sqrt(1 - p.rho);
  let sumR = 0, sumA = 0, sumR2 = 0, sumA2 = 0, sumRA = 0;
  let sumTime = 0, sumRedemption = 0, koCount = 0, kiCount = 0, lossCount = 0;
  const chunkSize = 128;
  for (let path = 0; path < p.paths; path++) {
    if (input.signal?.aborted) throw new Error('Simulation cancelled');
    const normal = normalGenerator(pathSeed(p.seed, path));
    const prices = p.snapshots.map(() => 1);
    let knockedIn = false, knockedOut = false, redemption = 1;
    let life = (+schedule.maturity - +schedule.start) / YEAR;
    for (const step of schedule.steps) {
      const common = normal();
      for (let index = 0; index < prices.length; index++) {
        const sigma = volatilities[index];
        const z = commonScale * common + independentScale * normal();
        prices[index] *= Math.exp((p.rate - p.dividendYields[index] - sigma * sigma / 2) * step.dt + sigma * Math.sqrt(step.dt) * z);
      }
      const worst = Math.min(...prices);
      if ((p.kiObservation === 'daily-close' || step.observation?.maturity) && worst <= p.kiPct / 100) knockedIn = true;
      if (step.observation?.koEligible && worst >= p.koPct / 100) {
        knockedOut = true;
        life = (+step.observation.payment - +schedule.start) / YEAR;
        break; // No later KI or principal loss is possible after redemption.
      }
      if (step.observation?.maturity) redemption = redemptionForPath({worstFinal: worst, knockedIn, knockedOut: false, kPct: p.kPct});
    }
    const discount = Math.exp(-p.rate * life), r = discount * redemption, a = discount * life;
    sumR += r; sumA += a; sumR2 += r * r; sumA2 += a * a; sumRA += r * a;
    sumTime += life; sumRedemption += redemption;
    koCount += knockedOut ? 1 : 0; kiCount += knockedIn ? 1 : 0; lossCount += redemption < 1 ? 1 : 0;
    if ((path + 1) % chunkSize === 0 || path + 1 === p.paths) {
      input.onProgress?.({completed: path + 1, total: p.paths, fraction: (path + 1) / p.paths});
      // Yield between batches so mobile and desktop UI stay responsive.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  const n = p.paths, meanR = sumR / n, meanA = sumA / n;
  const fairCouponAnnual = (1 - meanR) / meanA;
  const varR = Math.max(0, (sumR2 - n * meanR * meanR) / (n - 1));
  const varA = Math.max(0, (sumA2 - n * meanA * meanA) / (n - 1));
  const covRA = (sumRA - n * meanR * meanA) / (n - 1);
  const seCouponAnnual = Math.sqrt(Math.max(0, varR + fairCouponAnnual ** 2 * varA + 2 * fairCouponAnnual * covRA) / n) / meanA;
  const probabilitiesQ = {ko: koCount / n, ki: kiCount / n, principalLoss: lossCount / n};
  const probabilitySE = Object.fromEntries(Object.entries(probabilitiesQ).map(([key, value]) => [key, Math.sqrt(value * (1 - value) / n)]));
  // Wilson intervals remain informative when a finite run observes zero or
  // every event; a plug-in binomial standard error alone would report zero.
  const probabilityConfidence95Q = Object.fromEntries(Object.entries(probabilitiesQ).map(([key, value]) => {
    const z = 1.96, denominator = 1 + z * z / n;
    const center = (value + z * z / (2 * n)) / denominator;
    const half = z * Math.sqrt(value * (1 - value) / n + z * z / (4 * n * n)) / denominator;
    return [key, [Math.max(0, center - half), Math.min(1, center + half)]];
  }));
  return {months: p.months, targetDate: schedule.maturity.toISOString().slice(0, 10),
    finalValuationDate: schedule.finalValuation.toISOString().slice(0, 10),
    fairCouponAnnual, expectedCouponPaid: fairCouponAnnual * sumTime / n,
    expectedLifeYears: sumTime / n, expectedRedemption: sumRedemption / n,
    expectedPrincipalLossQ: 1 - sumRedemption / n, probabilitiesQ, probabilitySE, probabilityConfidence95Q,
    seCouponAnnual, confidence95CouponAnnual: [fairCouponAnnual - 1.96 * seCouponAnnual, fairCouponAnnual + 1.96 * seCouponAnnual],
    paths: n, seed: p.seed, model: 'risk-neutral-constant-ATM-IV-correlated-GBM',
    surfaces, input: {...p, snapshots: undefined, now: schedule.start.toISOString(), volatilities,
      couponRule: 'unconditional-accrued-payable-at-redemption', dayCount: 'ACT/365',
      firstKoMonth: p.lockoutMonths < p.months ? p.lockoutMonths + 1 : null},
    limitations: [...LIMITATIONS, ...(input.dividendYields === undefined ? ['Dividend yields default to zero and must be supplied for a different assumption.'] : [])]};
}

export async function compareFcnTerms(input) {
  const results = [];
  for (const months of [3, 4, 5, 6]) {
    const result = await simulateFcn({...input, months, onProgress: progress => input.onProgress?.({...progress, months, termsCompleted: results.length, totalTerms: 4})});
    results.push(result);
  }
  return results;
}
