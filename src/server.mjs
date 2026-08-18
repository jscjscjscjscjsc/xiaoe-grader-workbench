import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { XiaoeAdapter, sleep } from './xiaoe-adapter.mjs';
import { readSubmissionPage } from './web-reader.mjs';
import { checkModelHealth, evaluateSubmission } from './model-provider.mjs';
import { evaluationCacheKey, getCachedEvaluation, setCachedEvaluation } from './evaluation-cache.mjs';
import { classifyFailure, retry } from './recovery.mjs';
import { loadLocalEnv } from './config.mjs';

const ROOT_DIR = join(import.meta.dirname, '..');
loadLocalEnv(ROOT_DIR);
const PORT = Number(process.env.PORT || 4317);
const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (/^chrome-extension:\/\//.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
app.use('/downloads', express.static('dist'));

const tasks = new Map();
const listeners = new Map();
const appDir = join(homedir(), '.xiaoe-grader');
mkdirSync(appDir, { recursive: true });
const DEFAULT_MODEL = {
  baseUrl: process.env.XIAOE_GRADER_MODEL_BASE_URL || 'https://api.anmoxuan.xyz/v1',
  model: process.env.XIAOE_GRADER_MODEL_NAME || 'gpt-5.6-terra',
  apiKey: process.env.XIAOE_GRADER_MODEL_API_KEY || ''
};

loadPersistedTasks();

function emit(task, event, data = {}) {
  task.updatedAt = new Date().toISOString();
  task.events.unshift({ id: randomUUID(), at: task.updatedAt, event, ...data });
  task.events = task.events.slice(0, 300);
  for (const res of listeners.get(task.id) || []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ task: publicTask(task), ...data })}\n\n`);
  }
}

function publicTask(task) {
  const { model, ...safeConfig } = task.config;
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    config: { ...safeConfig, model: { baseUrl: model.baseUrl, model: model.model, configured: Boolean(model.apiKey), source: model.source } },
    assignment: task.assignment,
    progress: task.progress,
    results: task.results,
    failure: task.failure || null,
    checkpoint: task.checkpoint || null,
    events: task.events.slice(0, 80),
    error: task.error || null
  };
}

function validateConfig(body) {
  const url = String(body.xiaoeUrl || '').trim();
  if (!/^https:\/\/admin\.xiaoe-tech\.com\/t\/exam\/exercise/.test(url)) throw new Error('请输入有效的小鹅通作业后台地址。');
  if (!url.includes('commit_detail')) throw new Error('第一版请使用“学生作业”提交详情页（commit_detail）地址。');
  if (!String(body.rubric || '').trim()) throw new Error('请填写批改要求。');
  if (!body.autoSubmit) throw new Error('本版本只在明确开启“自动提交点评”后启动，以避免误操作。');
  if (!String(body.model?.apiKey || DEFAULT_MODEL.apiKey).trim()) throw new Error('机构模型服务尚未配置密钥。请由部署管理员配置服务端密钥后再开始，系统不会使用无模型的虚假回退批改。');
  return {
    xiaoeUrl: url,
    rubric: String(body.rubric).trim().slice(0, 12000),
    autoSubmit: true,
    maxStudents: Math.max(1, Math.min(Number(body.maxStudents || 999), 999)),
    model: {
      baseUrl: String(body.model?.baseUrl || DEFAULT_MODEL.baseUrl).trim(),
      // The organization secret stays in the server environment. An optional personal
      // key remains supported for self-hosted users, but it is never persisted.
      apiKey: String(body.model?.apiKey || DEFAULT_MODEL.apiKey).trim(),
      model: String(body.model?.model || DEFAULT_MODEL.model).trim(),
      source: body.model?.apiKey ? 'personal' : 'organization',
      temperature: Math.max(0, Math.min(Number(body.model?.temperature ?? 0.35), 1))
    }
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, port: PORT }));
app.get('/api/model-health', async (_req, res) => {
  const health = await checkModelHealth({ ...DEFAULT_MODEL, temperature: 0 });
  res.status(health.ok ? 200 : 503).json(health);
});
app.get('/api/tasks/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或服务已重启。' });
  res.json(publicTask(task));
});
app.get('/api/tasks/:id/events', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ task: publicTask(task) })}\n\n`);
  if (!listeners.has(task.id)) listeners.set(task.id, new Set());
  listeners.get(task.id).add(res);
  req.on('close', () => listeners.get(task.id)?.delete(res));
});
app.post('/api/tasks', (req, res) => {
  try {
    const config = validateConfig(req.body);
    const id = randomUUID();
    const task = {
      id, config, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      assignment: null, progress: { total: 0, completed: 0, succeeded: 0, review: 0, failed: 0, percent: 0 },
      results: [], events: [], abort: false, error: null, failure: null, pendingResult: null, deferredAnswerIds: [],
      checkpoint: { lastStudent: null, lastAnswerId: null, phase: 'created', attempts: 0 }
    };
    tasks.set(id, task);
    emit(task, 'created', { message: '任务已创建，正在打开小鹅通登录页面。' });
    if (req.body.execution === 'extension') {
      task.status = 'waiting_extension';
      emit(task, 'waiting_extension', { message: '正在连接浏览器扩展，并打开老师的小鹅通作业页。' });
    } else {
      runTask(task, false, Boolean(req.body.dryRun)).catch(error => failTask(task, error));
    }
    persistTask(task);
    res.status(201).json(publicTask(task));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/tasks/:id/analyze-and-continue', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或服务已重启。' });
  if (!['recovery_needed', 'failed', 'partial'].includes(task.status)) return res.status(409).json({ error: '当前任务不需要恢复。' });
  task.abort = false; task.error = null;
  task.status = 'recovering';
  emit(task, 'recovering', { message: '已完成失败原因分析，正在从小鹅通未点评列表恢复任务。', failure: task.failure });
  persistTask(task);
  runTask(task, true, Boolean(req.body?.dryRun)).catch(error => failTask(task, error));
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/fallback-browser', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或服务已重启。' });
  if (task.status !== 'waiting_extension') return res.status(409).json({ error: `任务当前状态为 ${task.status}，无需切换执行方式。` });
  task.status = 'recovering'; task.error = null;
  emit(task, 'recovering', { message: '浏览器扩展未开始执行，已切换到独立 Chrome 模式。' });
  persistTask(task);
  runTask(task, true, false).catch(error => failTask(task, error));
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/evaluate', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  try {
    const submission = normalizeSubmission(req.body.submission);
    if (!submission.student) throw new Error('浏览器扩展未读取到学生信息。');
    task.status = 'running';
    emit(task, 'reading_submission', { message: `正在读取第 ${task.progress.completed + 1} 位学生的提交内容。` });
    const web = await readSubmissionPage(submission.answer);
    if (web.status === 'retry_later') throw new Error(`学生博客暂时受平台限制，未写入点评：${web.reason}`);
    const cacheKey = evaluationCacheKey({ rubric: task.config.rubric, model: task.config.model, web, imageUrls: submission.imageUrls });
    let evaluation = getCachedEvaluation(cacheKey);
    if (evaluation) emit(task, 'cache_hit', { message: '命中本地内容缓存，已复用同规则下的历史评价。' });
    else {
      evaluation = await evaluateSubmission({ rubric: task.config.rubric, submission, web, model: task.config.model });
      setCachedEvaluation(cacheKey, evaluation);
    }
    const result = { student: submission.student, source: web.source, url: web.url || null, status: evaluation.requiresReview ? 'review' : 'success', ...evaluation, at: new Date().toISOString() };
    emit(task, 'evaluated', { message: `${evaluation.grade}：已生成个性化点评。`, result });
    res.json({ result });
  } catch (error) { res.status(422).json({ error: error.message }); }
});
app.post('/api/tasks/:id/initialize', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  const total = Math.max(0, Number(req.body.unreviewed || 0));
  task.assignment = String(req.body.assignment || task.assignment || '当前作业').slice(0, 160);
  task.progress.total = Math.max(task.progress.total, total);
  task.status = 'running';
  emit(task, 'running', { message: `浏览器扩展已连接，发现 ${total} 位未点评学生。` });
  persistTask(task);
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/extension-failed', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  if (['completed', 'paused'].includes(task.status)) return res.json(publicTask(task));
  const error = new Error(String(req.body?.error || '浏览器扩展执行失败。').slice(0, 500));
  const failure = classifyFailure(error);
  task.status = 'recovery_needed'; task.error = failure.message;
  task.failure = { ...failure, at: new Date().toISOString(), checkpoint: { ...task.checkpoint } };
  emit(task, 'recovery_needed', { message: `扩展在${task.checkpoint?.phase || '启动'}阶段暂停：${failure.message}`, failure: task.failure });
  persistTask(task);
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/record', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  const result = req.body.result;
  if (!result?.student || !result?.comment) return res.status(400).json({ error: '缺少已提交的点评记录。' });
  task.results.unshift(result); task.results = task.results.slice(0, 300);
  task.progress.completed++;
  task.progress.succeeded++;
  if (result.requiresReview) task.progress.review++;
  task.progress.percent = task.progress.total ? Math.min(100, Math.round(task.progress.completed / task.progress.total * 100)) : 0;
  emit(task, 'submitted', { message: '老师点评已提交。', result }); emit(task, 'progress');
  persistTask(task);
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/finish', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  const remaining = Number(req.body.unreviewed || 0);
  task.status = remaining > 0 ? 'partial' : 'completed';
  if (!remaining) task.progress.percent = 100;
  emit(task, task.status, { message: remaining ? `本轮完成，仍有 ${remaining} 位未点评。` : '批改完成，未点评人数已归零。' });
  persistTask(task);
  res.json(publicTask(task));
});
app.post('/api/tasks/:id/pause', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  task.abort = true; task.status = 'paused'; emit(task, 'paused', { message: '将在当前学生处理结束后停止。' });
  res.json(publicTask(task));
});
app.get('/api/tasks/:id/export', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  res.setHeader('Content-Disposition', `attachment; filename="xiaoe-grading-${task.id}.json"`);
  res.json({ exportedAt: new Date().toISOString(), task: publicTask(task) });
});

