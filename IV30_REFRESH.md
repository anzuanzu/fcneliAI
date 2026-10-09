# 共用 IV30 的定時更新操作

## 實際執行方式

使用本機 Codex 排程，台北時間週二至週六 06:17 執行一次，安排在美股收盤後。電腦需開機、Codex 執行中、瀏覽器工具與 GitHub 登入可用，並受 Codex 帳戶使用額度限制。這不是已驗證可用的 GitHub 雲端爬蟲：標準 Playwright 在本機與 GitHub 實測會遇到 HTTP/2 錯誤或頁面資料列空白；Codex 內建瀏覽器的公開資料表可完整讀取。不逆向加密回應或繞過來源限制。

每次成功擷取後更新公開的 `assets/current-iv30.json` 與 `assets/iv30-update-status.json`，發布到 GitHub Pages。所有訪客讀取這兩份共用檔案，頁面可見時每 5 分鐘檢查一次，切回分頁或視窗也會檢查。背景分頁暫停；檢查不會重複並行。已讀到較新的快照後拒絕較舊檔案，讀取失敗保留最後成功值。第一次取得新版網頁需重新整理一次。

資料顯示的是「最新成功取得的來源快照」，不是即時行情。來源標示延遲 15 分鐘；沒有個股報價更新時間，`sourceAsOf` 保持 null。資料取得時間不得冒充報價更新時間。超過 24 個 UTC 平日時數標示過期，未包含交易所假日。

## 每次排程的步驟

1. 在 `/Users/james/Downloads/fcneliAI-github` 檢查最新版本；不要切換、重設或覆蓋使用者目前分支和檔案。使用 `mcp__cua_repl` 的 Codex 內建瀏覽器開啟公開來源 https://marketchameleon.com/volReports/VolatilityRankings 。首次呼叫按工具入口規範執行，續用既有瀏覽器需讀取其文件。不要檢查其他分頁的密碼、登入 Cookie 或金鑰。
2. 等真正股票資料列出現（`#iv_rankings_report_tbl tbody tr:first-child td:nth-child(2)`），不要把空白／Loading 的單格佔位列當作完成。若遇到登入、CAPTCHA、拒絕或持續空白，停止這次擷取，不破解或繞過。
3. 從目前 DOM 核對表格與標題。點可見 `Symbol` 標題，確認股票代碼排序（例如第一列為字母順序的最前股票、分頁回到第一頁），避免盤中漲跌幅排序位移造成重複／漏股票。選每頁 100 筆，等待 100 列或小於 100 的完整尾頁；確認這時總筆數。
4. 逐頁讀取 `#iv_rankings_report_tbl thead tr:last-child th` 的文字與 `tbody tr` 中所有 `td.innerText`。只透過正常 UI 點 Next，等待第一筆股票代碼變更及真實資料列完成，不直接請求頁面內部端點。每次核對 `Showing x to y of total entries` 的起始位置接續、總數不變，直到 `#iv_rankings_report_tbl_next` 的 class 含 disabled。最多 100 頁；所有列數需等於總數。可以在單次工具呼叫中循序讀數頁；用同一個陣列保存資料，避免跨呼叫 helper 的閉包狀態誤用。最後再次從 DOM 確認尾頁與 disabled。
5. 寫入暫存 JSON，包含 `sourceUrl`（上述網址）、`observedAt`（本次完整取得的 UTC ISO 時間）、`expectedTotal`（整數）、`headers`（標題陣列）、`rows`（每列儲存格陣列）。這只是暫存的公開資料，不提交全表其他欄位。
6. 執行 `node scripts/publish-visible-iv30.mjs /絕對路徑/暫存資料.json`。此工具從最新 origin/main 建立獨立暫存 checkout，驗證標題與 Current IV30 單位、總筆數、唯一代碼、時間及值域，只更新 IV30 與狀態兩個檔案。原子替換資料、提交並正常推送，主分支同步變更會拒絕推送，不會強推。明確要求 Pages 建置，最多約 5 分鐘核對正式站兩個檔案與預期內容完全一致。不要因為 GitHub commit 成功就宣稱網站已更新。
7. 真正來源擷取或驗證失敗時，可執行 `node scripts/publish-visible-iv30.mjs --failed`，只發布本次失敗狀態，完全保留最後成功快照及其時間。若只是資料已推送、Pages 發布尚未確認，應回報「發布未確認」，不要把成功取得的資料偽報擷取失敗。發布／GitHub 登入不可用則保留原檔案並回報具體阻礙。勿捏造数据、填零、以歷史估計代替 IV30 或修改取得時間假裝更新。
8. 完成後關閉本次來源暫存分頁。IV30 更新不得修改 3–6 個月市場 IV、K/KI、商品研究模型、Worker secret 或其他使用者設定。

## 診斷與驗證

`npm run check`、`npm test`、`npm run test:iv30-crawler`、`npm run test:iv30-autorefresh` 與 `npm run test:browser` 都以合成資料驗證軟體；不能用測試資料發布為市場數據。爬蟲合成測試也涵蓋 Loading 佔位列；自動讀取測試涵蓋跨使用者共用快照、舊快照拒絕、失敗保留、背景暫停與防並行。

標準 Playwright 命令仍保留為診斷工具：`npm run refresh:iv30`。現在使用正常 Chrome 視窗，主頁 commit 與真正資料列分開等待；網路／載入錯誤最多重試一次，僅 HTTP/2 協定錯誤改用 HTTP/1.1。HTTP 拒絕或資料驗證錯誤不重試。此命令未驗證能從真實來源得到完整資料，不可當作啟用成功的雲端排程。
