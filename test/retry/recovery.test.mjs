/**
 * `lib/recovery.mjs` 的单元测试。
 *
 * 这份记录承载「用户点过停止之后还能不能重试」的判定，最要紧的是两条：
 * 过期之后不能再提供重试；被用掉/被新 turn 覆盖之后也不能再冒出来。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_RECOVERY_TTL_MS, RecoveryStore } from '../../lib/retry/recovery.mjs';

test('remember 之后 peek 能读到，快照字段完整', () => {
  const store = new RecoveryStore({ now: () => 1_000 });
  store.remember('s1', { turn: 3, causeKind: 'user' });

  const snapshot = store.peek('s1');
  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.turn, 3);
  assert.equal(snapshot.causeKind, 'user');
  assert.equal(snapshot.ageMs, 0);
});

test('没记过的会话 peek 返回 undefined', () => {
  const store = new RecoveryStore();
  assert.equal(store.peek('nope'), undefined);
});

test('take 取出并清空（只能用一次）', () => {
  const store = new RecoveryStore({ now: () => 0 });
  store.remember('s1', { turn: 1, causeKind: 'user' });
  assert.notEqual(store.take('s1'), undefined);
  assert.equal(store.peek('s1'), undefined);
  assert.equal(store.take('s1'), undefined);
});

test('forget 清掉记录', () => {
  const store = new RecoveryStore({ now: () => 0 });
  store.remember('s1', { turn: 1, causeKind: 'user' });
  store.forget('s1');
  assert.equal(store.peek('s1'), undefined);
});

test('超过有效期后 peek 不再返回（并顺手清理）', () => {
  let now = 0;
  const store = new RecoveryStore({ ttlMs: 1_000, now: () => now });
  store.remember('s1', { turn: 1, causeKind: 'user' });

  now = 999;
  assert.notEqual(store.peek('s1'), undefined);
  now = 1_001;
  assert.equal(store.peek('s1'), undefined);
  // 再往回走也不该"复活"。
  now = 500;
  assert.equal(store.peek('s1'), undefined);
});

test('同一会话重复 remember 覆盖旧记录', () => {
  const store = new RecoveryStore({ now: () => 0 });
  store.remember('s1', { turn: 1, causeKind: 'user' });
  store.remember('s1', { turn: 2, causeKind: 'user' });
  assert.equal(store.peek('s1').turn, 2);
});

test('clear 清空所有会话', () => {
  const store = new RecoveryStore({ now: () => 0 });
  store.remember('a', { turn: 1, causeKind: 'user' });
  store.remember('b', { turn: 1, causeKind: 'user' });
  store.clear();
  assert.equal(store.peek('a'), undefined);
  assert.equal(store.peek('b'), undefined);
});

test('默认有效期是 30 分钟', () => {
  assert.equal(new RecoveryStore().ttlMs, DEFAULT_RECOVERY_TTL_MS);
  assert.equal(DEFAULT_RECOVERY_TTL_MS, 30 * 60 * 1000);
});
