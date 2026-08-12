const transientPatterns = [
  /超时|timeout|加载完成|无法打开|找不到.*按钮|找不到.*编辑器|网络|fetch failed|ECONNRESET|429|5\d\d/i,
  /未进入下一位|未接受点评/i
];

export function classifyFailure(error) {
  const message = String(error?.message || error || '未知错误');
  let category = 'unknown';
  let suggestion = '将返回作业列表并重新读取当前未点评学生，再继续执行。';
  if (/HTTP 401|HTTP 403|鉴权|密钥无效/i.test(message)) {
    category = 'model_auth'; suggestion = '模型服务鉴权失败。请检查机构模型服务的密钥与模型权限后再继续。';
  } else if (/模型服务不可用.*(404|429|5\d\d)|timeout|fetch failed|ECONNRESET|网络/i.test(message)) {
    category = 'model_unavailable'; suggestion = '机构模型上游当前不可用或没有可用路由。系统未提交当前学生；请稍后点击继续，或由管理员修复模型路由后再试。';
  } else if (/学生信息|加载完成|无法打开|找不到.*编辑器|找不到.*按钮|点评入口/i.test(message)) {
    category = 'page_loading'; suggestion = '小鹅通页面加载或结构暂时异常。请保持小鹅通标签页打开，系统将从作业列表重新进入当前学生。';
  } else if (/未进入下一位|未接受点评|提交/i.test(message)) {
    category = 'submit_confirmation'; suggestion = '无法确认本次点评是否已提交。系统会先回到列表核对未点评数量，确认后才继续，避免重复点评。';
  }
  return { category, message, suggestion, retryable: transientPatterns.some(pattern => pattern.test(message)) || category !== 'model_auth' };
}

export async function retry(operation, { attempts = 3, delayMs = 800, onRetry } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index++) {
    try { return await operation(index + 1); }
    catch (error) {
      lastError = error;
      if (index + 1 < attempts) {
        onRetry?.(error, index + 1);
        await new Promise(resolve => setTimeout(resolve, delayMs * (index + 1)));
      }
    }
  }
  throw lastError;
}
