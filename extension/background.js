chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'start') return;
  const task = message.task;
  chrome.storage.local.set({ activeTask: task });
  chrome.tabs.create({ url: task.targetUrl }, tab => {
    const timer = setInterval(async () => {
      try {
        const current = await chrome.tabs.get(tab.id);
        if (current.status === 'complete') {
          clearInterval(timer);
          chrome.tabs.sendMessage(tab.id, { type: 'run', task });
        }
      } catch { clearInterval(timer); }
    }, 500);
  });
  sendResponse?.({ ok: true });
  return true;
});
