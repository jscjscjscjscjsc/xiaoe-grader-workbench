const MAX_TEXT = 24000;
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
};

export async function readSubmissionPage(answer) {
  const url = extractUrl(answer);
  if (!url) return { source: 'submission_text', url: null, status: 'ok', text: String(answer || '').slice(0, MAX_TEXT), code: [] };
  if (/mp\.csdn\.net\/mp_blog\/creation\/editor|\/admin\b|\/login\b/i.test(url)) return unavailable(url, '学生提交的是需要权限的编辑或后台链接。');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { ...headers, Referer: attempt ? 'https://blog.csdn.net/' : undefined }, redirect: 'follow', signal: AbortSignal.timeout(18000) });
      if (!response.ok) {
        last = `网页访问失败（HTTP ${response.status}）。`;
        if (isTemporary(response.status)) { await delay(700 * (attempt + 1)); continue; }
        return unavailable(url, last);
      }
      const html = await response.text();
      const content = extractContent(html);
      if (!content.text.trim()) return unavailable(url, '网页未提取到可评价的文字内容。');
      return { source: 'public_webpage', url: response.url, status: 'ok', ...content };
    } catch (error) { last = `网页无法访问：${error.message}`; await delay(700 * (attempt + 1)); }
  }
  return { source: 'temporary_unavailable', url, status: 'retry_later', reason: `${last || '网页暂时不可用'}，已自动重试 3 次。`, text: '', code: [] };
}

function extractUrl(value) {
  const found = String(value || '').match(/https?:\/\/[^\s\]）)]+/i);
  return found ? found[0].replace(/[，。；,.]+$/, '') : null;
}

function unavailable(url, reason) { return { source: 'unavailable', url, status: 'unavailable', reason, text: '', code: [] }; }
function isTemporary(status) { return status === 408 || status === 425 || status === 429 || status === 521 || status >= 500; }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function extractContent(html) {
  const selected = html.match(/<div[^>]+id=["']content_views["'][\s\S]*?<\/div>\s*<div/i)?.[0] || html;
  const code = [...selected.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => decode(stripTags(m[1])).trim()).filter(Boolean).slice(0, 20);
  const text = decode(stripTags(selected)).replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  return { text, code };
}

function stripTags(html) { return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/h[1-6]>|<\/li>|<\/pre>/gi, '\n').replace(/<[^>]+>/g, ' '); }
function decode(value) { return value.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'); }
