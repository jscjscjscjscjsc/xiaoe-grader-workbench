const $ = selector => document.querySelector(selector);
let activeTask = null;
let source = null;
let extensionReady = false;

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'xiaoe-grader-extension') return;
  if (event.data.type === 'ready') setExtensionState(true);
});
window.postMessage({ source: 'xiaoe-grader-workbench', type: 'ping' }, window.location.origin);

function setExtensionState(ready) {
  extensionReady = ready;
  $('#extension-alert').classList.toggle('connected', ready);
  $('#extension-alert').classList.toggle('standalone', !ready);
  $('#extension-copy').textContent = ready
    ? '扩展已连接，但任务默认使用独立 Chrome，避免扩展或当前浏览器标签页卡住。'
    : '未连接扩展。创建任务会自动使用独立浏览器模式；安装扩展后可改用浏览器内执行。';
  $('#install-link').textContent = ready ? '扩展已连接' : '扩展安装说明';
}

checkModelHealth();
async function checkModelHealth() {
  try {
    const response = await fetch('/api/model-health'); const data = await response.json();
    const label = $('#connection span');
    if (data.ok) { label.textContent = '机构模型已连接'; $('#connection').classList.remove('offline'); }
    else { label.textContent = data.message || '机构模型未就绪'; $('#connection').classList.add('offline'); }
  } catch { $('#connection span').textContent = '无法检查机构模型'; $('#connection').classList.add('offline'); }
}

$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const f = new FormData(event.currentTarget);
  // The independent Chrome runner is the stable default across Doubao, Chrome,
  // Edge, and the in-app browser. The extension remains optional and is not
  // allowed to strand a task in waiting_extension.
  const execution = 'server';
  const payload = { xiaoeUrl: f.get('xiaoeUrl'), rubric: f.get('rubric'), autoSubmit: f.get('autoSubmit') === 'on', maxStudents: Number(f.get('maxStudents')), execution, model: { baseUrl: f.get('baseUrl'), model: f.get('model'), temperature: Number(f.get('temperature')) } };
  $('#form-error').textContent = '';
  try {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建任务失败。');
    showTask(data);
  } catch (error) { $('#form-error').textContent = error.message; }
});
$('#pause').addEventListener('click', async () => { if (activeTask) await fetch(`/api/tasks/${activeTask.id}/pause`, { method: 'POST' }); });
$('#recover').addEventListener('click', async () => {
  if (!activeTask) return;
  const button = $('#recover'); button.disabled = true; button.textContent = '正在分析并恢复...';
  try {
    const response = await fetch(`/api/tasks/${activeTask.id}/analyze-and-continue`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '恢复任务失败。');
    render(data);
  } catch (error) { $('#recovery-detail').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '分析原因并继续'; }
});

function showTask(task) {
  activeTask = task; $('#setup').classList.add('hidden'); $('#workspace').classList.remove('hidden'); $('#export').href = `/api/tasks/${task.id}/export`;
  source?.close(); source = new EventSource(`/api/tasks/${task.id}/events`);
  source.addEventListener('snapshot', event => render(JSON.parse(event.data).task));
  for (const type of ['created', 'waiting_extension', 'opening_browser', 'waiting_login', 'login_required', 'choose_shop', 'returning_assignment', 'running', 'recovering', 'retrying', 'recovery_needed', 'reading_submission', 'cache_hit', 'deferred', 'evaluated', 'submitted', 'submit_failed', 'progress', 'paused', 'partial', 'completed', 'failed']) source.addEventListener(type, event => render(JSON.parse(event.data).task));
  source.onerror = () => { $('#connection').classList.add('offline'); $('#connection').lastChild.textContent = '等待本地服务重连'; };
  render(task);
}
function render(task) {
  activeTask = task; const p = task.progress; const latest = task.events[0];
  $('#assignment-name').textContent = task.assignment || '正在连接小鹅通';
  $('#task-message').textContent = latest?.message || statusText(task.status);
  $('#percent').textContent = `${p.percent || 0}%`; $('#bar').style.width = `${p.percent || 0}%`;
  $('#total').textContent = p.total; $('#done').textContent = p.completed; $('#success').textContent = p.succeeded; $('#review').textContent = p.review;
  $('#progress-label').textContent = p.total ? `${p.completed} / ${p.total} 位学生已处理` : statusText(task.status);
  const pill = $('#status-pill'); pill.textContent = statusText(task.status); pill.className = `status-pill ${task.status}`;
  $('#pause').disabled = ['completed', 'failed', 'paused', 'partial'].includes(task.status); $('#pause').title = $('#pause').disabled ? '任务已结束' : '暂停任务';
  const recovery = $('#recovery-panel');
  const needsRecovery = task.status === 'recovery_needed';
  recovery.classList.toggle('hidden', !needsRecovery);
  if (needsRecovery) $('#recovery-detail').textContent = task.failure?.suggestion || task.failure?.message || '任务暂停，等待恢复。';
  $('#results').innerHTML = task.results.length ? task.results.map(resultCard).join('') : '<div class="empty">任务启动后，这里会显示每位学生的等级、问题与已提交的点评。</div>';
  $('#events').innerHTML = task.events.slice(0, 18).map(e => `<div class="event"><time>${new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><p>${escapeHtml(e.message || eventText(e.event))}</p></div>`).join('');
}
function resultCard(r) { const issues = r.issues?.length ? r.issues.map(i => `<li><b>${escapeHtml(i.question)}</b>${escapeHtml(i.problem)}${i.suggestion ? ` <em>建议：${escapeHtml(i.suggestion)}</em>` : ''}</li>`).join('') : '<li class="ok">未发现需单独指出的明显问题。</li>'; const status = r.status === 'deferred' ? '待重试，未提交' : r.status === 'failed' ? '提交失败' : r.status === 'review' ? '已提交，建议复核' : '已提交'; return `<article class="result ${r.status}"><div class="avatar">${escapeHtml((r.student || '?').slice(0, 1))}</div><div class="result-main"><div class="result-head"><strong>${escapeHtml(r.student || '学生')}</strong><span class="grade ${escapeHtml(r.grade)}">${escapeHtml(r.grade)}</span><span class="result-status">${status}</span></div><p class="comment">${escapeHtml(r.comment)}</p><ul>${issues}</ul></div></article>`; }
function statusText(s) { return ({ queued: '等待执行', opening_browser: '正在打开浏览器', waiting_login: '等待扫码或选店铺', running: '自动批改中', recovering: '正在恢复任务', recovery_needed: '等待恢复', paused: '已暂停', partial: '部分完成', completed: '批改完成', failed: '任务失败' })[s] || '处理中'; }
function eventText(e) { return ({ progress: '进度已更新', created: '任务已创建' })[e] || '任务状态已更新'; }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
