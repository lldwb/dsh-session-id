/**
 * `dsh-session-id`（显示名「会话增强」）—— 会话 ID、会话分享与失败重试的三合一插件。
 *
 * ## 三个组件
 *
 * 1. **会话 ID**（浏览器半）：会话标题栏一个复制按钮，用户拿到 id 后可以贴给任何
 *    Agent；配合 Host 半 `session_lookup` 按 id 查标题、父级链、子代理与最近消息。
 * 2. **会话分享**（浏览器半 + Host 半）：标题栏分享按钮生成免登录只读链接
 *    `/share/<token>`，可复制/打开/下载单文件 HTML/停止分享；页面每次请求现读日志，
 *    撤销即失效。工具 `session_share` 让 Agent 在用户明确要求时也能分享。
 * 3. **重试按钮**（浏览器半 + Host 半）：模型调用失败（自动重试耗尽）或用户点了停止
 *    之后，composer 右下角那个按钮变成圆形「重试」图标 —— 点一下直接重新调用模型，
 *    不追加用户消息、不开新 turn（`lib/retry/`，原 `dsh-turn-retry` 插件并入）。
 *
 * ## 挂载方式
 *
 * `cordis.patch.yml` 在根作用域 insert 一行，**不按 preset 挂载**：复制 id、查会话、
 * 分享会话、失败重试都是 Web 外壳与任何模式的通用能力。
 *
 * ## 依赖的分层
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `tools` | 注册工具 | 硬依赖（模块加载失败） |
 * | `sessionQuery` | 查会话/渲染分享页 | 工具返回说明，分享页 404 |
 * | `webServer` | 公开 `/share` 路由、两条 RPC 通道 | 分享/重试的界面动作不可用，查询不受影响 |
 * | `sessions` | 分享前 flush 实时日志 | 少最后几条，不报错 |
 * | `agents` / `typertGateway` | 重试闸门的"有人能点吗"探测 | fail-closed：不挂起，按原生语义结束 |
 *
 * ## 存储
 *
 * 分享记录写在 `<DSH_HOME>/dsh-session-id/shares.json`，只存
 * `{ sessionId, createdAt, includeDescendants }`——不存会话内容，撤销即彻底失效。
 *
 * @module dsh-session-id
 */

import { buildTools } from './lib/tools.mjs';
import { createShareStore, resolveDshHome, sharesFilePath } from './lib/shares.mjs';
import { mountShareRpc } from './lib/rpc.mjs';
import { mountShareRoutes } from './lib/public.mjs';
import { installTurnRetry } from './lib/retry/host.mjs';

/** Cordis 插件名：同时是 Loader 行 id 与浏览器半 locale 命名空间。 */
export const name = 'dsh-session-id';

/**
 * `tools` 是硬依赖：注册工具是 Host 半存在的理由。
 *
 * 其余服务（sessionQuery / webServer / sessions / agents / typertGateway）都用
 * `ctx.get()` 软取，缺了要能降级——例如只挂 Host 半的部署照样能查会话，只是分享
 * 与重试按钮不可用。
 */
export const inject = ['tools'];

/**
 * 构建戳。行为有可观察变化时递增，便于从日志判断"当前进程跑的是哪版代码"。
 */
export const BUILD = '2026-10-26.2';

/**
 * 安全调用一个可能抛错的值函数。
 *
 * `webServer.getOrigin()` 在端口绑定之前会抛错，`webApp.getAdvertisedUrl()` 在没有
 * 对外地址时也可能抛；这类"暂时拿不到"不应让分享创建失败成异常。
 *
 * @param {() => unknown} read - 读取函数。
 * @returns {unknown} 值或 undefined。
 */
function attempt(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * 注册插件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  /**
   * 取一个可能尚未挂载的 Host 服务。
   *
   * @param {string} key - 服务键。
   * @returns {any} 服务或 undefined。
   */
  const serviceOf = (key) => (typeof ctx?.get === 'function' ? ctx.get(key) : undefined);

  const storeFile = sharesFilePath(resolveDshHome());
  const store = createShareStore({ storeFile });

  const sessionQuery = () => serviceOf('sessionQuery');
  const sessions = () => serviceOf('sessions');

  /**
   * 分享根地址：优先 `webApp.getAdvertisedUrl()`（配置了 `--public-url` 时就是对外
   * 地址），否则用本机监听 origin。都拿不到时返回 null（分享创建会报明确的错误）。
   *
   * @returns {string | null} 根地址或 null。
   */
  const originOf = () => {
    const webApp = serviceOf('webApp');
    const advertised = typeof webApp?.getAdvertisedUrl === 'function' ? attempt(() => webApp.getAdvertisedUrl()) : undefined;
    if (typeof advertised === 'string' && advertised !== '') return advertised;
    const webServer = serviceOf('webServer');
    const origin = typeof webServer?.getOrigin === 'function' ? attempt(() => webServer.getOrigin()) : undefined;
    return typeof origin === 'string' && origin !== '' ? origin : null;
  };

  const definitions = buildTools(ctx, { store, sessionQuery, originOf });
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-session-id: tool ${definition.name}`);
  }

  mountShareRpc(ctx, { store, sessionQuery, sessions, originOf });
  mountShareRoutes(ctx, { store, sessionQuery, sessions, logger: ctx.logger });

  // 重试半：`agent/request-error` 闸门 + 两条会话事件监听 + RPC 通道 `/dsh-turn-retry`。
  installTurnRetry(ctx);

  ctx.logger?.info?.(`dsh-session-id: ready (${definitions.length} tools, build=${BUILD})`);
}
