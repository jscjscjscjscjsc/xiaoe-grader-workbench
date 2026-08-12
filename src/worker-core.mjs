import { retry } from './recovery.mjs';

// Pure worker used by the production runner and fault-injection tests. The adapter
// controls the browser; this layer makes the retry and exactly-once boundaries testable.
export async function processStudents({ total, read, evaluate, submit, onEvent }) {
  const results = [];
  for (let index = 0; index < total; index++) {
    const student = await retry(() => read(index), { attempts: 3, delayMs: 0, onRetry: error => onEvent?.('retry', { index, error }) });
    const evaluation = await retry(() => evaluate(student), { attempts: 3, delayMs: 0, onRetry: error => onEvent?.('retry', { index, error }) });
    // Submit is intentionally a one-shot operation. An unknown outcome must be
    // reconciled by the caller before a human requests continuation.
    await submit(student, evaluation);
    results.push({ student, evaluation });
    onEvent?.('submitted', { index, student });
  }
  return results;
}
