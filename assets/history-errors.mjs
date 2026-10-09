// Only display known error codes. Provider messages can contain secrets or URLs.
const messages = {
  HISTORY_PROVIDER_AUTH: 'Twelve Data API 金鑰被拒絕；請在 Cloudflare 核對 TWELVE_DATA_API_KEY secret',
  HISTORY_PROVIDER_PERMISSION: 'Twelve Data 拒絕這項資料權限；請核對帳戶的美股日線存取權限',
  HISTORY_PROVIDER_REQUEST: 'Twelve Data 拒絕查詢參數；需檢查 Worker 的資料請求',
  HISTORY_UPSTREAM_RATE_LIMIT: 'Twelve Data 查詢限流；請等待後再試，若持續發生請核對帳戶額度',
  HISTORY_UPSTREAM_DAILY_LIMIT: 'Twelve Data 每日額度已用完；請等 UTC 00:00（台北 08:00）重置',
  HISTORY_LOCAL_RATE_LIMIT: 'Worker 每分鐘保護限制；稍後再試',
  HISTORY_LOCAL_DAILY_LIMIT: 'Worker 每日保護限制；請等 UTC 00:00（台北 08:00）重置',
  HISTORY_BUSY: 'Worker 正在處理其他歷史股價查詢；稍後再試',
  HISTORY_UNAVAILABLE: '資料來源找不到此代碼或沒有足夠歷史股價；請核對代碼與覆蓋',
  HISTORY_UPSTREAM_FORMAT: '資料來源回傳格式或股票資料不符；需檢查來源回應',
  HISTORY_RESPONSE_TOO_LARGE: '資料來源回應超過大小上限',
  HISTORY_UPSTREAM_TIMEOUT: 'Twelve Data 回應逾時；本次批次已停止',
  HISTORY_UPSTREAM_FAILED: 'Twelve Data 連線或服務失敗；本次批次已停止',
  HISTORY_NOT_CONFIGURED: '請在 Worker 設定 TWELVE_DATA_API_KEY secret',
  HISTORY_ACCESS_NOT_CONFIGURED: '請在 Worker 設定 HISTORY_ACCESS_KEY secret',
  HISTORY_ACCESS_REQUIRED: '個人查詢密碼不符；請輸入 HISTORY_ACCESS_KEY，勿輸入供應商 API key',
  HISTORY_LICENSE_NOT_CONFIRMED: '尚未確認帳戶個人研究與展示授權，請參照個人使用設定指引',
  HISTORY_ORIGIN_DENIED: '網站來源不符，請檢查 Worker 的 ALLOWED_ORIGIN',
  INVALID_TICKER: '股票代碼不符，請核對美股代碼'
};
export function historyFailure(body, status) {
  const code = Object.hasOwn(messages, body?.code) ? body.code : null;
  const message = code ? `${messages[code]}（${code}）`
    : `歷史股價接口回應失敗（HTTP ${status}）；請確認已部署新版 Worker`;
  return { message, stopBatch: status === 429 || !(code === 'HISTORY_UNAVAILABLE' || code === 'INVALID_TICKER'),
    rateLimited: status === 429 };
}
export function historyRetrySeconds(body, header, now = Date.now()) {
  const seconds = Number(body?.retryAfterSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(86400, Math.ceil(seconds));
  if (/^\d+$/.test(header || '') && Number(header) > 0) return Math.min(86400, Number(header));
  const date = Date.parse(header);
  return Number.isFinite(date) && date > now ? Math.min(86400, Math.ceil((date - now) / 1000)) : 60;
}
