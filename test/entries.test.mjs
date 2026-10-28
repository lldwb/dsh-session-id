/**
 * 三个 Loader 行入口的离线冒烟。
 *
 * 这一层只检查**形状**：每个入口导出 `name` / `inject` / `apply`，且 `apply` 在 mock
 * ctx 上注册了该组件应有的东西。真实 Loader 能否解析子路径 specifier、界面「包含的
 * 组件」显示几行，属于沙箱回归的范围（`devkit_sandbox_compose` / UI 沙箱），
 * `node --test` 看不到。
 *
 * @module dsh-session-id/test/entries
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as copyEntry from '../index.js';
import * as shareEntry from '../share/index.js';
import * as retryEntry from '../retry/index.js';

/**
 * 造一个够用的 mock ctx。
 *
 * @param {Record<string, any>} [services] - `ctx.get()` 能取到的服务。
 * @returns {any} mock 上下文。
 */
function mockCtx(services = {}) {
  const tools = [];
  const effects = [];
  const events = [];
  const injections = [];
  return {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    get(key) {
      return services[key];
    },
    effect(fn, _label) {
      effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(event, handler) {
      events.push({ event, handler });
      return () => {};
    },
    inject(deps, callback) {
      injections.push({ deps, callback });
      return () => {};
    },
    logger: { info() {}, debug() {}, warn() {} },
    // 供断言读取的采集面。
    collected: { tools, effects, events, injections },
  };
}

test('三个入口都导出 name / inject / apply，且 name 与 Loader 行的 specifier 对应', () => {
  assert.equal(copyEntry.name, 'dsh-session-id');
  assert.equal(shareEntry.name, 'dsh-session-id/share');
  assert.equal(retryEntry.name, 'dsh-session-id/retry');

  for (const entry of [copyEntry, shareEntry, retryEntry]) {
    assert.equal(typeof entry.apply, 'function');
    assert.ok(Array.isArray(entry.inject), 'inject 必须是数组');
  }

  // 只有注册工具的两行依赖 tools；重试行不注册工具，不该声明这个硬依赖。
  assert.deepEqual(copyEntry.inject, ['tools']);
  assert.deepEqual(shareEntry.inject, ['tools']);
  assert.deepEqual(retryEntry.inject, []);
});

test('会话 ID 行只注册 session_lookup', () => {
  const ctx = mockCtx();
  copyEntry.apply(ctx);

  const names = ctx.collected.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['session_lookup']);
  assert.match(ctx.collected.tools[0].description, /session ID/);
});

test('分享行只注册 session_share，并挂上两条路由（RPC 前缀 + 公开页）', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-id-entries-'));
  process.env.DSH_HOME = home;
  try {
    const ctx = mockCtx({ sessionQuery: {}, sessions: {} });
    shareEntry.apply(ctx);

    const names = ctx.collected.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['session_share']);

    // 两条路由都包在 `ctx.inject([...], cb)` 里等 webServer / connection 就位。
    const deps = ctx.collected.injections.map((entry) => entry.deps.join(','));
    assert.ok(deps.includes('connection,webServer'), '应声明分享 RPC 通道');
    assert.ok(deps.includes('webServer,sessionQuery'), '应声明公开分享路由');

    // 存储确实建在了 DSH_HOME 下：`list` 能正常返回空列表（目录在首次写入时才建，
    // 所以这里断言的行为面，不是文件是否存在）。
    const listed = await ctx.collected.tools[0].execute({ action: 'list' }, {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.shares, []);
    assert.equal(fs.existsSync(path.join(home, 'dsh-session-id', 'shares.json')), false, '纯查询不该落盘');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('重试行不注册工具，只挂事件与 RPC 通道', () => {
  const ctx = mockCtx();
  retryEntry.apply(ctx);

  assert.deepEqual(ctx.collected.tools, [], '重试组件不该注册模型工具');

  const events = ctx.collected.events.map((entry) => entry.event);
  assert.ok(events.includes('agent/request-error'), '应挂失败闸门');
  assert.ok(events.includes('session/event'), '应观察 turn 结束以记录「停止后重试」');

  const deps = ctx.collected.injections.map((entry) => entry.deps.join(','));
  assert.ok(deps.includes('connection,webServer'), '应声明重试 RPC 通道');
});
