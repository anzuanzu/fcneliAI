# IV 與多檔 FCN 條件研究

這是研究工具：讀取使用者提供的選擇權 IV，檢查 3、4、5、6 個月與不同價位的覆蓋，再按明確的支付條款做簡化模型比較。資料、模型票息及銀行實際報價是不同的資訊。

## 不需要帳戶的使用方式

1. 開啟網站「IV 與商品條件研究」。輸入代碼，或使用原有股票清單勾選。股票行情載入失敗時也能手動輸入代碼。
2. 下載 CSV 空白範本，填入合法取得的選擇權資料；亦可匯入下述 JSON。空白範本沒有市場報價，不可直接用來計算。
3. 填寫上方天期、K、KO、KI，檢查 IV 表格與來源明細。價位及天期都需要有效上下界；不會外推、用 ATR 推估 IV，或把缺值當作零。
4. 調整研究假設，按「比較 3–6 個月條件」。資料不足的天期顯示原因，其他天期仍可計算。
5. 匯出本次研究 JSON，保留輸入快照、條款、模型限制及結果，方便和銀行詢價核對。

匯入、插值及商品模擬都在瀏覽器處理，檔案不會上傳。API 存取密碼不會存入 localStorage；頁面重新整理後需要重新匯入資料。網站既有股票掃描、圖表、AI 及使用狀態功能仍有各自的連線。

## CSV 格式

每列是一筆選擇權合約。欄位名稱須精確一致，可調整順序，但不可重複。

```csv
ticker,spot,spotAsOf,asOf,source,expiry,strike,type,bid,ask,ivPercent,ivAsOf,quoteAsOf,volume,openInterest
```

| 欄位 | 定義 |
| --- | --- |
| ticker | 研究股票代碼，需和選取／輸入代碼一致，例如 AAPL |
| spot | 與選擇權快照對應的正數股價，不能填現今股價搭配舊選擇權資料 |
| spotAsOf | 股價時間，ISO 8601 且有時區 |
| asOf | 快照整理／取得時間，ISO 8601 且有時區 |
| source | 真正的資料來源名稱；引用來源不代表網站已驗證該來源或取得再分發權 |
| expiry | YYYY-MM-DD 的合約到期日 |
| strike | 正數履約價，與股價相同幣別 |
| type | put 或 call |
| bid / ask | 買賣報價；零買價、交叉報價、過寬價差不使用 |
| ivPercent | **年化百分比數字，35 代表 35%**；缺資料留空。不能填歷史波動率、預測波動率或 TradingView 日振幅 |
| ivAsOf | 該 IV 的更新時間；未知留空，不能把下載時間填成 IV 更新時間 |
| quoteAsOf | 買賣報價時間；未知留空 |
| volume / openInterest | 非負數，未知留空 |

有時區的時間格式例如 `2026-10-09T16:00:00-04:00` 或 `2026-10-09T20:00:00Z`；這只是格式示例，不是最新市場資料。不要猜測來源的時區。每檔股票的 spot、spotAsOf、asOf、source 必須一致，避免混合快照。含逗號的來源用雙引號包住。

**注意 CSV 和 JSON 單位不同：CSV ivPercent=35；JSON iv=0.35。** 不會猜測欄位單位。檔案最多 4 MB，一次 1–100 檔，每檔／CSV 最多 20,000 筆合約。一次畫面最多研究 20 檔、商品模擬最多 6 檔。

## JSON 格式

可匯入單一快照、快照陣列或 `{"snapshots": [...]}`。以下只是欄位示意，`null` 須替換為實際資料後使用：

```json
{
  "schemaVersion": 1,
  "ticker": "YOUR_TICKER",
  "spot": null,
  "spotAsOf": "填入有時區的股價時間",
  "asOf": "填入有時區的取得時間",
  "source": "填入資料來源",
  "ivUnit": "annualized-decimal",
  "contracts": [{
    "expiry": "YYYY-MM-DD",
    "strike": null,
    "type": "put",
    "bid": null,
    "ask": null,
    "iv": null,
    "ivAsOf": "填入有時區的IV更新時間",
    "quoteAsOf": "填入有時區的報價時間",
    "volume": null,
    "openInterest": null
  }]
}
```

JSON `iv` 為年化小數：0.35 代表 35%。只使用來源已計算的 IV，不會重新反推美式選擇權 IV。因此來源的利率、股息、借券與提前履約方法仍影響數值。

## IV 曲面與品質

