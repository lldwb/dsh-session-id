/**
 * 浏览器半的 RPC 通道：创建 / 查询 / 撤销分享。
 *
 * ## 为什么手写 channel
 *
 * 第三方插件的浏览器半不能声明 Remote 命名空间（`dsh-api-remotes` 的能力集在构建期
 * 固定），`connection.rpc.call` 是官方逃生口，但要自己注册服务端路由。这里照随附
 * 插件注册"prefix 路由 + connection.admit 认证"的既有模式实现。
 *
 * ## 认证
 *
 * 这个通道**必须认证**：创建分享等于把会话内容交给任何拿到链接的人，绝不能让
 * 本机其它网页 / 局域网上的人凭一个 POST 就做到。所以走 `connection.admit(req)`，
 * 未通过的请求直接写状态码。公开读取走另一条路由（`lib/public.mjs`），它只认
 * 随机 token、不认身份。
 *
 * @module dsh-session-id/lib/rpc
 */

/** 浏览器半调用的通道前缀。 */
export const RPC_CHANNEL = '/dsh-session-id';

/**
 * 成功信封。
 *
 * @param {unknown} value - 返回给浏览器的值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 失败信封。`details` 必须是对象（浏览器端解析器要求）。
 *
 * @param {string} code - 机器可读错误码。
 * @param {string} message - 用户可见文案。
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 读取请求体。
 *
 * @param {any} req - Node 请求。
 * @returns {Promise<string>} UTF-8 文本。
 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 组装一条记录给浏览器的形状（补上 URL）。
 *
 * @param {{ token: string, sessionId: string, createdAt: number, includeDescendants: boolean }} record - 存储记录。
 * @param {() => string | null} originOf - 返回分享根地址（可能为空）。
 * @returns {any} 浏览器可用的分享描述。
 */
export function presentShare(record, originOf) {
  const origin = originOf();
  return {
    token: record.token,
    createdAt: record.createdAt,
    includeDescendants: record.includeDescendants,
    url: origin === null || origin === '' ? '' : `${String(origin).replace(/\/+$/u, '')}/share/${record.token}`,
  };
}

/**
 * 挂载内部 RPC 通道。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {{
 *   store: any,
 *   sessionQuery: () => any,
 *   sessions: () => any,
 *   originOf: () => string | null,
 * }} deps - 依赖。
 * @returns {void}
 */
export function mountShareRpc(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(
      () =>
        rpcCtx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: async (req, res) => {
            /**
             * 写一个 JSON 响应。
             *
             * @param {number} status - HTTP 状态。
             * @param {unknown} payload - JSON 载荷。
             */
            const send = (status, payload) => {
              if (res.headersSent) return;
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(payload));
            };

            let admission;
            try {
              admission = rpcCtx.connection.admit(req);
            } catch (error) {
              send(500, { error: error instanceof Error ? error.message : String(error) });
              return;
            }
            if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
              res.writeHead(/** @type {any} */ (admission).rejection);
              res.end();
              return;
            }
            if (req.method !== 'POST') {
              send(405, { error: 'method not allowed' });
              return;
            }

            let request;
            try {
              request = JSON.parse(await readBody(req));
            } catch {
              send(400, { error: 'invalid JSON body' });
              return;
            }
            if (request === null || typeof request !== 'object' || typeof request.rpcId !== 'string') {
              send(400, { error: 'expected {type,rpcId,method,payload}' });
              return;
            }

            const method = String(request.method ?? '');
            const payload = request.payload !== null && typeof request.payload === 'object' ? request.payload : {};
            /** @type {unknown} */
            let result;

            try {
              result = await dispatch(method, payload);
            } catch (error) {
              result = fail('OPERATION_FAILED', error instanceof Error ? error.message : String(error));
            }
            send(200, { type: 'server-response', rpcId: request.rpcId, result });
          },
        }),
      'dsh-session-id: share rpc channel',
    );
  });

  /**
   * 方法表。
   *
   * @param {string} method - 方法名。
   * @param {Record<string, any>} payload - 参数。
   * @returns {Promise<unknown>} 结果。
   */
  async function dispatch(method, payload) {
    const store = deps.store;
    if (method === 'share.status') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (sessionId === '') return fail('INVALID_REQUEST', '缺少 sessionId');
      const records = store.listForSession(sessionId);
      return ok({ shares: records.map((record) => presentShare(record, deps.originOf)) });
    }

    if (method === 'share.create') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (sessionId === '') return fail('INVALID_REQUEST', '缺少 sessionId');
      // 先确认能拿到分享根地址，再写记录：避免"创建失败但留下孤儿记录"。
      const originRead = deps.originOf();
      if (typeof originRead !== 'string' || originRead === '') {
        return fail('NO_ORIGIN', '无法确定分享地址（web server 尚未就绪）');
      }
      const sessionQuery = deps.sessionQuery();
      if (sessionQuery === undefined || sessionQuery === null) {
        return fail('UNAVAILABLE', '本部署没有会话查询服务，无法分享');
      }
      // 先确认会话真的存在：否则会留下一条永远打不开的分享链接。
      try {
        await sessionQuery.traceSession(sessionId, undefined);
      } catch {
        return fail('SESSION_NOT_FOUND', `找不到会话 ${sessionId}`);
      }
      const record = store.create({ sessionId, includeDescendants: payload.includeDescendants !== false });
      const share = presentShare(record, deps.originOf);
      if (share.url === '') {
        return fail('NO_ORIGIN', '无法确定分享地址（web server 尚未就绪）');
      }
      return ok({ share });
    }

    if (method === 'share.revoke') {
      const token = typeof payload.token === 'string' ? payload.token.trim() : '';
      if (token === '') return fail('INVALID_REQUEST', '缺少 token');
      return ok({ revoked: store.revoke(token) });
    }

    return fail('UNKNOWN_METHOD', `unknown method ${JSON.stringify(method)}`);
  }
}
