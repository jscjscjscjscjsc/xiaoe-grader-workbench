window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'xiaoe-grader-workbench') return;
  if (event.data.type === 'ping') window.postMessage({ source: 'xiaoe-grader-extension', type: 'ready' }, window.location.origin);
  if (event.data.type === 'start') chrome.runtime.sendMessage({ type: 'start', task: event.data.task });
});
window.postMessage({ source: 'xiaoe-grader-extension', type: 'ready' }, window.location.origin);
