/**
 * 浏览器半 ↔ Host 半之间的 RPC 通道。
 *
 * ## 为什么不用官方 `ctx.connection.rpc.handle`
 *
 * DSH 的 Remote 能力集是**构建时导入固定**的，第三方插件无法在构建时注册自己的
 * Remote namespace。唯一可用的是 Connection 的通用 RPC 通道
 * `ctx.connection.rpc.call(channel, endpoint, payload)`；Host 侧注册时如果直接用
 * `connection.rpc.handle(...)`，它内部会访问调用方 fiber 的 `webServer`，而调用方
 * 没有同时 inject 该服务时会抛错，客户端最终拿到的是 **HTTP 405**（请求落到 SPA
 * fallback），非常难排查。所以这里用一个在真实部署上验证过的配方：
 *
 * 1. `ctx.inject(['connection', 'webServer'], …)` 同时拿到两个服务；
 * 2. 自己 `webServer.register({ kind: 'prefix', path })`；
 * 3. 认证复用公开入口 `connection.admit(req)`；
 * 4. 请求/响应信封与官方 carrier 一致：`{ type: 'client-request', rpcId, method,
 *    payload }` → `{ type: 'server-response', rpcId, result }`，其中 `result` 是
 *    `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`
 *    —— **`details` 必须是对象**，否则客户端解析直接抛
 *    `invalid server-response failure`。
 *
 * ## 端点
 *
 * | endpoint  | 作用 |
 * |-----------|------|
 * | `pending` | 查询某会话是否有失败请求正等待用户点击（浏览器半确认状态用） |
 * | `retry`   | 用户点了「重试」：放行闸门，loop 在同一 turn/step 重新调用模型 |
 * | `cancel`  | 用户点了「放弃”：按默认行为结束这一轮 |
 * | `list`    | 诊断：列出所有等待中的闸门 |
 *
 * @module dsh-session-id/lib/retry/rpc
 */

/** 浏览器半调用本插件的 RPC 通道前缀。 */
export const RPC_CHANNEL = '/dsh-turn-retry';

/** 请求体上限：这些端点只传几个 JSON 字段，32 KiB 有富余。 */
export const MAX_RPC_BODY_BYTES = 32 * 1024;

/**
 * 组装一个 `{ ok, value }` 成功结果。
 *
 * @param {unknown} value - 端点返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装一个 `{ ok: false, error }` 失败结果。
 *
 * `details` 必须是对象（Connection 信封的硬要求），所以这里始终给 `{}`。
 *
 * @param {string} code - 稳定的机器可读错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从 RPC payload 里取会话 id。
 *
 * 浏览器半会把 `sessionId` 放在 payload 里；空/null/非字符串一律视为无效，
 * 不做隐式转换（免得把 `undefined` 当成会话名去查）。
 *
 * @param {unknown} payload - RPC payload。
 * @returns {string | undefined} 会话 id。
 */
function readSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {{ sessionId?: unknown }} */ (payload).sessionId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 创建一个 RPC 端点处理函数。
 *
 * 与 HTTP 解耦：`installRpcChannel` 只负责认证、读 body、写信封，真正的动作在
 * 这里，因此可以用普通单测直接驱动。
 *
 * @param {object} options - 依赖。
 * @param {import('./gate.mjs').RetryGate} options.gate - 闸门状态机。
 * @param {import('./recovery.mjs').RecoveryStore} [options.recovery] - 「用户中断、可重试」记录（可省略）。
 * @param {(sessionId: string) => Promise<object>} [options.driveRetry] - 驱动一次新的 turn（可省略）。
 * @param {import('./diagnostics.mjs').Diagnostics} [options.diagnostics] - 失败处理轨迹（可省略）。
 * @param {() => object} [options.probe] - 当前运行时探测快照（可省略）。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createRpcHandler({ gate, recovery, driveRetry, diagnostics, probe }) {
  return async function handle(method, payload) {
    switch (method) {
      case 'pending': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        // 有人来问 = 界面上有一个能点按钮的半边在等。这同时是孤儿保护的依据：
        // 闸门开了一小段时间仍无人问，就说明按钮无人可点，不该继续挂住 turn。
        gate.markProbed?.(sessionId);
        const snapshot = gate.get(sessionId);
        const recoverable = recovery?.peek?.(sessionId);
        if (snapshot !== undefined) return ok({ pending: true, gate: snapshot, recoverable: recoverable ?? null });
        return ok({ pending: false, recoverable: recoverable ?? null });
      }
      case 'retry': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        // 路径 A：模型请求失败、loop 还停在原地 —— 放行闸门即可真正原地重试。
        if (gate.settle(sessionId, 'retry')) {
          diagnostics?.record({ kind: 'user-retry', sessionId, via: 'gate' });
          return ok({ retried: true, via: 'gate' });
        }
        // 路径 B：用户点过停止，这一轮已经结束 —— 只能驱动一次新的 turn。
        const recoveryEntry = recovery?.take?.(sessionId);
        if (recoveryEntry !== undefined) {
          if (typeof driveRetry !== 'function') {
            return fail('NOT_AVAILABLE', 'Driving a new turn is not available in this Host.');
          }
          const outcome = await driveRetry(sessionId);
          diagnostics?.record({ kind: 'user-retry', sessionId, via: 'followup', outcome: outcome?.ok === true });
          if (outcome?.ok === true) return ok({ retried: true, via: 'followup' });
          return fail(outcome?.code ?? 'RETRY_FAILED', outcome?.message ?? 'Could not drive a new turn.');
        }
        // 路径 C：闸门已经不在了（120 秒等待上限超时、Host 重启、或界面状态比 Host
        // 慢一拍），但用户还是点了按钮 —— **不要假装什么都没发生**。
        //
        // 按钮只会在"失败挂起"或"停止后可重试"两种状态出现，这两种状态下这一轮
        // 都已经结束（或即将结束），所以用 `agent.followup()` 驱动一次新的 turn 是
        // 唯一还能"真的重试"的路径。代价是历史里多一条本插件签名的中性消息，
        // 与"停止后重试"的代价完全一致。
        //
        // 没有 `driveRetry`（例如只有 Host 半的最小部署）时保持原语义：NOT_WAITING。
        if (typeof driveRetry === 'function') {
          const outcome = await driveRetry(sessionId);
          diagnostics?.record({
            kind: 'user-retry',
            sessionId,
            via: 'fallback',
            outcome: outcome?.ok === true,
          });
          if (outcome?.ok === true) return ok({ retried: true, via: 'followup' });
          return fail(outcome?.code ?? 'RETRY_FAILED', outcome?.message ?? 'Could not drive a new turn.');
        }
        return fail(
          'NOT_WAITING',
          'Nothing is waiting for a retry in this session (it may have timed out or already resumed).',
        );
      }
      case 'cancel': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const settled = gate.settle(sessionId, 'canceled');
        if (settled) {
          diagnostics?.record({ kind: 'user-cancel', sessionId });
          return ok({ canceled: true });
        }
        // 没有闸门时，「放弃」= 收起那条「已停止、可重试」的记录。
        const hadRecovery = recovery?.peek?.(sessionId) !== undefined;
        recovery?.forget?.(sessionId);
        if (!hadRecovery) return fail('NOT_WAITING', 'Nothing is waiting in this session.');
        diagnostics?.record({ kind: 'user-dismiss', sessionId });
        return ok({ canceled: true });
      }
      case 'list': {
        return ok({ gates: gate.list() });
      }
      case 'diag': {
        // 诊断端点：回答"刚才那次失败为什么没出现按钮"。
        // 返回运行时探测快照 + 最近的失败处理轨迹 + 当前等待中的闸门。
        return ok({
          probe: typeof probe === 'function' ? safeProbe(probe) : null,
          recent: diagnostics ? diagnostics.list() : [],
          gates: gate.list(),
          waitMs: gate.waitMs,
        });
      }
      default: {
        return fail('UNKNOWN_METHOD', `Unknown endpoint "${String(method)}"`);
      }
    }
  };
}

/**
 * 调一次探测，任何异常都收成可序列化的字符串（诊断端点不能自己抛）。
 *
 * @param {() => object} probe - 探测函数。
 * @returns {object} 快照。
 */
function safeProbe(probe) {
  try {
    const value = probe();
    return value !== null && typeof value === 'object' ? value : { value: String(value) };
  } catch (error) {
    return { probeError: String(error?.message ?? error) };
  }
}

/**
 * 在 Host 的 web server 上注册本插件的 RPC 前缀路由。
 *
 * 喜好的路径是自建 prefix 路由；如果该部署的 `webServer` 形状不兼容，退回
 * `connection.rpc.handle`（见模块注释里 405 的成因）。
 *
 * @param {object} ctx - Cordis 上下文（插件 scope）。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installRpcChannel(ctx, handler) {
  ctx.inject?.(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const connection = rpcCtx.connection;
      const webServer = rpcCtx.webServer;
      if (connection === undefined || webServer === undefined) return () => {};

      // 读 body 的小工具：Node 的 req 是 AsyncIterable<Buffer>。
      const readBody = async (req) => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_RPC_BODY_BYTES) return undefined;
          chunks.push(buffer);
        }
        return Buffer.concat(chunks);
      };

      try {
        return webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: async (req, res) => {
            let admission;
            try {
              admission = connection.admit(req);
            } catch {
              res.writeHead(500);
              res.end('admission failed');
              return;
            }
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end('rejected');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            let body;
            try {
              body = await readBody(req);
            } catch {
              res.writeHead(400);
              res.end('body unreadable');
              return;
            }
            if (body === undefined) {
              res.writeHead(413);
              res.end('body too large');
              return;
            }
            let request;
            try {
              request = JSON.parse(body.toString('utf8'));
            } catch {
              res.writeHead(400);
              res.end('body is not JSON');
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const endpoint = url.pathname.startsWith(`${RPC_CHANNEL}/`)
              ? url.pathname.slice(RPC_CHANNEL.length + 1)
              : '';
            let result;
            try {
              result = await handler(String(request?.method ?? endpoint), request?.payload);
            } catch (error) {
              result = fail('INTERNAL', String(error?.message ?? error));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', rpcId: request?.rpcId, result }));
          },
        });
      } catch {
        // 退回官方通道；若它也不可用，插件其余部分仍然工作（只是没有按钮）。
        try {
          return connection.rpc.handle(RPC_CHANNEL, async (method, payload) => handler(method, payload));
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-id: retry rpc channel');
  });
}
