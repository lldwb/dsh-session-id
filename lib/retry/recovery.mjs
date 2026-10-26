/**
 * 「被打断的轮次」记录 —— 让用户点「停止」之后仍然能重试。
 *
 * ## 为什么需要它（与 gate 的区别）
 *
 * 模型请求**失败**时，`agent/request-error` 的 waterfall 还没返回，loop 停在原地，
 * 插件可以用一个未 resolve 的 Promise 把它挂住，等用户点「重试」后返回
 * `{ kind: 'retry' }` —— 这是真正的「原地重试」，不产生任何用户消息。
 *
 * 但用户点**停止**之后，这一轮已经结束了：`agent.cancel()` 会 abort turn 信号，
 * loop 先记 `turn/end { reason: { kind: 'aborted' } }` 再收尾；此后任何尝试
 * `{ kind: 'retry' }` 都会被 `signal.throwIfAborted()` 立刻抛出。也就是说，
 * **停止之后没有"原地"可言**，只能驱动一次新的 turn。
 *
 * 唯一不需要用户自己打字的驱动方式是 `agent.followup({ content, source })` ——
 * 它排一条 user 角色消息并唤醒驱动器。所以「停止后重试」的实现是：
 * 记下"这一次是被用户中断的"，用户点重试时用 followup 驱动一轮新的请求。
 *
 * 本模块只保存这份记录（纯状态，不碰 Cordis/Agent），过期与清除都由调用方决定。
 *
 * @module dsh-session-id/lib/retry/recovery
 */

/** 记录的有效期：超过之后不再提供「重试」，避免旧会话一直挂着按钮。 */
export const DEFAULT_RECOVERY_TTL_MS = 30 * 60 * 1000;

/**
 * 一条「可重试的中断」记录。
 */
class RecoveryEntry {
  /**
   * @param {string} sessionId - 会话 id。
   * @param {object} info - `{ turn, causeKind, at }`。
   */
  constructor(sessionId, info) {
    this.sessionId = sessionId;
    this.turn = info.turn;
    this.causeKind = info.causeKind;
    this.at = info.at;
  }

  /**
   * 序列化给浏览器半。
   *
   * @param {number} now - 当前时间戳。
   * @returns {object} 快照。
   */
  snapshot(now) {
    return {
      sessionId: this.sessionId,
      turn: this.turn,
      causeKind: this.causeKind,
      at: this.at,
      ageMs: Math.max(0, now - this.at),
    };
  }
}

/**
 * 每个会话至多一条的「刚被中断、可重试」记录。
 */
export class RecoveryStore {
  /** @type {Map<string, RecoveryEntry>} */
  #entries = new Map();

  /** @type {number} */
  #ttlMs;

  /** @type {() => number} */
  #now;

  /**
   * @param {{ ttlMs?: number, now?: () => number }} [options] - 有效期与时钟。
   */
  constructor(options = {}) {
    this.#ttlMs =
      Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.trunc(options.ttlMs) : DEFAULT_RECOVERY_TTL_MS;
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  /** 有效期（毫秒）。 */
  get ttlMs() {
    return this.#ttlMs;
  }

  /**
   * 记住一次中断。
   *
   * @param {string} sessionId - 会话 id。
   * @param {{ turn: number, causeKind: string }} info - 中断信息。
   * @returns {void}
   */
  remember(sessionId, info) {
    this.#entries.set(
      sessionId,
      new RecoveryEntry(sessionId, {
        turn: info.turn,
        causeKind: info.causeKind,
        at: this.#now(),
      }),
    );
  }

  /**
   * 读当前记录（已过期则顺手清掉）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object | undefined} 快照。
   */
  peek(sessionId) {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (now - entry.at > this.#ttlMs) {
      this.#entries.delete(sessionId);
      return undefined;
    }
    return entry.snapshot(now);
  }

  /**
   * 取出并清掉记录（用户点了重试，用掉一次）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object | undefined} 快照。
   */
  take(sessionId) {
    const snapshot = this.peek(sessionId);
    this.#entries.delete(sessionId);
    return snapshot;
  }

  /**
   * 忘掉某会话的记录（用户发了新消息、开了新 turn、或点了放弃）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  forget(sessionId) {
    this.#entries.delete(sessionId);
  }

  /**
   * 清空所有记录（插件卸载）。
   *
   * @returns {void}
   */
  clear() {
    this.#entries.clear();
  }
}
