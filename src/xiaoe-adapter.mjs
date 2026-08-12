import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CDP, evaluate, pageFn, sleep } from './cdp.mjs';

const CDP_PORT = Number(process.env.XIAOE_CDP_PORT || 9223);
const profile = join(homedir(), '.xiaoe-grader', 'chrome-profile');
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
].filter(Boolean);

export class XiaoeAdapter {
  constructor(cdp, targetUrl, notify) { this.cdp = cdp; this.targetUrl = targetUrl; this.notify = notify; }
  static async open(url, notify) {
    let page = await findExercisePage();
    if (!page) {
      const chrome = chromeCandidates.find(existsSync);
      if (!chrome) throw new Error('未找到 Chrome。请安装 Chrome 或设置 CHROME_PATH。');
      spawn(chrome, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--new-window', url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      for (let i = 0; i < 30 && !page; i++) { await sleep(500); page = await findExercisePage(); }
      if (!page) throw new Error('浏览器启动失败，未检测到调试端口。');
    }
    const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    const adapter = new XiaoeAdapter(cdp, url, notify);
    const href = await evaluate(cdp, 'location.href');
    // 新任务必须从用户提供的提交列表开始。不能把上次失败遗留的 exercise_check
    // 误当成任务入口，否则会使统计与首位学生失去一致性。
    if (!isTargetCommitDetail(href, url)) await cdp.send('Page.navigate', { url });
    return adapter;
  }
  close() { this.cdp.close(); }
  async waitUntilReady(timeoutMs) {
    const started = Date.now();
    let lastStage = '';
    let lastRedirectAt = 0;
    while (Date.now() - started < timeoutMs) {
      const state = await this.getCommitState().catch(() => null);
      if (state?.tabs?.length && state.unreviewed !== null) return state;
      const location = await this.getLocationState().catch(() => ({ stage: 'loading' }));
      if (location.stage !== lastStage) {
        lastStage = location.stage;
        if (location.stage === 'login') this.notify?.('login_required', { message: '请在打开的浏览器中扫码登录小鹅通。' });
        if (location.stage === 'choose_shop') this.notify?.('choose_shop', { message: '登录成功。请在小鹅通窗口选择需要批改作业所在的店铺，系统会自动进入原作业。' });
        if (location.stage === 'admin_ready') this.notify?.('returning_assignment', { message: '已识别到店铺登录状态，正在自动返回你填写的作业批改页。' });
      }
      // 小鹅通登录会丢失 hash 深链接并进入店铺/后台首页。店铺选择完成后，
      // 使用老师最初输入的 URL 重新导航，避免要求老师手动寻找作业。
      if (location.stage === 'admin_ready' && Date.now() - lastRedirectAt > 2500) {
        lastRedirectAt = Date.now();
        await this.navigateToAssignment();
      }
      await sleep(1000);
    }
    throw new Error('等待进入作业页超时。请确认已扫码，并在店铺列表中选择了正确店铺。');
  }
  async getLocationState() {
    return evaluate(this.cdp, pageFn(() => {
      const href = location.href;
      const text = document.body?.innerText || '';
      if (/chooseShop|选择店铺|店铺列表/i.test(`${href}\n${text}`)) return { stage: 'choose_shop', href };
      if (/LoginCard|login_wechat|扫码登录|微信登录/i.test(`${href}\n${text}`)) return { stage: 'login', href };
      if (href.includes('/exercise/commit_detail') || href.includes('/exercise_check')) return { stage: 'assignment', href };
      if (href.includes('admin.xiaoe-tech.com/t/')) return { stage: 'admin_ready', href };
      return { stage: 'loading', href };
    }));
  }
  async navigateToAssignment() {
    await this.cdp.send('Page.navigate', { url: this.targetUrl });
  }
  async getAnyState() {
    const href = await evaluate(this.cdp, 'location.href');
    return href.includes('/exercise_check') ? { kind: 'review', ...(await this.getReviewState()) } : { kind: 'commit', ...(await this.getCommitState()) };
  }
  async getCommitState() {
    return evaluate(this.cdp, pageFn(() => {
      const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      const tabs = lines.filter(s => /^(全部|未点评|已点评)\(\d+\)$/.test(s));
      const item = tabs.find(s => s.startsWith('未点评'));
      const actions = Array.from(document.querySelectorAll('*')).filter(el => {
        const rect = el.getBoundingClientRect();
        return (el.innerText || el.textContent || '').trim() === '点评作业' && rect.width > 0 && rect.height > 0;
      });
      const assignment = (lines.find(s => s.startsWith('作业本：')) || '').replace('作业本：', '').trim();
      return { href: location.href, assignment, tabs, unreviewed: item ? Number(item.match(/\((\d+)\)/)?.[1]) : null, actionCount: actions.length };
    }));
  }
  async ensureUnreviewedTab(timeoutMs = 10000) {
    const state = await this.getCommitState();
    if (!state.unreviewed) return state;
    const selected = await evaluate(this.cdp, pageFn(() => {
      const tabs = Array.from(document.querySelectorAll('.ss-tabs-v2__item'));
      const tab = tabs.find(el => (el.textContent || '').trim().startsWith('未点评('));
      if (!tab) return { ok: false, reason: '未找到未点评标签' };
      const rect = tab.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: '未点评标签不可见' };
      const active = String(tab.className || '').includes('is-active');
      if (!active) tab.click();
      return { ok: true, active };
    }));
    if (!selected.ok) throw new Error(selected.reason);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ready = await evaluate(this.cdp, pageFn(() => {
        const actions = Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(el => {
          const r = el.getBoundingClientRect();
          return (el.innerText || el.textContent || '').trim() === '点评作业' && r.width > 0 && r.height > 0;
        });
        return { count: actions.length, hasEmpty: /暂无|没有.*数据/.test(document.body.innerText || '') };
      }));
      if (ready.count || ready.hasEmpty) return this.getCommitState();
      await sleep(300);
    }
    throw new Error('已切换到未点评列表，但点评入口未加载完成。');
  }
  async openFirstReview(excludedAnswerIds = []) {
    await this.ensureUnreviewedTab();
    const opened = await evaluate(this.cdp, pageFn(excluded => {
      const action = Array.from(document.querySelectorAll('*')).map(el => ({ el, text: (el.innerText || el.textContent || '').trim(), rect: el.getBoundingClientRect() }))
        .filter(o => o.text === '点评作业' && o.rect.width > 0 && o.rect.height > 0)
        .filter(o => !excluded.some(id => (o.el.getAttribute('href') || '').includes(`exercise_answer_id=${id}`)))
        .sort((a, b) => a.rect.top - b.rect.top)[0];
      if (!action) return { ok: false, reason: '没有可处理的未点评学生' };
      action.el.scrollIntoView({ block: 'center' }); action.el.click(); return true;
    }, excludedAnswerIds));
    if (!opened || opened.ok === false) throw new Error(opened?.reason || '没有找到可点击的“点评作业”。');
  }
  async waitForReviewPage(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await evaluate(this.cdp, 'location.href')).includes('/exercise_check')) {
        const state = await this.getReviewState();
        // URL 先变化，Vue 的作业详情随后才异步渲染；不能只凭 URL 判定页面可用。
        if (state.student && state.editorReady) return state;
      }
      await sleep(400);
    }
    throw new Error('点评页已打开，但学生信息或点评编辑器未在规定时间内加载完成。');
  }
  async getReviewState() {
    return evaluate(this.cdp, pageFn(() => {
      const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      const studentIndex = lines.findIndex(s => s === '学员：' || s.startsWith('学员：'));
      const answerIndex = lines.findIndex(s => s === '回答');
      const teacherIndex = lines.findIndex((s, i) => i > answerIndex && s === '老师点评');
      const vm = document.querySelector('.edit-main')?.__vue__;
      const detail = vm?.answer_detail || {};
      const domStudent = studentIndex < 0 ? '' : (lines[studentIndex] === '学员：' ? lines[studentIndex + 1] : lines[studentIndex].replace('学员：', '').trim());
      const materials = Array.isArray(detail.material_infos) ? detail.material_infos
        .filter(item => item?.url)
        .map(item => ({ type: Number(item.type), url: String(item.url) })) : [];
      const imageUrls = materials.filter(item => item.type === 1).map(item => item.url);
      return {
        href: location.href,
        answerId: new URLSearchParams(location.hash.split('?')[1] || '').get('exercise_answer_id') || detail.exercise_answer_id || null,
        student: domStudent || detail.nick_name || detail.wx_nickname || null,
        answer: answerIndex < 0 ? String(detail.answer_content || '') : lines.slice(answerIndex + 1, teacherIndex > answerIndex ? teacherIndex : answerIndex + 10).join(' ').trim(),
        imageUrls,
        materialCount: materials.length,
        editorReady: Array.from(document.querySelectorAll('iframe')).some(frame => { const rect = frame.getBoundingClientRect(); return rect.width > 100 && rect.height > 50 && Boolean(frame.contentDocument?.body); })
      };
    }));
  }
  async submitReview(comment, previous, unreviewedBefore = null) {
    const filled = await evaluate(this.cdp, pageFn(text => {
      const escape = value => value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const html = `<p>${escape(text)}</p>`;
      const frame = Array.from(document.querySelectorAll('iframe')).find(f => { const r = f.getBoundingClientRect(); return r.width > 100 && r.height > 50; });
      if (!frame?.contentDocument?.body) return { ok: false, reason: '找不到点评编辑器' };
      frame.contentDocument.body.innerHTML = html;
      frame.contentDocument.body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      const root = document.querySelector('.edit-main') || document.querySelector('#evaluation-wrapper');
      const vm = root?.__vue__;
      if (!vm) return { ok: false, reason: '无法同步小鹅通点评状态' };
      vm.review_content = html; if (vm.$set) vm.$set(vm, 'review_content', html);
      try { Object.values(window.UE?.instants || {}).at(-1)?.setContent(html); } catch {}
      const button = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === '点评并继续');
      if (!button) return { ok: false, reason: '找不到点评并继续按钮' };
      button.click(); return { ok: true };
    }, comment));
    if (!filled.ok) throw new Error(filled.reason);
    const started = Date.now();
    while (Date.now() - started < 15000) {
      await sleep(600);
      const href = await evaluate(this.cdp, 'location.href');
      if (href.includes('/commit_detail')) return { confirmed: true, source: 'returned_to_list' };
      const current = await this.getReviewState();
      if (current.answerId && current.answerId !== previous.answerId) return { confirmed: true, source: 'next_student' };
      const body = await evaluate(this.cdp, 'document.body.innerText || ""');
      if (/不能为空|请输入.*点评/.test(body)) throw new Error('小鹅通未接受点评内容。');
    }
    // Do not click a second time. Reload the commit list and compare the server-side
    // unreviewed count before deciding whether the first click actually succeeded.
    await this.navigateToAssignment();
    const recovered = await this.waitUntilReady(20000).catch(() => null);
    if (recovered && unreviewedBefore !== null && recovered.unreviewed < unreviewedBefore) return { confirmed: true, source: 'count_recovered' };
    throw new Error('提交后未确认是否进入下一位，列表计数也未减少；未重复点击，等待恢复后重试当前学生。');
  }
}

async function findExercisePage() {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return pages.find(p => p.type === 'page' && p.url?.includes('/t/exam/exercise')) || pages.find(p => p.type === 'page');
  } catch { return null; }
}

function isTargetCommitDetail(current, target) {
  const identity = value => ({
    book: value.match(/exercise_book_id=([^&]+)/)?.[1],
    exercise: value.match(/exercise_id=([^&]+)/)?.[1]
  });
  const here = identity(current);
  const expected = identity(target);
  return current.includes('/exercise/commit_detail') && here.book && here.book === expected.book && here.exercise === expected.exercise;
}

export { sleep };
