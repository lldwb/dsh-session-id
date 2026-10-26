/**
 * 诊断记录 —— 只保留最近若干条"失败事件被如何处理"的轨迹。
 *
 * ## 为什么需要它
 *
 * 这个插件的行为依赖多个运行时探测（是不是 root Agent、有没有活跃浏览器客户端），
 * 而"按钮没出现"时，从界面完全看不出是哪一条探测否决了挂起 —— 用户只会看到这一轮
 * 按 DSH 原生语义结束了。
 *
 * 于是把每次 `agent/request-error` 的判定结果（以及当时的探测快照）记在内存里，
 * 通过 RPC 端点 `diag` 读出来。它不写文件、不进会话日志、不影响任何行为，重启
 * 进程即清空。
 *
 * 记录上限刻意很小（默认 40 条）：它只用于回答"刚才那次失败为什么没挂起"。
 *
 * @module dsh-session-id/lib/retry/diagnostics
 */

/** 默认保留条数。 */
export const DEFAULT_DIAGNOSTIC_LIMIT = 40;

/**
 * 一个环形缓冲区，存最近的失败处理轨迹。
 */
export class Diagnostics {
  /** @type {object[]} */
  #records = [];

  /** @type {number} */
  #limit;

  /**
   * @param {number} [limit] - 最多保留多少条。
   */
  constructor(limit = DEFAULT_DIAGNOSTIC_LIMIT) {
    this.#limit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_DIAGNOSTIC_LIMIT;
  }

  /**
   * 记一条轨迹。
   *
   * `data` 必须能 JSON 序列化（RPC 层要求），调用方负责只放基本类型。
   *
   * @param {object} record - 轨迹内容。
   * @returns {void}
   */
  record(record) {
    this.#records.push({ at: Date.now(), ...record });
    if (this.#records.length > this.#limit) this.#records.shift();
  }

  /**
   * 读全部轨迹（新→旧）。
   *
   * @returns {object[]} 轨迹数组。
   */
  list() {
    return [...this.#records].reverse();
  }

  /** 清空。 */
  clear() {
    this.#records = [];
  }
}
