/**
 * `index.js`（Host 半）的集成式单元测试。
 *
 * 用一个最小 mock ctx 驱动真实的 `apply()`：事件注册、`ctx.inject` 的 RPC 通道
 * 注册、以及 `agent/request-error` 监听器的返回语义都在这里跑一遍。
 *
 * ## 被测试的核心语义
 *
 * `agent/request-error` 是**每次**模型 attempt 失败都会触发的 waterfall，DSH 自己
 * 的自动重试策略挂在它下游。所以监听器必须：
 *
 * 1. 先调 `next()` 问下游还愿不愿意重试 —— 愿意就直接放行（不打扰用户）；
 * 2. 下游放弃（真正最终失败）才挂住等用户点「重试」；
 * 3. 「放弃」时**不调 next()**，返回 undefined 才能真的结束这一轮（调用 next 会
 *    把决策交回自动重试策略）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installTurnRetry as apply, sessionIdOf, shouldGate } from '../../lib/retry/host.mjs';
import { RPC_CHANNEL } from '../../lib/retry/rpc.mjs';

/**
 * 造一个可用的 mock Agent。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {object} agent。
 */
function makeAgent(sessionId) {
  return { session: { id: sessionId } };
}

/**
 * 造一个 mock Cordis ctx，并捕获注册的监听器与路由。
 *
 * @param {object} [options] - 环境开关。
 * @param {boolean} [options.hasLiveClient] - typertGateway.hasLiveClient 的返回值。
 * @param {object[] | undefined} [options.roots] - agents.roots() 的返回值；undefined 表示不提供该服务。
 * @param {boolean} [options.provideGateway] - 是否提供 typertGateway 服务。
 * @returns {{ ctx: object, handlers: Map<string, Function>, routes: object[], runCleanups: Function }} mock 环境。
 */
function makeCtx(options = {}) {
  const handlers = new Map();
  const routes = [];
  const cleanups = [];

  const services = {
    agents:
      options.roots === undefined
        ? undefined
        : {
            roots: () => options.roots,
          },
    typertGateway:
      options.provideGateway === false
        ? undefined
        : {
            hasLiveClient: () => options.hasLiveClient === true,
          },
    connection: {
      admit: () => ({ peer: {} }),
      rpc: {
        handle: () => {
          throw new Error('rpc.handle fallback should not be used when webServer.register works');
        },
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  };

  const ctx = {
    logger: { info: () => {}, debug: () => {} },
    // Cordis 里服务既可以通过 `ctx.get(name)` 软取，也可以作为属性直取；
    // 两种形态都给上，才和真实 ctx 一致。
    ...services,
    get(name) {
      return services[name];
    },
    on(name, handler) {
      handlers.set(name, handler);
      return () => {};
    },
    inject(_names, callback) {
      // 真实 Cordis 是"服务就绪后回调"；这里同步回调即可，服务都在。
      callback(ctx);
      return () => {};
    },
    effect(factory, _label) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
  };

  return {
    ctx,
    handlers,
    routes,
    /** 跑一遍 effect 清理（模拟插件卸载）。 */
    runCleanups: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/**
 * 造一个 mock HTTP request（`for await` 可读）。
 *
 * @param {object} body - 请求 JSON。
 * @returns {object} 近似 IncomingMessage。
 */
function makeRequest(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    method: 'POST',
    url: `${RPC_CHANNEL}/`,
    on: () => {},
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

/**
 * 造一个 mock HTTP response，收集状态码与 body。
 *
 * @returns {object} 近似 ServerResponse。
 */
function makeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

/**
 * 通过捕获到的 prefix 路由真的发一次 RPC 请求。
 *
 * @param {object[]} routes - 捕获的路由。
 * @param {string} method - endpoint。
 * @param {unknown} payload - payload。
 * @returns {Promise<object>} 服务端 result 信封。
 */
async function callRpc(routes, method, payload) {
  const route = routes.find((item) => item.path === RPC_CHANNEL);
  assert.ok(route, 'RPC prefix route should be registered');
  const req = makeRequest({ type: 'client-request', rpcId: 'r1', method, payload });
  const res = makeResponse();
  await route.handler(req, res);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'r1');
  return parsed.result;
}

/**
 * 造一次失败 payload。
 *
 * @param {object} agent - mock agent。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {object} payload。
 */
function makePayload(agent, signal) {
  const controller = signal === undefined ? new AbortController() : undefined;
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'deepseek',
    failure: { code: 'TRANSPORT', message: 'Connection error.' },
    retryPolicy: undefined,
    signal: signal ?? controller.signal,
  };
}

/**
 * 造一个"下游自动重试策略"的 next。
 *
 * @param {'retry' | 'give-up'} behavior - 下游是否还愿意重试。
 * @returns {{ next: Function, calls: () => number }} next 与调用计数。
 */
function makeNext(behavior) {
  const state = { calls: 0 };
  return {
    next: async () => {
      state.calls += 1;
      return behavior === 'retry' ? { kind: 'retry' } : undefined;
    },
    calls: () => state.calls,
  };
}

test('sessionIdOf 兼容 id / sessionId 两种字段', () => {
  assert.equal(sessionIdOf({ session: { id: 'a' } }), 'a');
  assert.equal(sessionIdOf({ session: { sessionId: 'b' } }), 'b');
  assert.equal(sessionIdOf({ session: {} }), '');
  assert.equal(sessionIdOf(undefined), '');
});

test('shouldGate：无客户端、子代理、已取消、服务缺失都不拦', () => {
  const rootAgent = makeAgent('root');

  const offline = makeCtx({ hasLiveClient: false, roots: [rootAgent] });
  assert.equal(shouldGate(offline.ctx, makePayload(rootAgent)), false);

  const child = makeAgent('child');
  const withChild = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  assert.equal(shouldGate(withChild.ctx, makePayload(child)), false);

  const aborted = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  const controller = new AbortController();
  controller.abort();
  assert.equal(shouldGate(aborted.ctx, makePayload(rootAgent, controller.signal)), false);

  // fail-closed：探测服务缺失时不挂起（headless / 未知部署形态的保护）。
  const noGateway = makeCtx({ hasLiveClient: true, roots: [rootAgent], provideGateway: false });
  assert.equal(shouldGate(noGateway.ctx, makePayload(rootAgent)), false);

  const ok = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  assert.equal(shouldGate(ok.ctx, makePayload(rootAgent)), true);
});

test('apply 注册 agent/request-error 监听器与 RPC 前缀路由', () => {
  const env = makeCtx({ hasLiveClient: true, roots: [] });
  apply(env.ctx);
  assert.equal(typeof env.handlers.get('agent/request-error'), 'function');
  assert.ok(env.routes.some((route) => route.path === RPC_CHANNEL));
});

test('下游自动重试还愿意重试时直接放行，不挂起、不显示按钮', async () => {
  const agent = makeAgent('s0');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('retry');
  const action = await handler(makePayload(agent), downstream.next);

  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(downstream.calls(), 1);
  const list = await callRpc(env.routes, 'list', {});
  assert.deepEqual(list.value.gates, []);
  env.runCleanups();
});

test('自动重试耗尽后挂住，经 RPC retry 返回 { kind: "retry" }', async () => {
  const agent = makeAgent('s1');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent), downstream.next);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '自动重试耗尽后应该挂住等用户点击');

  // 浏览器半查询：确实在等。
  const before = await callRpc(env.routes, 'pending', { sessionId: 's1' });
  assert.equal(before.ok, true);
  assert.equal(before.value.pending, true);
  assert.deepEqual(before.value.gate.failure, { code: 'TRANSPORT', message: 'Connection error.' });

  // 用户点「重试」。
  const retried = await callRpc(env.routes, 'retry', { sessionId: 's1' });
  assert.deepEqual(retried, { ok: true, value: { retried: true, via: 'gate' } });

  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(downstream.calls(), 1, '只问一次下游，重试由我们直接回复 loop');
  env.runCleanups();
});

