const schemaHint = `只返回 JSON，不要 Markdown，不要解释。格式：
{"grade":"优秀|良好|合格|需复核","issues":[{"question":"题号或知识点","problem":"具体可验证的问题","suggestion":"简短修改建议"}],"comment":"给学生的自然中文评语，40-120字，不要AI口吻","requiresReview":false}`;

export async function evaluateSubmission({ rubric, submission, web, model }) {
  const imageUrls = Array.isArray(submission.imageUrls) ? submission.imageUrls.filter(url => /^https?:\/\//i.test(url)).slice(0, 4) : [];
  if (!model.baseUrl || !model.apiKey || !model.model) return fallback(web, imageUrls.length);
  const prompt = [
    '你是网络安全与运维课程的严格助教。只依据给出的学生提交内容评价，不得猜测未展示的实现，不得编造错误。评语要像老师写给学生，具体、有差异化，优先指出实际技术问题；若内容不可访问，说明需要补交公开链接。',
    `批改要求：\n${rubric}`,
    `学生提交摘要：${submission.answer || '无'}`,
    `网页读取状态：${web.status}${web.reason ? `；${web.reason}` : ''}`,
    `网页正文：\n${web.text.slice(0, 8000) || '无可用正文'}`,
    web.code.length ? `代码块：\n${web.code.join('\n\n').slice(0, 6000)}` : '未提取到代码块。',
    imageUrls.length ? `学生另提交了 ${imageUrls.length} 张作业图片。请阅读图片中的文字、代码和运行结果后评价；图片不清晰时必须标为“需复核”，不要猜测。` : '学生没有提交可读取的作业图片。',
    schemaHint
  ].join('\n\n');
  const endpoint = chatCompletionsEndpoint(model.baseUrl);
  const imageInputs = imageUrls.length ? await prepareImageInputs(imageUrls) : [];
  const content = imageInputs.length
    ? [{ type: 'text', text: prompt }, ...imageInputs]
    : prompt;
  let response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify({ model: model.model, temperature: model.temperature, max_tokens: 450, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(45000)
  });
  // 纯文本模型通常会拒绝 image_url。此时不让整批任务失败，也不能伪造图片点评。
  if (!response.ok && imageUrls.length && [400, 415, 422].includes(response.status)) return imageModelUnavailable(response.status);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`模型服务不可用（HTTP ${response.status}）：${providerMessage(body)}`);
  }
  const data = await response.json();
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { throw new Error('模型没有返回有效 JSON，任务已停止。'); }
  return normalize(parsed, web);
}

async function prepareImageInputs(urls) {
  const inputs = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const type = response.headers.get('content-type') || 'image/jpeg';
      const bytes = Buffer.from(await response.arrayBuffer());
      // Keep individual payloads bounded. Large screenshots are resized by the
      // provider internally; oversized originals are skipped rather than blocking a task.
      if (!response.ok || !type.startsWith('image/') || bytes.length === 0 || bytes.length > 4 * 1024 * 1024) continue;
      inputs.push({ type: 'image_url', image_url: { url: `data:${type};base64,${bytes.toString('base64')}`, detail: 'auto' } });
    } catch { /* A single attachment must not make the whole submission unreadable. */ }
  }
  return inputs;
}

export async function checkModelHealth(model, { probe = false } = {}) {
  if (!model?.apiKey || !model?.baseUrl || !model?.model) return { ok: false, code: 'missing_configuration', message: '机构模型服务尚未配置密钥。' };
  if (!probe) return { ok: true, configured: true, message: '机构模型已配置，将在启动任务前验证可用性。' };
  const endpoint = chatCompletionsEndpoint(model.baseUrl);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify({ model: model.model, temperature: 0, max_tokens: 2, messages: [{ role: 'user', content: 'ping' }] }), signal: AbortSignal.timeout(20000)
      });
      if (response.ok) return { ok: true, message: '机构模型服务可用。' };
      return { ok: false, code: `http_${response.status}`, message: `机构模型服务不可用（HTTP ${response.status}）：${providerMessage((await response.text()).slice(0, 500))}` };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
  return { ok: false, code: 'network', message: `无法连接机构模型服务：${lastError?.message || '请求超时'}` };
}

function providerMessage(body) {
  try { return JSON.parse(body)?.error?.message || body || '上游未返回详情'; } catch { return body || '上游未返回详情'; }
}

function chatCompletionsEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/$/, '');
  // Most OpenAI-compatible relays expose /v1. Users may still pass a URL already
  // ending in /v1 or /chat/completions without causing a doubled path.
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return /\/v\d+$/i.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function normalize(value, web) {
  const grade = ['优秀', '良好', '合格', '需复核'].includes(value.grade) ? value.grade : '需复核';
  const issues = Array.isArray(value.issues) ? value.issues.slice(0, 4).map(x => ({ question: String(x.question || '内容'), problem: String(x.problem || '').slice(0, 160), suggestion: String(x.suggestion || '').slice(0, 160) })) : [];
  let comment = String(value.comment || '').replace(/\s+/g, ' ').trim();
  if (!comment) comment = web.status === 'unavailable' ? '提交链接暂时无法查看，请补交可公开访问的博客链接后再检查。' : '已阅读本次提交，请根据题目要求补充关键过程与验证结果。';
  return { grade, issues, comment: comment.slice(0, 300), requiresReview: Boolean(value.requiresReview) || grade === '需复核' || web.status === 'unavailable' };
}

function fallback(web, imageCount = 0) {
  if (imageCount) return imageModelUnavailable();
  if (web.status === 'retry_later') return { grade: '需复核', issues: [{ question: '平台访问', problem: web.reason, suggestion: '系统稍后会重新读取，暂不对学生作业作负面判断。' }], comment: '系统正在重新读取本次公开提交内容，暂不作结论。', requiresReview: true };
  if (web.status === 'unavailable') return { grade: '需复核', issues: [{ question: '提交链接', problem: web.reason, suggestion: '请补交无需登录即可访问的技术博客链接。' }], comment: '提交链接暂时无法查看，请补交可公开访问的博客链接后再检查。', requiresReview: true };
  const short = web.text.replace(/\s/g, '').length < 180;
  return short
    ? { grade: '合格', issues: [{ question: '作业内容', problem: '可读取的正文较少，无法核验完整技术过程。', suggestion: '补充命令、配置、验证结果和问题排查过程。' }], comment: '已看到提交，但正文较少。请补充关键命令、配置结果和验证过程，方便核验。', requiresReview: false }
    : { grade: '良好', issues: [], comment: '已阅读本次提交。建议继续补充关键配置依据、命令输出和故障验证过程，使技术结论更完整。', requiresReview: false };
}

function imageModelUnavailable(status) {
  const problem = status ? `当前模型接口不支持图片识别（HTTP ${status}）。` : '当前未配置支持图片识别的视觉模型。';
  return {
    grade: '需复核',
    issues: [{ question: '图片作业', problem, suggestion: '请使用支持视觉的模型，或补交文字版命令、代码与验证结果。' }],
    comment: '本次仅提交了图片，当前批改模型无法可靠识别图片内容。请补充文字版命令、代码和验证结果后再检查。',
    requiresReview: true
  };
}