async function runTask(task, resuming = false, dryRun = false) {
  task.status = 'opening_browser'; emit(task, 'opening_browser', { message: '正在启动独立浏览器，请在打开的窗口中扫码登录。' });
  const adapter = await XiaoeAdapter.open(task.config.xiaoeUrl, emit.bind(null, task));
  try {
    task.status = 'waiting_login'; emit(task, 'waiting_login', { message: resuming ? '正在重新连接小鹅通作业页。' : '请扫码登录；如出现店铺列表，只需选择作业所在店铺，系统将自动返回原作业页。' });
    await adapter.waitUntilReady(5 * 60 * 1000);
    const initial = await adapter.getCommitState();
    if (resuming && reconcilePendingSubmission(task, initial)) persistTask(task);
    task.assignment = initial.assignment || '当前作业';
    // The relay's chat route can have short cold-start stalls. Configuration is
    // verified here; the per-student evaluation below owns retriable requests.
    const modelHealth = await checkModelHealth(task.config.model);
    if (!modelHealth.ok) throw new Error(modelHealth.message);
    task.progress.total = Math.max(task.progress.total, task.progress.completed + (initial.unreviewed ?? 0));
    task.status = 'running'; emit(task, 'running', { message: `已进入${task.assignment}，发现 ${task.progress.total} 位未点评学生。` });

    for (let index = 0; index < task.config.maxStudents; index++) {
      if (task.abort) break;
      try {
        const processed = await processOneStudent(task, adapter, dryRun);
        if (!processed) break;
      } catch (error) {
        const failure = classifyFailure(error);
        if (failure.category === 'model_unavailable' && task.checkpoint.lastStudent) {
          recordDeferredStudent(task, failure);
          await adapter.navigateToAssignment();
          await adapter.waitUntilReady(20000);
          continue;
        }
        task.progress.failed++;
        task.failure = { ...failure, at: new Date().toISOString(), checkpoint: { ...task.checkpoint } };
        task.status = 'recovery_needed'; task.error = failure.message;
        emit(task, 'recovery_needed', { message: `任务在${task.checkpoint.phase}阶段暂停：${failure.message}`, failure: task.failure });
        persistTask(task);
        return;
      }
    }
    // A dry-run has intentionally stopped after a verified read/evaluate cycle.
    // Do not let normal completion bookkeeping turn it into a completed assignment.
    if (task.status === 'paused' && task.checkpoint?.phase === 'dry_run_evaluated') {
      persistTask(task);
      return;
    }
    const finalState = await adapter.getCommitState().catch(() => null);
    if (task.abort) { task.status = 'paused'; emit(task, 'paused', { message: '任务已暂停，已完成的点评均已保存。' }); }
    else if (finalState?.unreviewed > 0) { task.status = 'partial'; emit(task, 'partial', { message: `本轮已完成，仍有 ${finalState.unreviewed} 位未点评。` }); }
    else { task.status = 'completed'; task.progress.percent = 100; emit(task, 'completed', { message: '批改完成，未点评人数已归零。' }); }
    persistTask(task);
  } finally { adapter.close(); }
}

