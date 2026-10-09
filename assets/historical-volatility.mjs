import {weekdayHoursBetween} from './iv-engine.mjs';

const DAY = 86400000;
const SCENARIOS = Object.freeze({low: 0.8, base: 1, high: 1.25});
const ASSUMPTIONS = Object.freeze({tradingDaysPerYear: 252, tradingDaysPerMonth: 21,
  ewmaLambda: 0.94, meanReversionHalfLifeTradingDays: 126, correlationShrinkage: 0.05,
  highScenarioCommonFactorBlend: 0.2, scenarioMultipliers: SCENARIOS});
const finite = value => typeof value === 'number' && Number.isFinite(value);
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}
function sampleVariance(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

// This is a distinct historical-data schema. Never manufacture an option
// snapshot or label a historical forecast as market implied volatility.
export function validateHistory(raw, nowValue = new Date()) {
  const now = new Date(nowValue);
  if (!Number.isFinite(+now)) throw new Error('now must be a valid date');
  if (!raw || raw.schemaVersion !== 1) throw new Error('Unsupported history schemaVersion');
  if (typeof raw.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/i.test(raw.ticker)) throw new Error('Invalid history ticker');
  if (typeof raw.source !== 'string' || !raw.source.trim()) throw new Error('History source is required');
  if (!['splits', 'all'].includes(raw.adjustment)) throw new Error('Verified split-adjusted history is required');
  if (typeof raw.timezone !== 'string' || !raw.timezone.trim()) throw new Error('History exchange timezone is required');
  try { new Intl.DateTimeFormat('en-US', {timeZone: raw.timezone}); } catch { throw new Error('Invalid history exchange timezone'); }
  if (raw.currency !== 'USD') throw new Error('History currency must be USD');
  if (typeof raw.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw.asOf) || !day(raw.asOf.slice(0, 10)) || !Number.isFinite(Date.parse(raw.asOf))) throw new Error('History asOf requires an ISO timestamp with a timezone');
  if (Date.parse(raw.asOf) > +now + 300000) throw new Error('History asOf is in the future');
  if (!Array.isArray(raw.bars) || raw.bars.length < 127 || raw.bars.length > 2000) throw new Error('History needs 127 to 2000 completed daily closes');
  const bars = raw.bars.map(bar => {
    const date = day(bar?.date);
    if (!date || !finite(bar.close) || bar.close <= 0) throw new Error('Invalid daily history date or close');
    if (+date > +now) throw new Error('History close date is in the future');
    if ([0, 6].includes(date.getUTCDay())) throw new Error('History contains a weekend close');
    return {date: bar.date, close: bar.close};
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(bars.map(bar => bar.date)).size !== bars.length) throw new Error('Duplicate history dates');
  for (let i = 1; i < bars.length; i++) if (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date) > 7 * DAY) throw new Error('Daily history has a gap longer than seven calendar days');
  const lastDate = bars.at(-1).date;
  const exchangeParts = new Intl.DateTimeFormat('en-US', {timeZone: raw.timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(raw.asOf));
  const exchangeDate = ['year', 'month', 'day'].map(type => exchangeParts.find(part => part.type === type).value).join('-');
  if (lastDate >= exchangeDate) throw new Error('History requires completed closes before the current exchange date');
  // A date-only close is known only to day precision. End-of-date freshness
  // allows a completed US close over weekends; this is not a holiday calendar.
  const closeDayEnd = +day(lastDate) + DAY - 1;
  if (closeDayEnd > Date.parse(raw.asOf) + DAY) throw new Error('History close date is later than retrieval date');
  if (weekdayHoursBetween(Math.min(closeDayEnd, +now), now) > 72 || weekdayHoursBetween(raw.asOf, now) > 72) throw new Error('Historical prices are stale (more than 72 UTC weekday hours)');
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(w => typeof w === 'string').slice(0, 100) : [];
  const returns = bars.slice(1).map((bar, index) => ({date: bar.date, startDate: bars[index].date, value: Math.log(bar.close / bars[index].close)}));
  const recentReturns = returns.slice(-252);
  let missingWeekdays = 0;
  for (const row of recentReturns) for (let date = Date.parse(row.startDate) + DAY; date < Date.parse(row.date); date += DAY) {
    if (![0, 6].includes(new Date(date).getUTCDay())) missingWeekdays++;
  }
  const missingWeekdayRatio = missingWeekdays / (recentReturns.length + missingWeekdays);
  if (missingWeekdayRatio > 0.1) throw new Error('Daily history omits more than 10% of recent weekday sessions; returns cannot be treated as daily');
  if (missingWeekdays) warnings.push(`${missingWeekdays} missing weekday dates (${(missingWeekdayRatio * 100).toFixed(1)}%); exchange holidays or missing data are not distinguished. Each observed close-to-close return is treated as one trading session.`);
  if (returns.some(row => Math.abs(row.value) > Math.log(2))) warnings.push('A daily price move exceeds a factor of two; check corporate action adjustments and genuine jumps.');
  if (returns.length < 252) warnings.push('Less than 252 daily returns: long-run variance uses the last 126 returns.');
  if (raw.adjustment === 'splits') warnings.push('Prices are split-adjusted; dividends are not included in historical returns. Dividend yield is a separate pricing assumption.');
  else warnings.push('Dividend-adjusted history is a total-return proxy; its volatility may differ from price-return volatility.');
  return {...raw, ticker: raw.ticker.toUpperCase(), bars, returns, lastDate, missingWeekdays, missingWeekdayRatio,
    warnings: [...new Set(warnings)], asOf: new Date(raw.asOf).toISOString()};
}

export function summarizeHistoricalVolatility(raw, {now = new Date(), months = 3, scenario = 'base'} = {}) {
  if (!Number.isInteger(months) || months < 3 || months > 6) throw new Error('Historical forecast months must be 3, 4, 5, or 6');
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error('Historical scenario must be low, base, or high');
  const history = validateHistory(raw, now), values = history.returns.map(row => row.value);
  const windows = Object.fromEntries([21, 63, 126, 252].map(size => [size,
    values.length >= size ? Math.sqrt(sampleVariance(values.slice(-size)) * 252) : null]));
  const longRunDays = values.length >= 252 ? 252 : 126;
  const longRunVariance = sampleVariance(values.slice(-longRunDays));
  const recent = values.slice(-252), mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  let ewmaVariance = longRunVariance;
  for (const value of recent) ewmaVariance = 0.94 * ewmaVariance + 0.06 * (value - mean) ** 2;
  const horizon = months * 21, decay = 2 ** (-1 / 126);
  let totalDailyVariance = 0;
  for (let i = 0; i < horizon; i++) totalDailyVariance += longRunVariance + (ewmaVariance - longRunVariance) * decay ** i;
  const baseVarianceAnnual = totalDailyVariance / horizon * 252;
  const forecastVolatility = Math.sqrt(baseVarianceAnnual) * SCENARIOS[scenario];
  if (!finite(forecastVolatility) || forecastVolatility > 5) throw new Error(`${history.ticker}: estimated volatility exceeds supported range`);
  return {ticker: history.ticker, source: history.source, asOf: history.asOf,
    adjustment: history.adjustment, spot: history.bars.at(-1).close, latestClose: history.bars.at(-1).close,
    lastDate: history.lastDate, observations: values.length, windows, ewma: Math.sqrt(ewmaVariance * 252),
    missingWeekdays: history.missingWeekdays, missingWeekdayRatio: history.missingWeekdayRatio,
    months, scenario, forecastVolatility, volatility: forecastVolatility,
    integratedVariance: forecastVolatility ** 2 * horizon / 252,
    quality: values.length < 252 || history.missingWeekdayRatio > 0.05 || history.warnings.some(w => w.includes('factor of two')) ? 'limited' : 'good',
    warnings: history.warnings, assumptions: {...ASSUMPTIONS, longRunDays,
      volatilityUnit: 'annualized-decimal', sensitivityIsConfidenceInterval: false,
      forecast: 'EWMA variance mean reversion toward historical long-run variance; uncalibrated assumptions'}};
}

export function choleskyCorrelation(matrix) {
  const n = matrix.length, result = Array.from({length: n}, () => Array(n).fill(0));
  if (!n || matrix.some(row => !Array.isArray(row) || row.length !== n)) throw new Error('Invalid correlation matrix');
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (!finite(matrix[i][j]) || Math.abs(matrix[i][j] - matrix[j][i]) > 1e-10) throw new Error('Correlation matrix must be finite and symmetric');
    const residual = matrix[i][j] - result[i].slice(0, j).reduce((sum, value, k) => sum + value * result[j][k], 0);
    if (i === j) {
      if (residual <= 0) throw new Error('Correlation matrix must be positive definite');
      result[i][j] = Math.sqrt(residual);
    } else result[i][j] = residual / result[j][j];
  }
  return result;
}

