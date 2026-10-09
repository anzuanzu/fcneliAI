# 手動 IV 研究與選用行情 API

## 先用手動匯入，不需要券商帳戶

第一階段可直接使用 GitHub Pages 網頁的手動選擇權 CSV／JSON 匯入與商品研究功能，不需要修改 Worker 設定、付費 API 或券商帳戶。匯入的是使用者自行合法取得的資料；程式無法憑空產生市場 IV。範例、手動假設與市場報價必須分開標示，資料缺少時不得以歷史波動率冒充 IV。

JSON 與 API 的 `iv` 使用年化小數：`0.35` 代表 `35%`；手動 CSV 的 `ivPercent` 則填 `35`，不要填 `0.35`。需保留現價、現價時間、選擇權報價時間、IV 更新時間、到期日、履約價與買賣價等資訊。資料過期、缺少時間、有效價位不足或天期缺口，會限制可用的研究結果。網站的簡化模型與情境結果不等同銀行可成交票息。

現有股票掃描與手動匯入是分開的資料流程。股票行情連線失敗，不表示已取得或未取得選擇權資料；請看實際資料來源及品質訊息。

### 手動匯入步驟與欄位

1. 開啟「IV 與商品研究」區域，下載空白 CSV 範本。範本沒有示範市場報價，必須填入自行取得的資料。
2. 每列填一筆選擇權合約，使用以下完整欄位名稱；所有欄位都要存在，沒有的選用數值可留空。
3. 匯入 CSV／JSON，輸入研究股票代碼或沿用已勾選的股票。匯入代碼需與研究代碼一致。
4. 檢查 3／4／5／6 個月 ATM、K、KI、KO 的 IV 及「來源與覆蓋明細」，再設定相關係數、利率、股息率與觀察規則進行比較。

```csv
ticker,spot,spotAsOf,asOf,source,expiry,strike,type,bid,ask,ivPercent,ivAsOf,quoteAsOf,volume,openInterest
```

| CSV 欄位 | 填寫方式 |
| --- | --- |
| `ticker` | 股票代碼，同一快照每列使用相同代碼 |
| `spot` | 快照現價，正數 |
| `spotAsOf` | 該現價時間，必填含時區 ISO 字串 |
| `asOf` | 快照取得時間，必填含時區 ISO 字串 |
| `source` | 實際提供資料的來源，必填；不可將自行假設標示為市場報價 |
| `expiry` | 到期日，`YYYY-MM-DD` |
| `strike` | 履約價，正數 |
| `type` | `put` 或 `call` |
| `bid`、`ask` | 選擇權買賣報價；留空或無效報價不參與曲面插值 |
| `ivPercent` | 年化 IV 百分比，`35` 代表 35%；缺資料留空 |
| `ivAsOf`、`quoteAsOf` | IV／選擇權報價更新時間；可信資料需含時區，未知可留空並標示受限 |
| `volume`、`openInterest` | 成交量與未平倉量，沒有可留空 |

含時區時間格式例如 `YYYY-MM-DDTHH:mm:ssZ` 或 `YYYY-MM-DDTHH:mm:ss+08:00`；請填實際時間與實際時區，不要自行推定。每檔股票的 `spot`、`spotAsOf`、`asOf`、`source` 必須逐列一致，不同時間的快照要分開匯入。

JSON 使用與接口相同的 schemaVersion 1 快照，`ivUnit` 為 `annualized-decimal`，合約的 `iv` 為年化小數；可輸入單筆快照、快照陣列或 `{ "snapshots": [...] }`。數值必須是 JSON number，缺少的 IV／報價為 `null`，不要用百分比字串。CSV 檔最多 20,000 筆合約；JSON 每檔最多 20,000 筆；一次匯入 1～100 檔、檔案最大 4 MiB。畫面每次研究最多 20 檔、商品模擬最多 6 檔。

匯入與存取密碼僅保留在本次頁面，重新整理會清除；手動資料由瀏覽器解析，不傳送給行情 Worker。模型報告可匯出 JSON，包含研究輸入與驗證後的快照，請自行妥善保存。模型條款、插值方式與限制詳見 [IV_RESEARCH.md](IV_RESEARCH.md)。

## 選用：部署原有股票掃描 Worker

本網站預設直接呼叫 TradingView Scanner，部署 Worker 後可加上快取並避免每位訪客直接請求上游。

```bash
npx wrangler login
npx wrangler deploy
```

部署完成後，將 Worker 網址寫入 `index.html` 主要程式碼之前：

```html
<script>window.FCNELI_SCAN_API_URL = 'https://你的-worker.workers.dev/api/scan';</script>
```

Worker 會快取行情 10 分鐘。它只代理固定的美股掃描請求，不接受使用者自訂的上游網址或查詢條件。

## 選用：日後連接 Tradier / ORATS IV

目前沒有資料帳戶也能使用手動匯入。以下步驟只供日後具備合格 Tradier Brokerage 帳戶、production API token 及適當資料使用權時啟用。開戶資格、帳戶費用、資料權限與方案可能不同；本專案不承諾券商或資料永久免費。

只使用固定 production 端點 `https://api.tradier.com/v1/markets/`。不使用 sandbox 或 indicative 資料作市場 IV。Worker 只讀行情，不存取帳戶、下單或交易 API。

```bash
npx wrangler secret put TRADIER_TOKEN
npx wrangler secret put OPTIONS_ACCESS_KEY
npx wrangler deploy
```

