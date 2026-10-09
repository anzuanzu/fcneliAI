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

## 選用：自動取得日收盤價，計算估計波動率

歷史股價情境使用獨立的 `GET /api/history?ticker=AAPL` 接口，不需要券商帳戶，也不需要先取得選擇權 IV。先建立 Twelve Data 資料帳戶、確認所需顯示權利，再取得自己方案允許的 API key。Basic 目前免費額度為每分鐘 8 API credits、每天 800，單一標的 `/time_series` 使用 1 credit；但 Basic 的 non-display 權利不包含本網頁供自然人查看的介面。來源覆蓋、資料深度及權利仍須以帳戶實際許可確認，**不承諾本網頁可以用 Basic 免費啟用，或全部股票免費可取得**。

Basic 價格頁標示 internal non-display usage，Grow 才標示 internal display data access；條款對 non-display 的定義不包含向自然人展示。私人密碼只限制誰能進入，並不能把網頁顯示轉成 non-display。個人方案不能將原始資料或衍生資料當作已獲公開再分發授權。須先取得允許本網頁私人顯示的方案或書面許可，再明確設定 `HISTORY_DISPLAY_LICENSE_CONFIRMED = "true"`；未設定時接口回傳 HTTP 503 `HISTORY_LICENSE_NOT_CONFIRMED`，不查來源、不讀快取、不耗來源額度。這個設定是部署者的許可確認，程式無法自行驗證契約，也不會代替使用者接受資料授權。

本接口固定要求私人密碼，沒有 `ALLOW_PUBLIC_HISTORY`。Twelve Data 條款 2.3(f) 對建立衍生金融商品另要求書面許可；若將工具用於實際商品創建、客戶報價、公開展示或多人商業服務，須先確認對應方案、書面許可及交易所權利，不能只憑私人研究密碼啟用。

在 `worker` 目錄執行，部署前確認所使用的是自己的 Cloudflare 帳戶：

```bash
npx wrangler secret put TWELVE_DATA_API_KEY
npx wrangler secret put HISTORY_ACCESS_KEY
npx wrangler deploy
```

確認上述顯示授權後，才在 Worker 的 Wrangler `[vars]` 或 Cloudflare 環境變數設定 `HISTORY_DISPLAY_LICENSE_CONFIRMED = "true"`。API key 與私人存取密碼仍須用 secrets，不能放進 `[vars]`。未確認授權時保持接口關閉，仍可查看程式及用 mock 測試。

`TWELVE_DATA_API_KEY` 僅保留在 Worker secret，由固定上游 `https://api.twelvedata.com/time_series` 的 `Authorization: apikey ...` header 使用，不進網址、HTML、瀏覽器或 GitHub。`HISTORY_ACCESS_KEY` 是另外自行產生的私人研究密碼；瀏覽器透過 `X-History-Key` header 傳送。若未設定 `HISTORY_ACCESS_KEY`，接口可沿用已設定的 `OPTIONS_ACCESS_KEY`，但 header 仍是 `X-History-Key`。若兩者都有，僅接受 `HISTORY_ACCESS_KEY`。前端存取密碼不得永久儲存；勿將 provider key 輸入網頁。

網頁的歷史接口可衍生自既有掃描 Worker 主機，也可在主要程式載入前設定：

```html
<script>
  window.FCNELI_HISTORY_API_URL = 'https://你的-worker.workers.dev/api/history';
</script>
```

`ALLOWED_ORIGIN` 應設定為網頁 origin，例如 `https://anzuanzu.github.io`。CORS 允許 `X-History-Key`，存取驗證發生在快取查詢之前；Origin 規則不是身份驗證。缺少 provider secret 回傳 HTTP 503 `HISTORY_NOT_CONFIGURED`，缺少私人密碼回傳 503 `HISTORY_ACCESS_NOT_CONFIGURED`，密碼錯誤回傳 401 `HISTORY_ACCESS_REQUIRED`。上游或格式錯誤不回傳來源錯誤原文與金鑰；未支援／不足資料回傳 404，超時 504，上游限流或本地用量限制回傳 429。

### 歷史接口資料與限制

回傳 `{ schemaVersion: 1, ticker, source: "Twelve Data", adjustment: "splits", asOf, timezone, currency, bars, warnings }`。每筆 `bars` 是 `{ date: "YYYY-MM-DD", close: 123.45 }`，按日期遞增，不提供市場 IV。`asOf` 是資料取得時間；最新收盤日以最後一筆 `bars.date` 為準，不得將兩者混為同一報價時間。

- 只查詢單一美股代碼，股別符號 `/` 正規化為 `.`；拒絕批次代碼、自訂上游網址與額外查詢參數。
- 使用 `interval=1day`、`adjust=splits`、美國標的、731 日範圍，最多 600 筆。拆股調整來自供應商，**未要求股息調整**；除息與公司事件更正仍會影響報酬與估計波動率，應查看警示。
- 日線日期是交易所當地日期。只接受 USD／America/New_York 的每日資料，並排除當地今天的日線，即使今天已收盤也保守等下一天，避免混入盤中尚未完成的 candle。
- 重複日期、未來日期、格式錯誤、非正數收盤價、錯誤標的或超過 600 筆整組拒絕，不悄悄補值、截斷或混入另一市場。
- 少於 253 筆收盤價會標示不足完整 252 日報酬窗，最新日線超過 7 個日曆日會警示；最少兩筆才回傳。研究引擎仍須依計算窗口、資料新舊與缺口限制模擬。
- 每個未快取標的一次來源請求，10 秒含回應讀取超時，最大 1 MiB。內部 Cache API 快取 6 小時，鍵包含 schema、標的、美東日期及 provider key 摘要；原始 key 不進快取網址。瀏覽器回應一律 `private, no-store`。
- 每個 isolate 最多同時刷新兩檔，每分鐘七次、UTC 日每天 700 次開始；相同標的同時查詢合併，失敗請求也計數。這不是跨 edge 或跨其他應用的帳戶用量閘門。若要全股票排程，必須另外加入全域排程／持久儲存／Durable Object，遵守 800 日額度；本功能不會自動每日刷新掃描清單的全部股票。

```bash
node --test tests/history-worker.test.mjs tests/worker-options.test.mjs
```

測試以 mock 驗證隱私、請求、拆股資料格式、日線有效性、快取、並行合併、限流、超時、錯誤清理及既有掃描／選擇權接口。尚無 Twelve Data 帳戶金鑰，因此未驗證 live 股票覆蓋、免費歷史深度及實際調整品質；新增接口本身不表示自動行情已啟用。

官方資料：[方案、顯示權與額度](https://twelvedata.com/pricing)、[資料條款與衍生金融商品限制](https://twelvedata.com/terms)、[歷史資料範圍](https://support.twelvedata.com/en/articles/5214728-getting-historical-data)、[每日拆股調整](https://support.twelvedata.com/en/articles/5179064-are-the-prices-adjusted)、[官方 API SDK 的 time_series 參數與日線時區](https://github.com/twelvedata/twelvedata-java/blob/main/docs/MarketDataApi.md#apigettimeseriesrequest)、[個人／商業使用](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage)。
