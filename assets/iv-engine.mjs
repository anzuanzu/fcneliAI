// Research-only IV surface interpolation. All IV inputs are vendor-supplied,
// annualized decimals; no historical volatility or range statistic is substituted.
const DAY = 86400000;
const YEAR = 365 * DAY;
const FUTURE_TOLERANCE = 5 * 60000;
const MAX_IV = 5;
const MAX_SPREAD = 0.5;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
}
function clock(value, name = 'now') {
  const date = value instanceof Date ? new Date(+value) : new Date(value);
  if (!Number.isFinite(+date)) throw new Error(`${name} must be a valid date`);
  return date;
}
function timestamp(value, now, name, required = false) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} requires an ISO timestamp with a timezone`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    if (required) throw new Error(`${name} requires an ISO timestamp with a timezone`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(+date) || !dateOnly(value.slice(0, 10))) throw new Error(`${name} is invalid`);
  if (+date > +now + FUTURE_TOLERANCE) throw new Error(`${name} is in the future`);
  return date.toISOString();
}

// Weekend-adjusted age is a transparent heuristic, not an exchange calendar.
// Holidays and intraday exchange sessions are deliberately not inferred.
export function weekdayHoursBetween(first, second) {
  let a = +clock(first), b = +clock(second);
  if (a > b) [a, b] = [b, a];
  const firstDay = Math.floor(a / DAY) * DAY, lastDay = Math.floor(b / DAY) * DAY;
  const isWeekday = day => ![0, 6].includes(new Date(day).getUTCDay());
  if (firstDay === lastDay) return isWeekday(firstDay) ? (b - a) / 3600000 : 0;
  let total = (isWeekday(firstDay) ? firstDay + DAY - a : 0) + (isWeekday(lastDay) ? b - lastDay : 0);
  // Full interior weeks contribute exactly five days. At most six remaining
  // dates need inspection, even for ancient or maliciously old timestamps.
  const fullDays = (lastDay - firstDay) / DAY - 1;
  const fullWeeks = Math.floor(fullDays / 7), remainder = fullDays % 7;
  total += fullWeeks * 5 * DAY;
  for (let offset = 0; offset < remainder; offset++) if (isWeekday(firstDay + DAY * (offset + 1))) total += DAY;
  return total / 3600000;
}

export function addCalendarMonths(value, months) {
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new Error('months must be an integer between 1 and 24');
  const d = clock(value);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), last)));
}

export function validateSnapshot(raw, nowValue = new Date()) {
  const now = clock(nowValue);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) throw new Error('Unsupported IV snapshot schemaVersion; expected 1');
  if (typeof raw.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.^/-]{0,19}$/i.test(raw.ticker)) throw new Error('Invalid ticker');
  if (!finite(raw.spot) || raw.spot <= 0) throw new Error('spot must be positive');
  for (const key of ['ivUnit', 'ivUnits', 'volatilityUnit']) {
    if (raw[key] != null && raw[key] !== 'decimal' && raw[key] !== 'annualized-decimal') throw new Error('IV units must be annualized decimals');
  }
  const source = raw.source;
  if (!(typeof source === 'string' && source.trim()) && !(source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length)) throw new Error('A vendor source is required');
  if (!Array.isArray(raw.contracts) || raw.contracts.length > 100000) throw new Error('contracts must be an array (at most 100000)');
  const asOf = timestamp(raw.asOf, now, 'asOf', true);
  const spotAsOf = timestamp(raw.spotAsOf, now, 'spotAsOf', true);
  if (Date.parse(spotAsOf) > Date.parse(asOf) + FUTURE_TOLERANCE) throw new Error('spotAsOf cannot be later than snapshot asOf');
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(x => typeof x === 'string').slice(0, 100) : [];
  const contracts = [];
  let invalid = 0, missingIv = 0, unknownTime = 0;
  for (const c of raw.contracts) {
    try {
      if (!c || typeof c !== 'object') throw new Error('Invalid contract');
      const expiry = dateOnly(c.expiry);
      if (!expiry || !finite(c.strike) || c.strike <= 0 || !['put', 'call'].includes(c.type)) throw new Error('Invalid expiry/strike/type');
      for (const key of ['ivUnit', 'ivUnits']) if (c[key] != null && !['decimal', 'annualized-decimal'].includes(c[key])) throw new Error('Invalid IV unit');
      if (c.iv != null && (!finite(c.iv) || c.iv <= 0 || c.iv > MAX_IV)) throw new Error('IV outside supported decimal range (0, 5]');
      for (const key of ['bid', 'ask', 'volume', 'openInterest']) if (c[key] != null && (!finite(c[key]) || c[key] < 0)) throw new Error(`Invalid ${key}`);
      const quoteAsOf = timestamp(c.quoteAsOf, now, 'quoteAsOf');
      const parsedIvAsOf = timestamp(c.ivAsOf, now, 'ivAsOf');
      const ivAsOf = c.ivTimestampTimezone === 'unspecified' ? null : parsedIvAsOf;
      if ((quoteAsOf && Date.parse(quoteAsOf) > Date.parse(asOf) + FUTURE_TOLERANCE) ||
          (parsedIvAsOf && Date.parse(parsedIvAsOf) > Date.parse(asOf) + FUTURE_TOLERANCE)) throw new Error('Contract timestamp later than snapshot asOf');
      // An unspecified provider timezone cannot be guessed, but a date more
      // than a full day in the future is invalid in every real-world timezone.
      if (!parsedIvAsOf && typeof c.ivAsOf === 'string' && dateOnly(c.ivAsOf.slice(0, 10)) &&
          +dateOnly(c.ivAsOf.slice(0, 10)) > +now + DAY) throw new Error('Impossible future IV date');
      if (c.iv == null) missingIv++;
      if (c.iv != null && (!ivAsOf || !quoteAsOf)) unknownTime++;
      contracts.push({
        expiry: c.expiry, strike: c.strike, type: c.type,
        bid: c.bid ?? null, ask: c.ask ?? null, iv: c.iv ?? null,
        ivAsOf, quoteAsOf, volume: c.volume ?? null, openInterest: c.openInterest ?? null,
        ivTimestampTimezone: ivAsOf ? 'explicit' : 'unspecified',
        ivAsOfRaw: !ivAsOf ? (typeof c.ivAsOf === 'string' ? c.ivAsOf : typeof c.ivAsOfRaw === 'string' ? c.ivAsOfRaw : null) : null,
      });
    } catch { invalid++; }
  }
  if (invalid) warnings.push(`${invalid} malformed contracts discarded (including invalid/future timestamps or unsupported IV units).`);
  if (missingIv) warnings.push(`${missingIv} contracts have no vendor IV; missing values remain null.`);
  if (unknownTime) warnings.push(`${unknownTime} IV contracts lack a trustworthy timezone-qualified quote/IV timestamp.`);
  return {schemaVersion: 1, ticker: raw.ticker.toUpperCase(), spot: raw.spot, spotAsOf, asOf,
    source, contracts, warnings: [...new Set(warnings)], ivUnit: 'annualized-decimal'};
}

function candidateQuality(c, snapshot, now) {
  const warnings = [];
  if (c.iv == null) return {eligible: false, reason: 'missingIV'};
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) return {eligible: false, reason: 'missingOrZeroBidAsk'};
  if (c.bid > c.ask) return {eligible: false, reason: 'crossedQuote'};
  const spread = (c.ask - c.bid) / ((c.ask + c.bid) / 2);
  if (spread > MAX_SPREAD) return {eligible: false, reason: 'wideSpread'};
  if (+dateOnly(c.expiry) <= +now) return {eligible: false, reason: 'expired'};
  if (c.quoteAsOf && weekdayHoursBetween(snapshot.spotAsOf, c.quoteAsOf) > 24) return {eligible: false, reason: 'spotQuoteMisalignment'};
  if (c.ivAsOf && c.quoteAsOf && weekdayHoursBetween(c.ivAsOf, c.quoteAsOf) > 24) return {eligible: false, reason: 'ivQuoteMisalignment'};
  let quality = 'good';
  if (!c.quoteAsOf || !c.ivAsOf) {
    quality = 'limited'; warnings.push('IV or quote timestamp has no trustworthy timezone; do not use for current pricing.');
  }
  if (weekdayHoursBetween(snapshot.spotAsOf, now) > 72 ||
      (c.quoteAsOf && weekdayHoursBetween(c.quoteAsOf, now) > 72) ||
      (c.ivAsOf && weekdayHoursBetween(c.ivAsOf, now) > 72)) {
    quality = 'stale'; warnings.push('Spot, quote, or IV is older than 72 weekday hours; holidays are not modeled.');
  }
  return {eligible: true, quality, warnings, spread};
}
function worse(a, b) {
  return ['good', 'limited', 'stale'][Math.max(['good', 'limited', 'stale'].indexOf(a), ['good', 'limited', 'stale'].indexOf(b))];
}
function atExpiry(rows, relativeStrike, spot, now) {
  // Downside uses puts and upside uses calls. ATM uses the OTM sides to
  // bracket spot, allowing a put below spot and a call above spot.
  const sideRows = rows.filter(({c}) => relativeStrike < 1 ? c.type === 'put' && c.strike <= spot : relativeStrike > 1 ? c.type === 'call' && c.strike >= spot :
    (c.type === 'put' && c.strike <= spot) || (c.type === 'call' && c.strike >= spot));
  const byStrike = new Map();
  for (const row of sideRows) {
    const prev = byStrike.get(row.c.strike);
    if (!prev || (['good', 'limited', 'stale'].indexOf(row.q.quality) < ['good', 'limited', 'stale'].indexOf(prev.q.quality)) ||
      (row.q.quality === prev.q.quality && row.q.spread < prev.q.spread)) byStrike.set(row.c.strike, row);
  }
  const sorted = [...byStrike.values()].sort((a, b) => a.c.strike - b.c.strike);
  const strike = relativeStrike * spot;
  const exact = sorted.find(row => Math.abs(row.c.strike - strike) <= 1e-9 * spot);
  const lower = exact || sorted.filter(row => row.c.strike < strike).at(-1);
  const upper = exact || sorted.find(row => row.c.strike > strike);
  if (!lower || !upper) return null;
  const t = (+dateOnly(lower.c.expiry) - +now) / YEAR;
  const weight = exact ? 0 : Math.log(strike / lower.c.strike) / Math.log(upper.c.strike / lower.c.strike);
  const variance = lower.c.iv ** 2 * (1 - weight) + upper.c.iv ** 2 * weight;
  return {expiry: lower.c.expiry, t, totalVariance: variance * t,
    quality: worse(lower.q.quality, upper.q.quality),
    method: exact ? 'quoted' : 'interpolated',
    warnings: [...new Set([...lower.q.warnings, ...upper.q.warnings])],
    coverage: {expiry: lower.c.expiry, strikeLow: lower.c.strike, strikeHigh: upper.c.strike,
      relativeStrikeLow: lower.c.strike / spot, relativeStrikeHigh: upper.c.strike / spot,
      optionTypes: [...new Set([lower.c.type, upper.c.type])],
      quoteTimes: [...new Set([lower.c.quoteAsOf, upper.c.quoteAsOf])],
      ivTimes: [...new Set([lower.c.ivAsOf, upper.c.ivAsOf])]},
    strikeDistancePct: Math.max(Math.abs(lower.c.strike / spot - relativeStrike), Math.abs(upper.c.strike / spot - relativeStrike)) * 100};
}
function estimate(groups, relativeStrike, target, snapshot, now) {
  const slices = [...groups.values()].map(rows => atExpiry(rows, relativeStrike, snapshot.spot, now))
    .filter(Boolean).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const targetDay = target.toISOString().slice(0, 10);
  const exact = slices.find(s => s.expiry === targetDay);
  const low = exact || slices.filter(s => s.expiry < targetDay).at(-1);
  const high = exact || slices.find(s => s.expiry > targetDay);
  if (!low || !high) return null;
  const t = (+target - +now) / YEAR;
  const weight = exact ? 0 : (t - low.t) / (high.t - low.t);
  const totalVariance = low.totalVariance * (1 - weight) + high.totalVariance * weight;
  const warnings = [...new Set([...low.warnings, ...high.warnings])];
  let quality = worse(low.quality, high.quality);
  const expiryDistanceDays = Math.max(Math.abs(+dateOnly(low.expiry) - +target), Math.abs(+dateOnly(high.expiry) - +target)) / DAY;
  const strikeDistancePct = Math.max(low.strikeDistancePct, high.strikeDistancePct);
  if (strikeDistancePct > 10 || expiryDistanceDays > 62) {
    quality = worse(quality, 'limited'); warnings.push('Sparse interpolation bracket: strike distance exceeds 10 percentage points or expiry distance exceeds 62 days.');
  }
  if (!exact && high.totalVariance < low.totalVariance - 1e-10) {
    quality = worse(quality, 'limited'); warnings.push('Total variance decreases across these expiries; surface consistency needs review.');
  }
  return {iv: Math.sqrt(totalVariance / t), relativeStrike, strike: relativeStrike * snapshot.spot,
    targetDate: targetDay, method: exact && low.method === 'quoted' ? 'quoted' : 'interpolated',
    quality, warnings, coverage: exact ? [low.coverage] : [low.coverage, high.coverage],
    distance: {strikePercentagePoints: strikeDistancePct, expiryDays: expiryDistanceDays},
    totalVariance, annualization: 'ACT/365', extrapolated: false};
}

export function summarizeSurface(raw, {months, now: nowValue = new Date(), kPct = 80, kiPct = 65, koPct = 100} = {}) {
  const now = clock(nowValue), snapshot = validateSnapshot(raw, now);
  for (const [name, value] of Object.entries({kPct, kiPct, koPct})) if (!finite(value) || value <= 0 || value > 300) throw new Error(`${name} must be a positive percentage, at most 300`);
  const target = addCalendarMonths(now, months);
  const groups = new Map(), rejected = {};
  for (const c of snapshot.contracts) {
    const q = candidateQuality(c, snapshot, now);
    if (!q.eligible) { rejected[q.reason] = (rejected[q.reason] || 0) + 1; continue; }
    if (!groups.has(c.expiry)) groups.set(c.expiry, []);
    groups.get(c.expiry).push({c, q});
  }
  const levels = {atm: 1, k: kPct / 100, ki: kiPct / 100, ko: koPct / 100};
  const estimates = Object.fromEntries(Object.entries(levels).map(([name, level]) => [name, estimate(groups, level, target, snapshot, now)]));
  const warnings = [...snapshot.warnings];
  for (const [name, value] of Object.entries(estimates)) {
    if (!value) warnings.push(`${name.toUpperCase()} has no valid strike and expiry brackets; no extrapolation performed.`);
    else warnings.push(...value.warnings);
  }
  return {ticker: snapshot.ticker, spot: snapshot.spot, spotAsOf: snapshot.spotAsOf,
    months, targetDate: target.toISOString().slice(0, 10), asOf: snapshot.asOf, source: snapshot.source,
    ...estimates, quality: {status: !estimates.atm ? 'missing' : Object.values(estimates).filter(Boolean).reduce((status, value) => worse(status, value.quality), 'good'),
      complete: Object.values(estimates).every(Boolean), validContracts: [...groups.values()].reduce((n, rows) => n + rows.length, 0),
      totalContracts: snapshot.contracts.length, rejected}, warnings: [...new Set(warnings)],
    method: 'Vendor IV; log-strike variance interpolation and ACT/365 total-variance tenor interpolation; no extrapolation.'};
}
