/**
 * 两个工具定义的聚合入口（向后兼容层）。
 *
 * ## 为什么还留着这个文件
 *
 * 1.5 之前两个工具写在同一个文件里，`buildTools()` 一次返回两个。拆成三个 Loader
 * 行之后，真正的构造函数分别住在 `lib/tools/lookup.mjs` 与 `lib/tools/share.mjs`
 * ——每个组件只加载自己那份。这里保留 `buildTools()` 作为聚合门面：离线单测与
 * 「三合一的旧配置」仍然能一次拿到两个工具，行为与 1.x 完全一致。
 *
 * 新代码请直接 import 对应的构建器：
 *
 * ```js
 * import { buildLookupTool } from './lib/tools/lookup.mjs';
 * import { buildShareTool } from './lib/tools/share.mjs';
 * ```
 *
 * @module dsh-session-id/lib/tools
 */

import { buildLookupTool } from './tools/lookup.mjs';
import { buildShareTool } from './tools/share.mjs';

export { buildLookupTool } from './tools/lookup.mjs';
export { buildShareTool } from './tools/share.mjs';
export { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, clampMessageLimit, sessionNode } from './tools/lookup.mjs';
export { arr, enumProp, obj, prop, text } from './tools/schema.mjs';

/**
 * 一次构造两个工具（兼容 1.x 的单入口形态）。
 *
 * @param {any} ctx - Cordis 插件上下文（`session_lookup` 在 `execute` 里现场取服务，
 *   避免抓到旧引用）。
 * @param {{ store?: any, sessionQuery?: () => any, originOf?: () => string | null }} [env] - 分享依赖；
 *   缺省时 `session_share` 会返回结构化的"不可用"而不是抛错。
 * @returns {any[]} 工具定义数组：`[session_lookup, session_share]`。
 */
export function buildTools(ctx, env = {}) {
  return [buildLookupTool(ctx), buildShareTool(env)];
}
