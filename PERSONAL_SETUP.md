# 個人使用：自動歷史取價設定

程式已支援自動取得美股日收盤價，估計波動率與相關性，再比較 K／KO／KI 在 3–6 個月的模型條件。你還沒有 API key 時，可先完成程式測試與 Worker 準備；真實自動取價要等取得自己的金鑰。歷史估計不是市場選擇權 IV，票息也是研究模型結果。

## 1. 建立自己的資料帳戶

從 [Twelve Data](https://twelvedata.com/) 建立個人帳戶，在帳戶儀表板取得 API key。先確認免費帳戶是否涵蓋要研究的股票與約兩年的每日歷史資料，不必先購買商用方案。只做日收盤研究，無須券商帳戶、即時行情訂閱或選擇權帳戶。

官方說明美股歷史／日收盤資料從 Basic 開始提供；[個人方案](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage) 適用個人及內部非商業研究。[價格頁](https://twelvedata.com/pricing) 目前列出 Basic 免費額度 8 API credits／分鐘、800／日，並標示 internal non-display。這與私人網頁展示的適用範圍需要分開確認：若帳戶說明不清楚，向供應商描述「單人、密碼限制、日收盤波動率研究」，核對可否使用，不能只憑未收費就認定所有展示都獲授權。本程式不會訂購任何方案。[美股日收盤資料說明](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data)。

**API key 只輸入 Cloudflare 的 secret 設定；不要貼在聊天、GitHub 或網站欄位。** 網站要求的「個人查詢密碼」是另設的密碼，不是這個 API key。

## 2. 準備新版程式與 Worker

使用 [PR #1](https://github.com/anzuanzu/fcneliAI/pull/1) 的 `feat/iv-research` 分支；正式 GitHub Pages 要等合併至 main 才會更新。下載 ZIP 的 `fcneliAI-main` 可能仍是舊版本，請核對是否含 `worker/src/history.js` 與本指引。

所有命令都在**專案根目錄**執行，這裡應看得到 `wrangler.toml`、`index.html`、`worker/`。使用 Node.js 22 或更新版本。

```bash
npm run check
npm test
```

不需要帳戶即可檢查 Worker 能否打包；此命令不發布、不取行情：

```bash
npx wrangler@4 deploy --dry-run --outdir /tmp/fcneli-worker-preview
```

## 3. 設定自己的 Cloudflare Worker

根目錄 `wrangler.toml` 預設 Worker 名稱為 `fcneli-api`。若你已有 Worker，核對名稱後才部署；名稱不同會建立另一個 Worker。用自己的 Cloudflare 帳戶登入：

```bash
npx wrangler@4 login
```

修改 `[vars]`（保留其他原有設定）：

```toml
[vars]
ALLOWED_ORIGIN = "https://anzuanzu.github.io"
# 核對資料帳戶允許個人研究與私人展示後才加入：
HISTORY_DISPLAY_LICENSE_CONFIRMED = "true"
```

`ALLOWED_ORIGIN` 是網站來源，不含 `/fcneliAI/` 路徑；自訂網域時換成自己的 HTTPS 來源。這個確認變數不會購買方案，也不能驗證授權。不確定帳戶範圍時先省略它，仍可部署並檢查缺項。

取得資料金鑰後，在命令提示時分別輸入 secret（勿把值寫在命令、設定檔或 GitHub）：

```bash
npx wrangler@4 secret put TWELVE_DATA_API_KEY
npx wrangler@4 secret put HISTORY_ACCESS_KEY
```

第一項填資料帳戶 API key；第二項填自行產生的長且隨機的個人查詢密碼。兩者必須不同，妥善保存在自己的密碼管理器。若首次尚無 Worker，Wrangler 可能提示建立 Worker；核對帳戶與名稱再繼續。然後發布新版程式：

```bash
npx wrangler@4 deploy --keep-vars
```

也可在 Cloudflare 控制台選擇自己的 Worker → Settings → Variables and Secrets，新增兩個 **Secret**，以及確認變數（文字值 `true`），儲存／部署。從控制台新增普通變數後，CLI 部署使用 `--keep-vars`，保留已保存的用途確認變數；設定檔中同名的變數仍會更新，需先核對。Secrets 不會因一般程式部署而刪除。[Cloudflare secret 設定](https://developers.cloudflare.com/workers/configuration/secrets/)。

沒有資料金鑰時，不填假的 key：保留該 secret 缺項即可。現有股票掃描與手動 IV 匯入不依賴這個金鑰。

## 4. 在新版網頁檢查並取價

1. 開啟「波動率與商品條件研究」，維持「歷史波動率估計」。
2. 將部署回傳的主機網址加上 `/api/history`，填入歷史股價 API 網址。例如 `https://你的-worker.workers.dev/api/history`。不要附加金鑰或查詢參數。
3. 在「個人查詢密碼」輸入 `HISTORY_ACCESS_KEY` 的值。
4. 按「檢查 Worker 設定」。它只檢查設定與密碼，不查行情、不耗行情額度，也不會把 secret 回傳。
5. 設定齊全後輸入 1–6 檔股票，例如 `AAPL, MSFT`，按「自動取得研究股票的歷史股價」。第一筆成功的真實查詢才能確認金鑰與該股票覆蓋。
6. 核對來源與最近完成收盤日，至少要 127 筆收盤價。設定 K／KO／KI、利率、股息率及觀察規則，按「比較 3–6 個月條件」，查看三種情境共 12 組結果。

網址可在頁面手動填入；若需固定預設值，在 `index.html` 的主要程式載入前設定以下公開網址（不含任何 secret）：

```html
<script>
  window.FCNELI_HISTORY_API_URL = 'https://你的-worker.workers.dev/api/history';
</script>
```

查詢密碼與歷史資料只保留在本次頁面，重整會清除；研究 JSON 匯出不包含密碼。每檔歷史資料快取 6 小時，少量查詢即可；日收盤模式不會每天批次抓取全站股票。

## 常見檢查結果

| 訊息 | 下一步 |
| --- | --- |
| 缺少 TWELVE_DATA_API_KEY | 取得資料帳戶 key 後存入 Worker secret |
| 缺少 HISTORY_ACCESS_KEY | 設定自己的個人查詢密碼 |
| 尚未確認個人研究與展示授權 | 核對帳戶範圍後設定確認變數為文字 `true` |
| 個人查詢密碼不符 | 輸入私人密碼，勿輸入供應商 API key |
| 需部署新版 Worker／404 | 核對網址與分支，部署含歷史接口的新版程式 |
| 網站來源不符 | 設定正確 ALLOWED_ORIGIN 後重新部署 |
| 設定齊全但取價失敗 | 設定存在不代表 key 有效；查看帳戶權限、額度、股票涵蓋與資料長度 |
| HTTP 429 | 等待額度恢復；其他程式也可能共用同一帳戶額度 |

沒有真實金鑰時，測試只能確認程式、合成資料計算及錯誤處理，不能確認真實股票資料。完整資料格式與模型假設見 [DEPLOYMENT.md](DEPLOYMENT.md)、[IV_RESEARCH.md](IV_RESEARCH.md)。