test('RPC cancel 返回 undefined（不把决策交回自动重试）', async () => {
  const agent = makeAgent('s2');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const canceled = await callRpc(env.routes, 'cancel', { sessionId: 's2' });
  assert.deepEqual(canceled, { ok: true, value: { canceled: true } });

  assert.equal(await pending, undefined);
  assert.equal(downstream.calls(), 1, '放弃之后不能再调用下游（否则自动重试会继续）');
  env.runCleanups();
});

test('signal abort 会让监听器立刻收尾', async () => {
  const agent = makeAgent('s3');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const controller = new AbortController();
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent, controller.signal), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  assert.equal(await pending, undefined);
  env.runCleanups();
});

test('插件卸载（effect 清理）会放行挂起的 turn', async () => {
  const agent = makeAgent('s4');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');
  const pending = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));

  env.runCleanups();
  assert.equal(await pending, undefined);
});

test('不该拦的情况直接 next()，不会打开闸门', async () => {
  const agent = makeAgent('s5');
  const env = makeCtx({ hasLiveClient: false, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('retry');
  assert.deepEqual(await handler(makePayload(agent), downstream.next), { kind: 'retry' });
  assert.equal(downstream.calls(), 1);

  const result = await callRpc(env.routes, 'pending', { sessionId: 's5' });
  assert.deepEqual(result, { ok: true, value: { pending: false, recoverable: null } });
  env.runCleanups();
});

test('同一会话重复失败不会堆积多个闸门（旧的被 superseded）', async () => {
  const agent = makeAgent('s6');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');
  const first = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 旧的已放行（superseded），新的还在等。
  assert.equal(await first, undefined);
  const pending = await callRpc(env.routes, 'pending', { sessionId: 's6' });
  assert.equal(pending.value.pending, true);

  await callRpc(env.routes, 'cancel', { sessionId: 's6' });
  assert.equal(await second, undefined);
  env.runCleanups();
});
