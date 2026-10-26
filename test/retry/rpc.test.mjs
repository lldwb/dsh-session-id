/**
 * `lib/rpc.mjs` 的单元测试。
 *
 * 重点验证三件事：
 * 1. 信封形状符合 Connection 的硬要求（`ok`/`value` 或 `ok`/`error.details` 是对象）；
 * 2. `retry` / `cancel` 真的会把闸门放行，没在等时返回 `NOT_WAITING` 而不是装作成功；
 * 3. 参数校验（缺 sessionId、未知 endpoint）有稳定错误码。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RetryGate } from '../../lib/retry/gate.mjs';
import { RecoveryStore } from '../../lib/retry/recovery.mjs';
import { RPC_CHANNEL, createRpcHandler } from '../../lib/retry/rpc.mjs';

/**
 * 造一份失败上下文。
 *
 * @param {number} [turn] - turn 号。
 * @returns {object} 失败上下文。
 */
function failureInfo(turn = 1) {
  return {
    turn,
    step: 1,
    provider: 'deepseek',
    failure: { code: 'TRANSPORT', message: 'Connection error.' },
  };
}

/**
 * 断言一个失败信封的结构。
 *
 * @param {object} result - handler 返回值。
 * @param {string} code - 期望错误码。
 */
function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.equal(typeof result.error.details, 'object');
  assert.notEqual(result.error.details, null);
}

test('RPC_CHANNEL 是稳定前缀', () => {
  assert.equal(RPC_CHANNEL, '/dsh-turn-retry');
});

test('pending：没有等待时返回 pending:false', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const handler = createRpcHandler({ gate });
  const result = await handler('pending', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { pending: false, recoverable: null } });
});

test('pending：有等待时返回闸门快照', async () => {
  const gate = new RetryGate({ waitMs: 60_000, now: () => 5_000 });
  gate.open('s1', failureInfo(), undefined);
  const handler = createRpcHandler({ gate });
  const result = await handler('pending', { sessionId: 's1' });

  assert.equal(result.ok, true);
  assert.equal(result.value.pending, true);
  assert.equal(result.value.gate.turn, 1);
  assert.deepEqual(result.value.gate.failure, { code: 'TRANSPORT', message: 'Connection error.' });

  // 收尾，别把 promise 悬着。
  gate.dispose();
});

test('retry：放行闸门并返回 retried', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined);
  const handler = createRpcHandler({ gate });

  const result = await handler('retry', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { retried: true, via: 'gate' } });
  assert.equal(await decision, 'retry');
  assert.equal(gate.get('s1'), undefined);
});

test('retry：没有等待时返回 NOT_WAITING（不假装成功）', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const handler = createRpcHandler({ gate });
  assertFailure(await handler('retry', { sessionId: 's1' }), 'NOT_WAITING');
});

test('cancel：按默认语义放行', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const { decision } = gate.open('s1', failureInfo(), undefined);
  const handler = createRpcHandler({ gate });

  const result = await handler('cancel', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { canceled: true } });
  assert.equal(await decision, 'canceled');
});

test('list：返回所有等待中闸门', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  gate.open('a', failureInfo(), undefined);
  gate.open('b', failureInfo(2), undefined);
  const handler = createRpcHandler({ gate });

  const result = await handler('list', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.gates.length, 2);
  gate.dispose();
});

test('缺 sessionId 返回 BAD_REQUEST', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const handler = createRpcHandler({ gate });
  for (const payload of [undefined, null, 's1', {}, { sessionId: '' }, { sessionId: 42 }]) {
    assertFailure(await handler('pending', payload), 'BAD_REQUEST');
    assertFailure(await handler('retry', payload), 'BAD_REQUEST');
    assertFailure(await handler('cancel', payload), 'BAD_REQUEST');
  }
});

test('未知 endpoint 返回 UNKNOWN_METHOD', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const handler = createRpcHandler({ gate });
  assertFailure(await handler('nope', { sessionId: 's1' }), 'UNKNOWN_METHOD');
});

test('所有返回值都可 JSON 序列化（RPC 层要求）', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const handler = createRpcHandler({ gate });
  gate.open('s1', failureInfo(), undefined);
  for (const method of ['pending', 'list', 'retry', 'cancel', 'nope']) {
    const result = await handler(method, { sessionId: 's1' });
    assert.equal(typeof JSON.stringify(result), 'string');
  }
  gate.dispose();
});

test('停止后重试：pending 报告 recoverable，retry 走 followup 驱动', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const recovery = new RecoveryStore({ now: () => 0 });
  const driven = [];
  const handler = createRpcHandler({
    gate,
    recovery,
    driveRetry: async (sessionId) => {
      driven.push(sessionId);
      return { ok: true };
    },
  });

  recovery.remember('s1', { turn: 2, causeKind: 'user' });

  const pending = await handler('pending', { sessionId: 's1' });
  assert.equal(pending.ok, true);
  assert.equal(pending.value.pending, false);
  assert.equal(pending.value.recoverable.turn, 2);

  const retried = await handler('retry', { sessionId: 's1' });
  assert.deepEqual(retried, { ok: true, value: { retried: true, via: 'followup' } });
  assert.deepEqual(driven, ['s1']);
  // 用掉之后不再可重试。
  assert.equal((await handler('pending', { sessionId: 's1' })).value.recoverable, null);
});

test('停止后重试：followup 失败时返回明确错误码', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const recovery = new RecoveryStore({ now: () => 0 });
  const handler = createRpcHandler({
    gate,
    recovery,
    driveRetry: async () => ({ ok: false, code: 'NO_LIVE_AGENT', message: 'no agent' }),
  });
  recovery.remember('s1', { turn: 1, causeKind: 'user' });
  const result = await handler('retry', { sessionId: 's1' });
  assertFailure(result, 'NO_LIVE_AGENT');
});

test('闸门优先于 recoverable：失败挂起时走原地重试', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const recovery = new RecoveryStore({ now: () => 0 });
  const driven = [];
  const handler = createRpcHandler({
    gate,
    recovery,
    driveRetry: async (sessionId) => {
      driven.push(sessionId);
      return { ok: true };
    },
  });
  const { decision } = gate.open('s1', failureInfo(), undefined);
  recovery.remember('s1', { turn: 1, causeKind: 'user' });

  const result = await handler('retry', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { retried: true, via: 'gate' } });
  assert.equal(await decision, 'retry');
  assert.deepEqual(driven, [], '有闸门时不应该用 followup');
});

test('cancel 在没有闸门时会收起 recoverable 记录', async () => {
  const gate = new RetryGate({ waitMs: 60_000 });
  const recovery = new RecoveryStore({ now: () => 0 });
  const handler = createRpcHandler({ gate, recovery });
  recovery.remember('s1', { turn: 1, causeKind: 'user' });

  const result = await handler('cancel', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { canceled: true } });
  assert.equal((await handler('pending', { sessionId: 's1' })).value.recoverable, null);
});
