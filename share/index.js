/**
 * 「会话分享」组件的 Host 半（Loader 行 `dsh-session-id/share`）。
 *
 * ## 它做什么
 *
 * 1. 工具 `session_share`（create / status / revoke / list）：让 Agent 在用户**明确
 *    要求**时也能分享；
 * 2. 免登录只读路由 `GET /share/<token>`：24 字节随机 token、每次请求现读会话日志
 *    （撤销即 404）、严格 CSP、页面不含会话 id / cwd / token / 工具参数；
 * 3. 认证 RPC 通道 `/dsh-session-id`（`connection.admit` 校验）：浏览器半用的
 *    `share.status` / `share.create` / `share.revoke`。
 *
 * ## 存储
 *
 * 分享记录写在 `<DSH_HOME>/dsh-session-id/shares.json`，只存
 * `{ sessionId, createdAt, includeDescendants }`——不存会话内容，撤销即彻底失效。
 *
 * ## 依赖
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `tools` | 注册 `session_share` | 硬依赖（模块加载失败） |
 * | `webServer` | 公开路由 + RPC 通道 | 分享不可用，工具返回结构化失败 |
 * | `sessionQuery` | 渲染分享页、校验会话存在 | 分享页 404、创建失败 |
 * | `sessions` | 分享前 flush 实时日志 | 少最后几条，不报错 |
 *
 * 下面是**同一行里**的三个能力，不是三个组件：组件（Loader 行）的边界是"可以单独
 * 启用/停用"，而这三件事互相依赖（没有 webServer 就没有可分享的链接），拆开只会
 * 制造半残状态。
 *
 * @module dsh-session-id/share
 */

import { BUILD } from '../lib/build.mjs';
import { mountShareRoutes } from '../lib/public.mjs';
import { mountShareRpc } from '../lib/rpc.mjs';
import { createShareStore, resolveDshHome, sharesFilePath } from '../lib/shares.mjs';
import { buildShareTool } from '../lib/tools/share.mjs';

/** Cordis 插件名：与 Loader 行的 `name` 一致。 */
export const name = 'dsh-session-id/share';

/** `tools` 是硬依赖：注册工具是这个组件的存在理由。 */
export const inject = ['tools'];

export { BUILD };

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
 * 注册「会话分享」组件。
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

  const store = createShareStore({ storeFile: sharesFilePath(resolveDshHome()) });
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

  const definition = buildShareTool({ store, sessionQuery, originOf });
  ctx.effect(() => ctx.tools.register(definition), 'dsh-session-id: tool session_share');

  mountShareRpc(ctx, { store, sessionQuery, sessions, originOf });
  mountShareRoutes(ctx, { store, sessionQuery, sessions, logger: ctx.logger });

  ctx.logger?.info?.(`dsh-session-id/share: ready (1 tool, build=${BUILD})`);
}