function recordDeferredStudent(task, failure) {
  const result = {
    student: task.checkpoint.lastStudent,
    answerId: task.checkpoint.lastAnswerId,
    status: 'deferred', grade: '待重试', issues: [], comment: '模型服务暂时不可用，本次未提交点评，将在任务结束后重试。',
    requiresReview: true, error: failure.message, at: new Date().toISOString()
  };
  if (!task.results.some(item => item.answerId === result.answerId)) task.results.unshift(result);
  task.deferredAnswerIds = [...new Set([...(task.deferredAnswerIds || []), result.answerId])];
  task.progress.failed++;
  task.progress.completed++;
  task.progress.percent = task.progress.total ? Math.min(99, Math.round(task.progress.completed / task.progress.total * 100)) : 0;
  emit(task, 'deferred', { message: '模型暂时不可用，已保留当前学生并继续处理下一位。', result });
  persistTask(task);
}

async function processOneStudent(task, adapter, dryRun = false) {
  let state = await retry(() => adapter.getAnyState(), retryOptions(task, '读取页面状态'));
  // After “点评并继续”, 小鹅通 often stays on the next exercise_check page.
  // Keep a task-level expected count so uncertain submissions can still be
  // reconciled without leaving the current student before the first click.
  let unreviewedBefore = state.kind === 'commit' ? state.unreviewed : Math.max(0, task.progress.total - task.progress.completed);
  if (state.kind === 'commit') {
    if (!state.unreviewed) return false;
    task.checkpoint.phase = 'opening_review';
    await retry(() => adapter.openFirstReview(task.deferredAnswerIds || []), retryOptions(task, '打开学生点评页'));
    await retry(() => adapter.waitForReviewPage(30000), retryOptions(task, '等待学生详情加载'));
    state = await adapter.getAnyState();
  }
  const submission = state.kind === 'review' ? state : await adapter.getReviewState();
  if (!submission.student || !submission.answerId) throw new Error('学生详情尚未完整加载，未执行提交。');
  task.checkpoint = { lastStudent: submission.student, lastAnswerId: submission.answerId, phase: 'evaluating', attempts: 0 };
  persistTask(task);
  emit(task, 'reading_submission', { message: `正在读取第 ${task.progress.completed + 1} 位学生的提交内容。` });
  const web = await retry(() => readSubmissionPage(submission.answer), retryOptions(task, '读取学生公开网页'));
  if (web.status === 'retry_later') throw new Error(`学生博客暂时受平台限制，未写入点评：${web.reason}`);
  const cacheKey = evaluationCacheKey({ rubric: task.config.rubric, model: task.config.model, web, imageUrls: submission.imageUrls || [] });
  let evaluation = getCachedEvaluation(cacheKey);
  if (evaluation) emit(task, 'cache_hit', { message: '命中本地内容缓存，已复用同规则下的历史评价。' });
  else {
    evaluation = await retry(() => evaluateSubmission({ rubric: task.config.rubric, submission, web, model: task.config.model }), retryOptions(task, '调用批改模型', 4));
    setCachedEvaluation(cacheKey, evaluation);
  }
  const result = { student: submission.student, answerId: submission.answerId, source: web.source, url: web.url || null, status: evaluation.requiresReview ? 'review' : 'success', ...evaluation, at: new Date().toISOString() };
  if (dryRun) {
    task.checkpoint = { lastStudent: submission.student, lastAnswerId: submission.answerId, phase: 'dry_run_evaluated', attempts: 0 };
    emit(task, 'dry_run_evaluated', { message: '恢复验证成功：已读取学生并生成评语，未提交点评。', result });
    persistTask(task);
    task.status = 'paused';
    emit(task, 'paused', { message: '恢复验证已完成，未提交任何点评。' });
    return false;
  }
  task.pendingResult = result;
  task.checkpoint = { ...task.checkpoint, phase: 'submitting', unreviewedBefore };
  persistTask(task);
  emit(task, 'evaluated', { message: `${evaluation.grade}：已生成个性化点评。`, result });
  // submitReview is intentionally not retried: it may have sent a successful click.
  await adapter.submitReview(evaluation.comment, submission, unreviewedBefore);
  commitResult(task, result);
  return true;
}

