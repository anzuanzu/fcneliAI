# 部署即時行情 API

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
