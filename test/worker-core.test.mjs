import test from 'node:test';
import assert from 'node:assert/strict';
import { processStudents } from '../src/worker-core.mjs';

test('fault injection: 42 students finish when reads and models fail transiently', async () => {
  const readCalls = Array(42).fill(0);
  const modelCalls = Array(42).fill(0);
  const submitted = [];
  const output = await processStudents({
    total: 42,
    read: async index => { readCalls[index]++; if (index % 7 === 0 && readCalls[index] < 3) throw new Error('页面加载超时'); return { id: index }; },
    evaluate: async student => { modelCalls[student.id]++; if (student.id % 5 === 0 && modelCalls[student.id] < 2) throw new Error('模型 HTTP 503'); return { comment: `评语-${student.id}` }; },
    submit: async (student, evaluation) => { submitted.push([student.id, evaluation.comment]); }
  });
  assert.equal(output.length, 42);
  assert.equal(submitted.length, 42);
  assert.equal(new Set(submitted.map(row => row[0])).size, 42);
  assert.equal(readCalls[0], 3);
  assert.equal(modelCalls[0], 2);
});

test('fault injection: ambiguous submit stops without a duplicate click', async () => {
  let submits = 0;
  await assert.rejects(() => processStudents({
    total: 2,
    read: async index => ({ id: index }),
    evaluate: async () => ({ comment: '评语' }),
    submit: async () => { submits++; throw new Error('提交结果未知'); }
  }), /提交结果未知/);
  assert.equal(submits, 1);
});

test('a controlled test stop is not treated as a completed batch', async () => {
  let submitted = 0;
  const stop = new Error('controlled test stop');
  await assert.rejects(() => processStudents({
    total: 3,
    read: async index => ({ id: index }),
    evaluate: async () => ({ comment: '评语' }),
    submit: async () => { submitted++; throw stop; }
  }), /controlled test stop/);
  assert.equal(submitted, 1);
});
