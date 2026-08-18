import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('extension startup survives Xiaoe login and reports failures to the task', async () => {
  const [manifestText, background, content] = await Promise.all([
    read('extension/manifest.json'), read('extension/background.js'), read('extension/xiaoe-content.js')
  ]);
  const manifest = JSON.parse(manifestText);
  const xiaoeMatch = manifest.content_scripts.find(item => item.js.includes('xiaoe-content.js'))?.matches || [];

  assert.ok(xiaoeMatch.includes('https://admin.xiaoe-tech.com/t/*'));
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /message\?\.type === 'content-ready'/);
  assert.match(background, /sendRun\(tabId, task\)/);
  assert.match(content, /\/extension-failed/);
  assert.match(content, /chrome\.runtime\.sendMessage\(\{ type: 'content-ready' \}\)/);
  assert.match(content, /state\.ready && state\.unreviewed !== null/);
});

test('workbench falls back to the independent browser when no extension is connected', async () => {
  const [app, index] = await Promise.all([read('public/app.js'), read('public/index.html')]);
  assert.match(app, /const execution = 'server'/);
  assert.doesNotMatch(app, /execution === 'extension'\) window\.postMessage/);
  assert.match(index, /独立浏览器模式可直接使用/);
});
