import {validateSnapshot} from './iv-engine.mjs';

export const CSV_COLUMNS = ['ticker','spot','spotAsOf','asOf','source','expiry','strike','type','bid','ask','ivPercent','ivAsOf','quoteAsOf','volume','openInterest'];
export const CSV_TEMPLATE = `${CSV_COLUMNS.join(',')}\nYOUR_TICKER,,,,,YYYY-MM-DD,,put,,,,,,,\n`;

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error('CSV 引號位置不正確');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') {
        if (row.some(v => v.trim())) rows.push(row);
        row = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else {
      if (closed && c.trim()) throw new Error('CSV 關閉引號後有額外文字');
      if (!closed) cell += c;
    }
  }
  if (quoted) throw new Error('CSV 有未關閉的引號');
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

function numeric(value, column, required = false) {
  if (value.trim() === '') {
    if (required) throw new Error(`CSV ${column} 不可空白`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`CSV ${column} 必須是數字`);
  return n;
}

export function importSnapshots(text, now = new Date()) {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('檔案過大，限 4 MB');
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let snapshots;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const raw = JSON.parse(trimmed);
    snapshots = Array.isArray(raw) ? raw : Array.isArray(raw.snapshots) ? raw.snapshots : [raw];
  } else {
    const [header, ...rows] = parseCsv(trimmed);
    if (!header) throw new Error('CSV 檔案是空的');
    const keys = header.map(x => x.trim());
    if (new Set(keys).size !== keys.length || CSV_COLUMNS.some(k => !keys.includes(k))) throw new Error(`CSV 欄位需包含：${CSV_COLUMNS.join(', ')}`);
    if (rows.length > 20000) throw new Error('CSV 最多 20,000 筆合約');
    const byTicker = new Map();
    for (const [index, cells] of rows.entries()) {
      if (cells.length !== keys.length) throw new Error(`CSV 第 ${index + 2} 列的欄位數不符`);
      const c = Object.fromEntries(keys.map((key, i) => [key, cells[i].trim()]));
      const base = {schemaVersion: 1, ticker: c.ticker.toUpperCase(), spot: numeric(c.spot, 'spot', true),
        spotAsOf: c.spotAsOf, asOf: c.asOf, source: c.source, ivUnit: 'annualized-decimal'};
      const existing = byTicker.get(base.ticker);
      if (existing && ['spot','spotAsOf','asOf','source'].some(key => existing[key] !== base[key])) throw new Error(`${base.ticker} 的價格、資料時間及來源必須一致，請分開匯入不同時間的快照`);
      if (!existing) byTicker.set(base.ticker, {...base, contracts: []});
      const percent = numeric(c.ivPercent, 'ivPercent');
      byTicker.get(base.ticker).contracts.push({expiry: c.expiry, strike: numeric(c.strike, 'strike', true), type: c.type.toLowerCase(),
        bid: numeric(c.bid, 'bid'), ask: numeric(c.ask, 'ask'), iv: percent === null ? null : percent / 100,
        ivAsOf: c.ivAsOf || null, quoteAsOf: c.quoteAsOf || null,
        volume: numeric(c.volume, 'volume'), openInterest: numeric(c.openInterest, 'openInterest')});
    }
    snapshots = [...byTicker.values()];
  }
  if (!snapshots.length || snapshots.length > 100) throw new Error('一次請匯入 1–100 檔股票');
  const validated = snapshots.map(raw => validateSnapshot(raw, now));
  if (validated.some(s => s.contracts.length > 20000)) throw new Error('每檔股票最多 20,000 筆合約');
  if (new Set(validated.map(s => s.ticker)).size !== validated.length) throw new Error('同一檔股票只能有一份快照');
  if (validated.some(s => !s.contracts.length)) throw new Error('沒有有效合約，請檢查履約價、到期日、IV 單位與時間格式');
  return validated;
}
