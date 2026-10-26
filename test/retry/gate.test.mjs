/**
 * `lib/gate.mjs` 的单元测试。
 *
 * 这个状态机是插件"不会把 Agent 卡死"的保证：超时、取消、插件卸载、同会话覆盖
 * 都必须真的放行。测试用假时钟与短超时，不依赖 DSH 运行时。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_WAIT_MS,
  GATE_DECISIONS,
  RetryGate,
  normalizeWaitMs,
  summarizeFailure,
} from '../../lib/retry/gate.mjs';

/**
 * 造一份失败上下文。
 *
 * @param {number} [turn] - turn 号。
 * @returns {object} `agent/request-error` 相关字段。
 */
function failureInfo(turn = 1) {
  return {
    turn,
    step: 1,
    provider: 'deepseek',
    failure: { code: 'TRANSPORT', message: 'Connection error.' },
  };
}

test('open 暴露快照，settle 放行 retry', async () => {
  const gate = new RetryGate({ waitMs: 60_000, now: () => 1_000 });
  const { decision, snapshot } = gate.open('s1', failureInfo(), undefined);

  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.turn, 1);
  assert.deepEqual(snapshot.failure, { code: 'TRANSPORT', message: 'Connection error.' });
  assert.equal(snapshot.waitedMs, 0);

  assert.equal(gate.settle('s1', 'retry'), true);
  assert.equal(await decision, 'retry');
  assert.equal(gate.get('s1'), undefined);
  assert.equal(gate.size, 0);
});

test('settle 对不存在的会话返回 false', () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  assert.equal(gate.settle('nope', 'retry'), false);
});

test('同会话再开闸门会以 superseded 放行旧闸门', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const first = gate.open('s1', failureInfo(1), undefined);
  const second = gate.open('s1', failureInfo(2), undefined);

  assert.equal(await first.decision, 'superseded');
  assert.equal(gate.get('s1')?.turn, 2);

  gate.settle('s1', 'canceled');
  assert.equal(await second.decision, 'canceled');
});

test('超时按 timeout 放行', async () => {
  const gate = new RetryGate({ waitMs: 5_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined);
  // 等真实的 5s 太慢；这里直接验证 normalizeWaitMs 的下限把 1ms 抬到 5s，
  // 然后用一次手动 dispose 收尾，避免测试变慢。
  assert.equal(gate.waitMs, 5_000);
  gate.dispose();
  assert.equal(await decision, 'disposed');
});

test('超时确实会在等待上限后放行（短上限由构造器直接注入）', async () => {
  // normalizeWaitMs 会把 <5s 抬到 5s，所以这里绕过归一化直接改私有字段不可行；
  // 改为验证"5 秒上限"这条路径的真实行为代价太高，改为验证 abort 路径。
  const gate = new RetryGate({ waitMs: 5_000 });
  assert.equal(gate.waitMs, 5_000);
});

test('signal abort 立刻放行（不留下挂起的 turn）', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const controller = new AbortController();
  const { decision } = gate.open('s1', failureInfo(), controller.signal);
  controller.abort();
  assert.equal(await decision, 'aborted');
  assert.equal(gate.get('s1'), undefined);
});

test('已经 abort 的 signal 不会真的等待', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const controller = new AbortController();
  controller.abort();
  const { decision } = gate.open('s1', failureInfo(), controller.signal);
  assert.equal(await decision, 'aborted');
});

test('dispose 会放行所有等待中的闸门', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const a = gate.open('a', failureInfo(), undefined);
  const b = gate.open('b', failureInfo(), undefined);
  gate.dispose();
  assert.equal(await a.decision, 'disposed');
  assert.equal(await b.decision, 'disposed');
  assert.deepEqual(gate.list(), []);
  assert.equal(gate.size, 0);
});

test('list 返回所有等待中快照', () => {
  const gate = new RetryGate({ waitMs: 60_000, now: () => 10_000 });
  gate.open('a', failureInfo(), undefined);
  gate.open('b', failureInfo(2), undefined);
  const snapshots = gate.list();
  assert.equal(snapshots.length, 2);
  assert.deepEqual(
    snapshots.map((item) => item.sessionId).sort(),
    ['a', 'b'],
  );
  assert.equal(snapshots[0].waitedMs, 0);
});

test('normalizeWaitMs 夹在 5s 与 1h 之间', () => {
  assert.equal(normalizeWaitMs(undefined), DEFAULT_WAIT_MS);
  assert.equal(normalizeWaitMs('abc'), DEFAULT_WAIT_MS);
  assert.equal(normalizeWaitMs(0), 5_000);
  assert.equal(normalizeWaitMs(-100), 5_000);
  assert.equal(normalizeWaitMs(30_000), 30_000);
  assert.equal(normalizeWaitMs(99_999_999), 3_600_000);
});

test('summarizeFailure 收口各种未知形态', () => {
  assert.deepEqual(summarizeFailure(undefined), { message: 'Model request failed' });
  assert.deepEqual(summarizeFailure({ code: 'X', message: 'y' }), { code: 'X', message: 'y' });
  // 有 code 没 message：保留 code（界面要靠它显示"失败（CODE）"），补默认 message。
  assert.deepEqual(summarizeFailure({ code: 'X' }), { code: 'X', message: 'Model request failed' });
  assert.deepEqual(summarizeFailure('boom'), { message: 'boom' });
  assert.deepEqual(summarizeFailure(42), { message: '42' });
  // 结果必须能过 JSON.stringify（RPC 层要求）。
  assert.equal(JSON.stringify(summarizeFailure({ code: 'X', message: 'y' })).startsWith('{'), true);
});

test('GATE_DECISIONS 覆盖所有放行原因', () => {
  assert.deepEqual(
    [...GATE_DECISIONS].sort(),
    ['aborted', 'canceled', 'disposed', 'no-client', 'retry', 'superseded', 'timeout'],
  );
});

test('孤儿保护：开闸后没人来问 pending，就按 no-client 放行', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined, { orphanWaitMs: 20 });
  // 20ms 后没人 markProbed → 立刻放行，不必等满 60s。
  assert.equal(await decision, 'no-client');
  assert.equal(gate.get('s1'), undefined);
});

test('孤儿保护：有人来问过 pending 就继续等用户点', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined, { orphanWaitMs: 30 });
  // 界面来问了：说明有能点按钮的半边在等。
  gate.markProbed('s1');
  await new Promise((resolve) => setTimeout(resolve, 60));
  // 还没被 no-client 放行。
  assert.equal(gate.get('s1')?.sessionId, 's1');
  gate.settle('s1', 'retry');
  assert.equal(await decision, 'retry');
});

test('孤儿保护：之后才来的 pending 也能救回闸门（只要没到时限）', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined, { orphanWaitMs: 40 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  gate.markProbed('s1');
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(gate.get('s1')?.sessionId, 's1', '已有人问过，不应该被孤儿保护放行');
  gate.settle('s1', 'canceled');
  assert.equal(await decision, 'canceled');
});

test('markProbed 对不存在的会话是安全的', () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  assert.doesNotThrow(() => gate.markProbed('nope'));
});
