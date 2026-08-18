let running = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'run' || running) return;
  running = true;
  const task = message.task;
  run(task).then(() => chrome.runtime.sendMessage({ type: 'task-finished', taskId: task.id }))
    .catch(async error => {
      console.error('[xiaoe-grader]', error);
      try { await api(task, `/api/tasks/${task.id}/extension-failed`, { error: error?.message || String(error) }); } catch (reportError) { console.error('[xiaoe-grader] failure report', reportError); }
      chrome.runtime.sendMessage({ type: 'task-failed', taskId: task.id });
    })
    .finally(() => { running = false; });
  sendResponse?.({ ok: true });
});

chrome.runtime.sendMessage({ type: 'content-ready' });

async function run(task) {
  await waitFor(() => document.body?.innerText?.length > 200, 30000);
  await waitForCommitPage(task.targetUrl, 5 * 60 * 1000);
  let state = readCommitState();
  await api(task, `/api/tasks/${task.id}/initialize`, { assignment: state.assignment, unreviewed: state.unreviewed });
  const deferred = new Set();
  while (state.unreviewed > 0) {
    await selectUnreviewed();
    const action = findReviewAction(deferred);
    if (!action) break;
    action.click();
    const review = await waitForReviewReady(30000);
    let result;
    try {
      result = await api(task, `/api/tasks/${task.id}/evaluate`, { submission: review });
    } catch (error) {
      deferred.add(review.answerId);
      await goTo(task.targetUrl);
      continue;
    }
    const confirmed = await submitReview(result.result.comment, review, state.unreviewed);
    if (!confirmed) { deferred.add(review.answerId); await goTo(task.targetUrl); continue; }
    await api(task, `/api/tasks/${task.id}/record`, { result: result.result });
    if (!location.href.includes('/commit_detail')) await goTo(task.targetUrl);
    state = readCommitState();
  }
  if (location.href.includes('/exercise_check')) await goTo(task.targetUrl);
  state = readCommitState();
  await api(task, `/api/tasks/${task.id}/finish`, { unreviewed: state.unreviewed || deferred.size });
}

function readCommitState() {
  const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const tabs = lines.filter(s => /^(全部|未点评|已点评)\(\d+\)$/.test(s));
  const raw = lines.find(s => /^未点评\(\d+\)$/.test(s));
  const actionCount = Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(el => {
    const r = el.getBoundingClientRect(); return (el.innerText || el.textContent || '').trim() === '点评作业' && r.width > 0 && r.height > 0;
  }).length;
  return { ready: tabs.length >= 2, assignment: (lines.find(s => s.startsWith('作业本：')) || '').replace('作业本：', '').trim(), unreviewed: raw ? Number(raw.match(/\d+/)?.[0] || 0) : null, actionCount };
}
async function waitForCommitPage(target, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = readCommitState();
    if (location.href.includes('/exercise/commit_detail') && state.ready && state.unreviewed !== null && (state.unreviewed === 0 || state.actionCount > 0)) return;
    if (!/chooseShop|LoginCard|login_wechat/.test(location.href)) await goTo(target);
    await delay(1000);
  }
  throw new Error('等待小鹅通登录或作业页超时。');
}
async function selectUnreviewed() {
  const tab = Array.from(document.querySelectorAll('.ss-tabs-v2__item')).find(el => (el.textContent || '').trim().startsWith('未点评('));
  if (tab && !String(tab.className).includes('is-active')) tab.click();
  await waitFor(() => findReviewAction(), 10000);
}
function findReviewAction(excluded = new Set()) {
  return Array.from(document.querySelectorAll('a,button,[role="button"]')).find(el => {
    const r = el.getBoundingClientRect(); const href = el.getAttribute('href') || '';
    return (el.innerText || el.textContent || '').trim() === '点评作业' && r.width > 0 && r.height > 0 && ![...excluded].some(id => href.includes(`exercise_answer_id=${id}`));
  });
}
async function waitForReviewReady(timeout) {
  await waitFor(() => location.href.includes('/exercise_check'), timeout);
  await waitFor(() => readReviewState().student && readReviewState().editor, timeout);
  return readReviewState();
}
function readReviewState() {
  const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const i = lines.findIndex(s => s === '学员：' || s.startsWith('学员：'));
  const answer = lines.findIndex(s => s === '回答'); const teacher = lines.findIndex((s, n) => n > answer && s === '老师点评');
  const vm = document.querySelector('.edit-main')?.__vue__; const detail = vm?.answer_detail || {};
  const materialInfos = Array.isArray(detail.material_infos) ? detail.material_infos : [];
  return {
    student: (i < 0 ? '' : lines[i] === '学员：' ? lines[i + 1] : lines[i].replace('学员：', '').trim()) || detail.nick_name || detail.wx_nickname || '',
    answer: answer < 0 ? String(detail.answer_content || '') : lines.slice(answer + 1, teacher > answer ? teacher : answer + 10).join(' ').trim(),
    answerId: new URLSearchParams(location.hash.split('?')[1] || '').get('exercise_answer_id') || detail.exercise_answer_id || '',
    imageUrls: materialInfos.filter(item => Number(item.type) === 1 && item.url).map(item => item.url),
    editor: Array.from(document.querySelectorAll('iframe')).find(frame => { const r = frame.getBoundingClientRect(); return r.width > 100 && r.height > 50 && frame.contentDocument?.body; })
  };
}
async function submitReview(comment, previous, before) {
  const review = readReviewState(); const frame = review.editor;
  if (!frame) return false;
  const html = `<p>${escapeHtml(comment)}</p>`;
  frame.contentDocument.body.innerHTML = html;
  frame.contentDocument.body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: comment }));
  const vm = document.querySelector('.edit-main')?.__vue__;
  if (!vm) return false;
  vm.review_content = html; if (vm.$set) vm.$set(vm, 'review_content', html);
  try { Object.values(window.UE?.instants || {}).at(-1)?.setContent(html); } catch {}
  const button = Array.from(document.querySelectorAll('button')).find(el => (el.innerText || '').trim() === '点评并继续');
  if (!button) return false;
  button.click();
  try { await waitFor(() => location.href.includes('/commit_detail') || readReviewState().answerId !== previous.answerId, 15000); return true; } catch { return false; }
}
async function goTo(url) { location.href = url; await waitFor(() => location.href.includes('/commit_detail'), 20000); }
async function api(task, path, body) { const response = await fetch(task.workspaceUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '工作台请求失败'); return data; }
async function waitFor(predicate, timeout) { const start = Date.now(); while (Date.now() - start < timeout) { if (predicate()) return true; await delay(350); } throw new Error('页面加载超时'); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHtml = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
