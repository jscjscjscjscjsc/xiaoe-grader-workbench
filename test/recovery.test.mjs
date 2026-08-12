import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, retry } from '../src/recovery.mjs';

test('retries transient page loading failures and succeeds', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 3) throw new Error('点评页未加载完成');
    return 'ready';
  }, { attempts: 3, delayMs: 1 });
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
});

test('does not hide failures after every retry is exhausted', async () => {
  let calls = 0;
  await assert.rejects(() => retry(async () => { calls++; throw new Error('模型调用失败（HTTP 503）'); }, { attempts: 3, delayMs: 1 }), /503/);
  assert.equal(calls, 3);
});

test('classifies recoverable failures with a practical action', () => {
  const page = classifyFailure(new Error('点评页已打开，但学生信息或点评编辑器未在规定时间内加载完成。'));
  const submit = classifyFailure(new Error('提交后未确认是否进入下一位，列表计数也未减少；未重复点击，等待恢复后重试当前学生。'));
  const auth = classifyFailure(new Error('模型调用失败（HTTP 401）。请检查 Base URL、模型名和 Key。'));
  assert.equal(page.category, 'page_loading');
  assert.equal(submit.category, 'submit_confirmation');
  assert.equal(auth.category, 'model_auth');
  assert.match(submit.suggestion, /核对/);
});

test('survives repeated mixed transient failures', async () => {
  for (let run = 0; run < 30; run++) {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      if (calls <= (run % 3)) throw new Error('网络暂时不可用');
      return run;
    }, { attempts: 3, delayMs: 0 });
    assert.equal(result, run);
    assert.equal(calls, (run % 3) + 1);
  }
});
