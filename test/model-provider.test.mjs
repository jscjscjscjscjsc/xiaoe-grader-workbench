import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModelHealth, evaluateSubmission } from '../src/model-provider.mjs';
import { evaluationCacheKey } from '../src/evaluation-cache.mjs';

test('uses an honest fallback for inaccessible submissions', async () => {
  const result = await evaluateSubmission({
    rubric: '检查 Linux 作业', submission: { answer: 'https://example.com/private' },
    web: { status: 'unavailable', reason: '需要登录', text: '', code: [] }, model: {}
  });
  assert.equal(result.grade, '需复核');
  assert.equal(result.requiresReview, true);
  assert.match(result.comment, /无法查看/);
});

test('uses conservative feedback without a configured model', async () => {
  const result = await evaluateSubmission({
    rubric: '检查命令和验证结果', submission: { answer: 'https://example.com/post' },
    web: { status: 'ok', text: 'Linux 网络配置\n'.repeat(40), code: ['ip addr'], source: 'public_webpage' }, model: {}
  });
  assert.equal(result.grade, '良好');
  assert.equal(result.requiresReview, false);
});

test('does not pretend to read images without a vision model', async () => {
  const result = await evaluateSubmission({
    rubric: '检查 Python 作业', submission: { answer: '', imageUrls: ['https://example.com/homework.jpg'] },
    web: { status: 'ok', text: '', code: [], source: 'submission_text' }, model: {}
  });
  assert.equal(result.grade, '需复核');
  assert.equal(result.requiresReview, true);
  assert.match(result.comment, /图片/);
});

test('cache key changes with grading rules or content, never student name', () => {
  const base = { model: { baseUrl: 'https://api.example.com/v1', model: 'gpt-5.6' }, web: { status: 'ok', text: 'ip addr', code: [] }, imageUrls: [] };
  const first = evaluationCacheKey({ ...base, rubric: '检查命令', student: '甲' });
  const sameContent = evaluationCacheKey({ ...base, rubric: '检查命令', student: '乙' });
  const changedRule = evaluationCacheKey({ ...base, rubric: '检查安全组', student: '甲' });
  const changedContent = evaluationCacheKey({ ...base, rubric: '检查命令', web: { ...base.web, text: 'iptables -L' } });
  assert.equal(first, sameContent);
  assert.notEqual(first, changedRule);
  assert.notEqual(first, changedContent);
});

test('does not turn a temporary website block into a student-facing invalid-link comment', async () => {
  const result = await evaluateSubmission({
    rubric: '检查 Python 作业', submission: { answer: 'https://blog.csdn.net/example' },
    web: { status: 'retry_later', reason: 'HTTP 521，已重试 3 次', text: '', code: [] }, model: {}
  });
  assert.equal(result.requiresReview, true);
  assert.doesNotMatch(result.comment, /补交.*链接/);
});

test('model health refuses to claim a missing institution key is usable', async () => {
  const health = await checkModelHealth({ baseUrl: 'https://api.example.com/v1', model: 'gpt-5.6', apiKey: '' });
  assert.equal(health.ok, false);
  assert.equal(health.code, 'missing_configuration');
});