function reconcilePendingSubmission(task, initial) {
  const pending = task.pendingResult;
  const before = task.checkpoint?.unreviewedBefore;
  if (!pending || task.checkpoint?.phase !== 'submitting' || !Number.isFinite(before) || initial.unreviewed >= before) return false;
  commitResult(task, pending, '已通过未点评数量确认上一次提交成功，未重复点评。');
  return true;
}

function commitResult(task, result, message = '老师点评已提交。') {
  if (task.results.some(item => item.answerId && item.answerId === result.answerId)) { task.pendingResult = null; return; }
  task.progress.succeeded++;
  if (result.requiresReview) task.progress.review++;
  task.results.unshift(result); task.results = task.results.slice(0, 300);
  task.progress.completed++;
  task.progress.percent = task.progress.total ? Math.min(100, Math.round(task.progress.completed / task.progress.total * 100)) : 100;
  task.pendingResult = null;
  task.checkpoint = { lastStudent: result.student, lastAnswerId: result.answerId, phase: 'submitted', attempts: 0 };
  emit(task, 'submitted', { message, result }); emit(task, 'progress');
  persistTask(task);
}

function retryOptions(task, phase, attempts = 3) {
  return {
    attempts,
    delayMs: 900,
    onRetry: (error, attempt) => {
      task.checkpoint.attempts = attempt;
      emit(task, 'retrying', { message: `${phase}失败，正在第 ${attempt + 1} 次重试：${error.message}` });
    }
  };
}

