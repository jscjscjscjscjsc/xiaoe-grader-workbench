const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isXiaoePage = url => /^https:\/\/admin\.xiaoe-tech\.com\/t\//.test(String(url || ''));

async function activeTask() {
  return (await chrome.storage.local.get('activeTask')).activeTask || null;
}

async function sendRun(tabId, task) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'run', task });
      if (response?.ok) return true;
    } catch (error) {
      // The content script can be missing during a full login redirect. The next
      // ready/update event will retry after Chrome injects it again.
    }
    await sleep(500);
  }
  return false;
}

async function dispatchIfReady(tabId, task) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current || !isXiaoePage(current.url)) return false;
  return sendRun(tabId, task);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const task = await activeTask();
  if (!task || task.tabId !== tabId) return;
  if (changeInfo.status === 'complete' || isXiaoePage(tab.url)) await dispatchIfReady(tabId, task);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'content-ready') {
    activeTask().then(task => {
      if (task && sender.tab?.id === task.tabId) dispatchIfReady(sender.tab.id, task);
    });
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === 'task-finished' || message?.type === 'task-failed') {
    activeTask().then(task => {
      if (task?.id === message.taskId) chrome.storage.local.remove('activeTask');
    });
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type !== 'start') return;
  const task = message.task;
  chrome.tabs.create({ url: task.targetUrl }, tab => {
    const storedTask = { ...task, tabId: tab.id };
    chrome.storage.local.set({ activeTask: storedTask }).then(() => dispatchIfReady(tab.id, storedTask));
  });
  sendResponse?.({ ok: true });
  return true;
});