- ATM 為快照 spot 附近；K、KI、KO 為初始 spot 的百分比。下檔優先使用 Put，上檔使用 Call；ATM 可由價外 Put／Call 夾住 spot。
- 同到期日，依 log 相對履約價插值變異數；天期依實際日曆天數插值總變異數 `IV² × T`，使用 ACT/365。不是把 3 個月 IV 乘 √2 當成 6 個月 IV。
- 需要各價位在相關到期日上的有效上下界。超出價位或到期日覆蓋就顯示缺資料，尤其低 KI 常沒有可靠報價。
- bid、ask 必須皆正，ask ≥ bid；價差／中間價不得超過 50%。品質門檻只是研究篩選，並非可成交性證明。
- 未知 IV／報價時區標為受限；股價與報價、IV 與報價相距超過 24 個平日時數的資料排除。任一相關時間超過 72 個平日時數標為過期。
- 稀疏插值（履約價相距超過 10 個百分點或到期日距離超過 62 天）及跨到期日總變異數下降會標為受限。
- 品質時間以 UTC 平日近似，未包含交易所假日日曆。三維表格只表示市場單股選擇權的插值；低價位 Put IV 不是障礙商品 IV。

## 商品模型的精確範圍

本頁試算一種固定條款，並非所有 FCN：

- 1–6 檔股票，取各股票相對初始價格的最差表現，`0 < KI ≤ K ≤ 100%` 且 `K ≤ KO ≤ 200%`。
- 每月 KO；全部股票相對初始價格皆 ≥ KO 才贖回。使用者輸入「首個 KO 觀察月」，早於該月不觀察 KO。首個 KO 在短天期到期之後，該短天期沒有 KO。
- KI 可選每個模型平日觀察，或僅最後估值日觀察。不是連續盤中觸及模型。
- 若未 KO，到期已觸發 KI 且最差相對股價低於 K，本金償付比率為 `最差相對股價 / K比率`；若回升至 K 或未 KI，償付本金。KI 本身不等於本金損失。
- 固定無條件票息從起始日至贖回按 ACT/365 累計，在贖回時一次支付；不含每月實際付息、條件／記憶配息或不同 KI 結算方式。
- 模型使用 UTC 日曆平日；每月觀察／最後估值遇週末往前移至平日，支付仍在原日曆日期。未處理交易所假日、實際收盤時間、交割延遲。

各股票使用該到期 ATM IV 的固定波動率 GBM，利率與連續股息率為輸入，相關性為 0–0.95 的共同相關係數（不是歷史或市場隱含相關係數）。單股市場曲面不能唯一決定多股聯合風險。雖然全套 ATM/K/KI/KO 品質均需可用才准許試算，模型動態只使用 ATM，不是完整曲面校準。

以風險中立模型 Q 計算本金與票息現值，反求平價年化票息：

`年化票息 = (1 − E_Q[折現本金償付]) / E_Q[折現票息累計年期]`

年化票息與累計收到票息不同，提前 KO 會減少存續時間；本金損失亦另計。正／負模型票息都按公式回傳，不會剪裁成看似可售的數字。沒有加入發行人信用、資金利差、銀行費用、避險成本、稅費、股票借券、財報跳躍、離散股息、隨機波動率或尾端相依性。

**Q 下 KO／KI／本金損失機率不是現實事件機率或投資風險預測。** 誤差欄僅為 Monte Carlo 抽樣標準誤，不含模型及資料誤差。匯出研究保留假設與限制，應以相同時點、同一份完整條款的銀行報價另行核對。

## 開發與驗證

Node.js 22+，不用安裝套件即可執行計算／Worker 單元測試：

```bash
npm run check
npm test
```

瀏覽器驗證使用 Playwright 與 Chrome；測試行情為明確的合成 fixture，僅供驗證，不會出現在產品作為市場數據。可設定 `PLAYWRIGHT_MODULE_PATH` 指向既有 Playwright 模組，執行 `npm run test:browser`。執行中用本機 HTTP server 開啟網站，避免以 file:// 開啟 ES module。

資料 API 預設關閉；日後具備帳戶時依 [部署文件](DEPLOYMENT.md) 設定。

方法參考：[TradingView 日振幅公式](https://www.tradingview.com/support/solutions/43000635876-how-is-volatility-calculated-in-the-screener/)、[Cboe 相對價位／固定天期曲面](https://datashop.cboe.com/volatility-surfaces)、[Cboe 美式選擇權 IV 方法](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_American_Style_Options_Implied_Volatility_Calculations_Methodology.pdf)。