function normalizeSubmission(input) {
  return {
    student: String(input?.student || '').trim().slice(0, 120),
    answer: String(input?.answer || '').slice(0, 20000),
    imageUrls: Array.isArray(input?.imageUrls) ? input.imageUrls.filter(url => /^https?:\/\//i.test(url)).slice(0, 9) : []
  };
}

function failTask(task, error) {
  const failure = classifyFailure(error);
  task.status = 'recovery_needed'; task.error = failure.message;
  task.failure = { ...failure, at: new Date().toISOString(), checkpoint: { ...task.checkpoint } };
  emit(task, 'recovery_needed', { message: `任务暂停：${failure.message}`, failure: task.failure });
  persistTask(task);
}

function persistTask(task) {
  writeFileSync(join(appDir, `task-${task.id}.json`), JSON.stringify(publicTask(task), null, 2), 'utf8');
}

function loadPersistedTasks() {
  for (const name of readdirSync(appDir, { withFileTypes: true })) {
    if (!name.isFile() || !/^task-[\w-]+\.json$/.test(name.name)) continue;
    try {
      const saved = JSON.parse(readFileSync(join(appDir, name.name), 'utf8'));
      if (!saved?.id || !saved?.config?.xiaoeUrl) continue;
      const task = {
        ...saved,
        config: {
          ...saved.config,
          model: {
            ...saved.config.model,
            apiKey: DEFAULT_MODEL.apiKey,
            baseUrl: DEFAULT_MODEL.baseUrl || saved.config.model?.baseUrl,
            model: DEFAULT_MODEL.model || saved.config.model?.model,
            source: 'organization'
          }
        },
        events: saved.events || [], results: saved.results || [], abort: false,
        failure: saved.failure || null, checkpoint: saved.checkpoint || { phase: 'restored', attempts: 0 },
        pendingResult: null, deferredAnswerIds: saved.deferredAnswerIds || saved.results?.filter(item => item.status === 'deferred').map(item => item.answerId).filter(Boolean) || [], error: saved.error || null
      };
      // A process cannot safely resume by itself after a restart; preserve the exact
      // checkpoint and present the explicit recovery action to the teacher.
      if (['running', 'recovering', 'opening_browser', 'waiting_login'].includes(task.status)) {
        task.status = 'recovery_needed';
        task.failure = task.failure || { category: 'service_restart', message: '服务已重启，等待从断点恢复。', suggestion: '点击“分析原因并继续”后会从小鹅通未点评列表重新对账。', retryable: true };
      }
      tasks.set(task.id, task);
    } catch { /* Ignore incomplete task snapshots. */ }
  }
}

app.listen(PORT, '127.0.0.1', () => console.log(`小鹅通智能批改工作台：http://127.0.0.1:${PORT}`));