`TRADIER_TOKEN` 是券商 production token，僅輸入 Worker secret。`OPTIONS_ACCESS_KEY` 是自行產生的另一組私人研究密碼，不是券商 token；在網頁的存取密碼欄輸入。不要把任何金鑰放進 GitHub、HTML、公開腳本、CSV、網址查詢參數或 Wrangler `[vars]`。前端不得把密碼存入 localStorage；請避免共用私人密碼。

網站可從已設定的股票掃描 Worker 主機衍生 `/api/options`，並在「選用自動查詢」欄確認或手動輸入接口網址；也可在主要程式載入前明確設定：

```html
<script>
  window.FCNELI_OPTIONS_API_URL = 'https://你的-worker.workers.dev/api/options';
</script>
```

Worker 的 `ALLOWED_ORIGIN` 應設定為自己的網頁 origin，例如 `https://anzuanzu.github.io`，不可包含路徑。瀏覽器傳送 `GET /api/options?ticker=AAPL` 與 `X-Options-Key` header；CORS 支援 `GET, POST, OPTIONS` 和該 header。Origin 控制不是身份驗證；私人密碼才是此研究接口的存取限制。

### 預設關閉、私人使用優先

- 缺少 `TRADIER_TOKEN`：HTTP 503，`OPTIONS_NOT_CONFIGURED`。
- 設定 token、未設定私人密碼且未開放公開模式：HTTP 503，`OPTIONS_ACCESS_NOT_CONFIGURED`。
- 已設定私人密碼、未提供或錯誤密碼：HTTP 401，`OPTIONS_ACCESS_REQUIRED`。驗證發生在讀取快取前。
- 上游拒絕／資料格式不符：HTTP 502；超時 HTTP 504；忙碌 HTTP 429。不提供替代或猜測 IV，不透出上游錯誤內容／token。

若要公開分享市場資料，須先確認券商、ORATS、交易所等所需的展示／再分發權。個人免費或券商帳戶的資料權不代表公開網站展示權。取得權利後才能在 Wrangler `[vars]` 額外設定 `ALLOW_PUBLIC_OPTIONS = "true"`，並移除私人密碼才能提供無密碼接口。保持預設關閉即可繼續使用手動匯入。

私人密碼是簡單研究用閘門；大量或多人使用應另外加上 Cloudflare Access／全域限流。不要將此接口當作公開帳戶資料代理。

### 資料格式與品質

接口回傳 `schemaVersion: 1`、`ticker`、`spot`、`spotAsOf`、`asOf`、`source: "Tradier / ORATS"`、`contracts` 與 `warnings`。每筆合約保留 `expiry`、`strike`、`type`、`bid`、`ask`、`iv`、`ivAsOf`、`quoteAsOf`、`volume`、`openInterest`。

- `iv` 僅來自 ORATS `greeks.mid_iv`，是年化小數；缺少、非數值或無效 IV 保留 `null`。不改用 ATR、周振幅或歷史波動率。
- `spot` 是 Tradier 最後成交價，`spotAsOf` 是該成交時間，不是請求時間；`quoteAsOf` 採買賣報價兩側較舊的時間。`asOf` 只代表接口取得資料的時間。
- Tradier 官方說明選擇權行情即時、Greeks／IV 每小時更新，兩者不能視為完全同步。所有合約保留各自時間，並標示缺時間、舊報價與現價／選擇權時間差等問題。
- ORATS `updated_at` 的官方範例是沒有時區的時間字串。接口保留原始 `ivAsOf`，並以 `ivTimestampTimezone: "unspecified"` 和警示標示；不擅自假設 UTC／台北／美東。若提供帶時區時間則轉為 ISO UTC。未知時區資料不可被當成已確認的同步曲面。
- 畸形、非同一標的或非標準 100 股合約排除。買賣價失效、缺 IV、低流動性等仍須由研究引擎進一步篩選，不代表每一筆都能定價。
- 最接近 1～9 個月的上市到期日最多取 9 組，範圍限 14～310 天；實際到期日取決於市場，不保證每個天期都有資料，也不保證低 KI 附近有有效價位。

### 請求與費用控制

每個未命中快取的標的最多 11 次上游 GET（現價、到期日、最多 9 組鏈）；選擇權鏈最多同時 3 組。每次上游 6 秒超時、整組預算 25 秒；單回應 2 MiB、單鏈 2,000 筆、整組 8,000 筆合約，超限明確失敗，不回傳悄悄截斷的曲面。

選擇權快取 5 分鐘，鍵包含 schema 版本、標的及 token 的不可逆摘要，原始金鑰不放入快取網址。快取僅為 Worker 內部 Cache API；傳給瀏覽器的回應一律 `private, no-store`。存取驗證仍先於快取。

每個 Worker isolate 最多同時刷新 2 個標的、每分鐘 6 組未快取查詢；同一標的並行查詢合併。這是本地防護，不是分散式全域用量上限。不同 edge 節點可能各自取資料；需要大規模使用時，應依實際方案增加 Durable Object／全域閘門及費用上限。免費 Worker 額度與券商限流仍以供應商實際規則為準。

### 驗證

```bash
node --test tests/worker-options.test.mjs
```

測試以 mock 行情驗證未設定、存取限制、資料正規化、錯誤清理、快取與原有掃描功能；不需真實 token。沒有帳戶時，無法驗證 live 覆蓋率、ORATS 時區或合約實際可用性。

官方資料：[Tradier 行情與更新頻率](https://docs.tradier.com/docs/market-data)、[選擇權鏈](https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains)、[到期日](https://docs.tradier.com/reference/brokerage-api-markets-get-options-expirations)、[報價與 IV 欄位](https://docs.tradier.com/docs/quotes)、[Tradier 方案](https://tradier.com/pricing)。
