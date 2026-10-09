import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFailure, historyRetrySeconds} from '../assets/history-errors.mjs';

test('history failures distinguish source auth, private password, missing ticker and both limiters', () => {
  for (const [code,status,description,stop] of [
    ['HISTORY_PROVIDER_AUTH',502,/API 金鑰被拒絕/,true],
    ['HISTORY_PROVIDER_PERMISSION',502,/資料權限/,true],
    ['HISTORY_ACCESS_REQUIRED',401,/個人查詢密碼/,true],
    ['HISTORY_LOCAL_RATE_LIMIT',429,/Worker 每分鐘/,true],
    ['HISTORY_UPSTREAM_RATE_LIMIT',429,/Twelve Data 查詢限流/,true],
    ['HISTORY_UPSTREAM_DAILY_LIMIT',429,/每日額度/,true],
    ['HISTORY_UNAVAILABLE',404,/代碼或沒有足夠歷史/,false]
  ]) {
    const failure = historyFailure({code,error:'private-secret',message:'private-secret'},status);
    assert.match(failure.message,description);
    assert.equal(failure.stopBatch,stop);
    assert.equal(failure.rateLimited,status===429);
    assert.ok(!failure.message.includes('private-secret'));
  }
  assert.equal(historyFailure({code:'<script>private-secret</script>'},502).stopBatch,true);
  assert.equal(historyFailure({code:'toString'},502).message.includes('toString'),false);
  assert.equal(historyFailure({code:'HISTORY_UNAVAILABLE'},429).stopBatch,true);
});
test('retry countdown handles bounded seconds, dates and missing CORS-exposed headers', () => {
  assert.equal(historyRetrySeconds({retryAfterSeconds:120},null),120);
  assert.equal(historyRetrySeconds({},'30'),30);
  assert.equal(historyRetrySeconds({},null),60);
  assert.equal(historyRetrySeconds({},'Fri, 09 Oct 2026 16:31:00 GMT',Date.parse('2026-10-09T16:30:00Z')),60);
  assert.equal(historyRetrySeconds({retryAfterSeconds:1e20},null),86400);
});
