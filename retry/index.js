/**
 * 「失败重试」组件的 Host 半（Loader 行 `dsh-session-id/retry`）。
 *
 * 模型调用失败（自动重试耗尽）或用户点了停止之后，composer 右下角的按钮变成圆形
 * 「重试」图标；点击后失败路径在**同一 turn/step 原地重新调用模型**（不追加用户消息），
 * 停止路径用 `agent.followup()` 驱动新一轮。
 *
 * 实现全部在 `lib/retry/`（原 `dsh-turn-retry` 插件并入时原样保留）：
 *
 * - `gate.mjs`：闸门状态机（120 秒等待上限、5 秒孤儿保护）；
 * - `host.mjs`：`agent/request-error` waterfall 的挂起与放行、`session/event` 监听；
 * - `recovery.mjs`：「停止后可重试」记录（带 TTL）；
 * - `rpc.mjs`：浏览器半的 `/dsh-turn-retry` 通道（保留旧前缀，避免无谓回归）；
 * - `diagnostics.mjs`：「按钮为什么没出现」的处理轨迹。
 *
 * 这个组件**不需要 `tools`**：它不注册任何模型工具，只挂事件与 RPC。
 *
 * @module dsh-session-id/retry
 */

import { BUILD } from '../lib/build.mjs';
import { installTurnRetry } from '../lib/retry/host.mjs';

/** Cordis 插件名：与 Loader 行的 `name` 一致。 */
export const name = 'dsh-session-id/retry';

/** 不注册工具；`installTurnRetry` 自己用 `ctx.inject` 软取 connection / webServer。 */
export const inject = [];

export { BUILD };

/**
 * 注册「失败重试」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  installTurnRetry(ctx);
  ctx.logger?.info?.(`dsh-session-id/retry: ready (build=${BUILD})`);
}