export function estimateBasket(rawHistories, options = {}) {
  if (!Array.isArray(rawHistories) || rawHistories.length < 1 || rawHistories.length > 6) throw new Error('Select between 1 and 6 price histories');
  const {now = new Date(), scenario = 'base'} = options;
  const histories = rawHistories.map(history => validateHistory(history, now));
  if (new Set(histories.map(history => history.ticker.replace(/\//g, '.'))).size !== histories.length) throw new Error('Duplicate basket tickers are not allowed');
  const summaries = histories.map(history => summarizeHistoricalVolatility(history, options));
  const maps = histories.map(history => new Map(history.returns.map(row => [row.date, row])));
  // Equal end dates alone are insufficient if one series missed an earlier
  // close: correlate only returns with identical start and end dates.
  const dates = histories[0].returns.filter(row => maps.every(map => map.get(row.date)?.startDate === row.startDate)).map(row => row.date).slice(-126);
  if (dates.length < 60) throw new Error('Basket needs at least 60 common daily return dates');
  const aligned = maps.map(map => dates.map(date => map.get(date).value)), n = aligned.length;
  const means = aligned.map(values => values.reduce((sum, value) => sum + value, 0) / dates.length);
  const variances = aligned.map(values => sampleVariance(values));
  const correlationMatrix = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => {
    if (i === j) return 1;
    const covariance = aligned[i].reduce((sum, value, k) => sum + (value - means[i]) * (aligned[j][k] - means[j]), 0) / (dates.length - 1);
    const correlation = variances[i] > 1e-24 && variances[j] > 1e-24 ? Math.max(-1, Math.min(1, covariance / Math.sqrt(variances[i] * variances[j]))) : 0;
    const shrunk = 0.95 * correlation;
    // Blending a PSD matrix with the all-ones common factor remains PSD.
    return scenario === 'high' ? 0.8 * shrunk + 0.2 : shrunk;
  }));
  const warnings = [...new Set(summaries.flatMap(summary => summary.warnings))];
  if (dates.length < 126) warnings.push('Less than 126 common returns; basket correlation has limited history.');
  if (variances.some(variance => variance <= 1e-24)) warnings.push('Constant return series: its cross correlations are undefined and set to zero before shrinkage/stress.');
  return {summaries, correlationMatrix, cholesky: choleskyCorrelation(correlationMatrix),
    correlationObservations: dates.length, warnings, assumptions: {...ASSUMPTIONS,
      correlationDates: {first: dates[0], last: dates.at(-1)}, scenario,
      historicalCorrelationIsImpliedCorrelation: false}};
}
