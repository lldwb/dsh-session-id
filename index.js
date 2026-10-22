/**
 * `dsh-session-id` —— 会话 ID 的双面插件。
 *
 * ## 它解决的两个痛点
 *
 * 1. **Web GUI 里看不见会话 id。** 会话标题栏右上角的「更多操作」只有
 *    「下载 Session 日志 / 反馈」，用户想引用某个会话（贴给另一个会话里的
 *    Agent）时没有入口。浏览器半在那个位置加一个「复制会话 ID」按钮。
 * 2. **Agent 拿到 id 也读不到那个会话。** 浏览器只负责把 id 交到用户手上，
 *    真正"按 id 找到会话和它的子代理"是 Host 半的 `session_lookup` 工具：
 *    它读 `ctx.sessionQuery` 的血缘追踪、标题快照与当前模型表层，返回一个
 *    人可读的 markdown 摘要 + 结构化字段。
 *
 * ## 挂载方式
 *
 * `cordis.patch.yml` 在根作用域 insert 一行，**不按 preset 挂载**：复制 id 是
 * Web 外壳的通用能力，按 id 查会话也是任何模式都成立的只读查询。
 *
 * ## 边界
 *
 * - 没有设置页、没有 Config 字段、没有 npm 依赖：安装即可用，不需要重启设置。
 * - Host 半只读：不创建、不删除、不修改任何会话。
 * - `sessionQuery` 是软依赖（`ctx.get`）；部署没挂查询服务时工具返回一条
 *   说明，而不是加载失败。
 *
 * @module dsh-session-id
 */

import { buildTools } from './lib/tools.mjs';

/** Cordis 插件名：同时是 Loader 行 id 与浏览器半 locale 命名空间。 */
export const name = 'dsh-session-id';

/**
 * `tools` 是硬依赖：注册工具是 Host 半存在的理由。
 *
 * `sessionQuery` 故意**不**列进 `inject`：它是可选服务，缺了也要能加载
 * （浏览器半完全不需要它）。
 */
export const inject = ['tools'];

/**
 * 构建戳。行为有可观察变化时递增，便于从日志判断"当前进程跑的是哪版代码"。
 */
export const BUILD = '2026-10-22.1';

/**
 * 注册插件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const definitions = buildTools(ctx);

  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-session-id: tool ${definition.name}`);
  }

  ctx.logger?.info?.(`dsh-session-id: ready (${definitions.length} tool, build=${BUILD})`);
}
