/**
 * 重试等待闸门 —— 纯状态机，不碰 Cordis、HTTP 或会话对象。
 *
 * ## 它解决的问题
 *
 * 模型请求最终失败时，`@deepseek-ai/dsh-agent-loop` 会走一个 waterfall
 * `agent/request-error`：监听器返回 `{ kind: 'retry' }`，loop 就在**同一个
 * turn / step 重新发起模型调用**；什么都不返回（或调用 `next()`）则把这一轮
 * 以错误收尾。loop 内部的自动重试（默认 5 次）在更下层（`llm/stream`）已经
 * 跑完了，所以走到这里时正是"自动重试也救不回来"的那一次。
 *
 * 本插件想做的事：把这次失败**挂住**，让界面出现一个「重试」按钮，用户点一下
 * 就直接重新调用模型 —— 不往对话里追加任何用户消息（区别于手工输入「继续」）。
 *
 * 这个模块只管"谁在等、等多久、谁放行"，因此可以用 `node --test` 直接测，
 * 不需要任何 DSH 运行时。
 *
 * ## 决策词汇
 *
 * - `retry`      —— 用户点了「重试」：交给 loop 重新 dispatch 模型请求。
 * - `canceled`   —— 用户点了「放弃」：按默认行为让这一轮以错误结束。
 * - `timeout`    —— 等太久没人点：按默认行为结束（避免 Agent 永久 running）。
 * - `aborted`    —— 用户按了停止 / turn 被取消：按默认行为结束。
 * - `superseded` —— 同一会话又开了一个新闸门：旧的按默认行为结束。
 * - `disposed`   —— 插件卸载：全部按默认行为结束。
 *
 * @module dsh-session-id/lib/retry/gate
 */

/** 默认等待上限（毫秒）。超时后按"失败"处理，不改变 DSH 原有语义。 */
export const DEFAULT_WAIT_MS = 120_000;

/** 所有可能把闸门放行的原因。 */
export const GATE_DECISIONS = Object.freeze([
  'retry',
  'canceled',
  'timeout',
  'aborted',
  'superseded',
  'disposed',
  'no-client',
]);

/** 默认"没人来问就放行"的等待时长（毫秒）。 */
export const DEFAULT_ORPHAN_WAIT_MS = 5_000;

/**
 * 把任意异常/失败对象收成可 JSON 序列化的摘要。
 *
 * Host 传给浏览器半的信息必须是最小、稳定、可展示的：错误码、消息、以及
 * 该不该提示"这次重试可能也没用"。`unknown` 形态的 failure 也要有个形状，
 * 否则 `JSON.stringify` 会在 RPC 层抛。
 *
 * @param {unknown} failure - `agent/request-error` 里的 failure 值。
 * @returns {{ code?: string, message: string }} 摘要。
 */
export function summarizeFailure(failure) {
  if (failure === null || failure === undefined) return { message: 'Model request failed' };
  if (typeof failure === 'string') return { message: failure };
  if (typeof failure !== 'object') return { message: String(failure) };
  const value = /** @type {{ code?: unknown, message?: unknown }} */ (failure);
  const message =
    typeof value.message === 'string' && value.message.length > 0
      ? value.message
      : 'Model request failed';
  if (typeof value.code === 'string' && value.code.length > 0) {
    return { code: value.code, message };
  }
  return { message };
}

/**
 * 一个等待中的闸门条目。
 *
 * 只暴露只读快照给 RPC；`resolve` 留在类内部，避免外部误提前放行。
 */
class GateEntry {
  /**
   * @param {string} sessionId - 会话 id（闸门的主键）。
   * @param {object} info - 失败上下文（turn / step / provider / failure）。
   * @param {(decision: string) => void} resolve - 放行回调。
   * @param {number} openedAt - 打开时间戳（毫秒）。
   */
  constructor(sessionId, info, resolve, openedAt) {
    this.sessionId = sessionId;
    this.turn = info.turn;
    this.step = info.step;
    this.provider = info.provider;
    this.failure = summarizeFailure(info.failure);
    this.openedAt = openedAt;
    this.resolve = resolve;
    /**
     * 是否已经有客户端来问过 `pending`。
     *
     * 它是"有没有界面在等"的唯一实证：浏览器半在判断"看起来失败了"之后会立刻查一次。
     * 没人来问 → 这个页面上没有能点按钮的半边 → 不该挂住 turn。
     */
    this.probed = false;
  }

  /**
   * 浏览器半读到的快照：不含函数，可以直接过 JSON。
   *
   * @param {number} now - 当前时间戳，用来算已等待时长。
   * @returns {object} 快照。
   */
  snapshot(now) {
    return {
      sessionId: this.sessionId,
      turn: this.turn,
      step: this.step,
      provider: this.provider,
      failure: this.failure,
      openedAt: this.openedAt,
      waitedMs: Math.max(0, now - this.openedAt),
    };
  }
}

/**
 * 每会话至多一个的重试闸门集合。
 *
 * 设计取舍：
 * - **按会话去重**：同一会话不可能同时有两个模型失败（上一个失败一定以重试或
 *   收尾结束才会走到下一次请求），但防御性地让"新开覆盖旧的"可以保证状态不会
 *   卡在旧 turn 上。
 * - **不持有 timer**：每个闸门自带一个 `setTimeout`，全部在 `open` 内创建并在
 *   结算时清掉；`dispose()` 会一次性清空。定时器用 `unref()`，不让测试或进程
 *   退出被它吊住。
 */
export class RetryGate {
  /** @type {Map<string, GateEntry>} */
  #entries = new Map();

  /** @type {Map<string, () => void>} 每个会话的取消清理（timer + abort 监听）。 */
  #cleanups = new Map();

  /** @type {number} */
  #waitMs;

  /** @type {() => number} */
  #now;

  /**
   * @param {{ waitMs?: number, now?: () => number }} [options] - 等待上限与时钟（测试可注入）。
   */
  constructor(options = {}) {
    this.#waitMs = normalizeWaitMs(options.waitMs);
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  /** 当前等待上限（毫秒）。 */
  get waitMs() {
    return this.#waitMs;
  }

  /** 正在等待的数量。 */
  get size() {
    return this.#entries.size;
  }

  /**
   * 打开一个闸门并等它的决策。
   *
   * `signal` 是 loop 传下来的 turn/turn 取消信号：用户按停止、会话被归档、
   * 或 Agent 被 dispose 时它都会 abort。abort 后必须立刻放行（按"失败"），
   * 否则 turn 永远关不掉。
   *
   * @param {string} sessionId - 会话 id。
   * @param {object} info - `{ turn, step, provider, failure }`。
   * @param {AbortSignal | undefined} signal - 取消信号。
   * @param {{ orphanWaitMs?: number }} [options] - `orphanWaitMs`：多久没人来问就放行。
   * @returns {{ decision: Promise<string>, snapshot: object }} 决策 promise 与当前快照。
   */
  open(sessionId, info, signal, options = {}) {
    // 同一会话已有闸门：先按 superseded 关掉旧的，避免旧 promise 悬着。
    this.#settle(sessionId, 'superseded');

    const openedAt = this.#now();
    let resolveDecision;
    const decision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const entry = new GateEntry(sessionId, info, resolveDecision, openedAt);
    this.#entries.set(sessionId, entry);

    /** 结算并清掉所有资源；幂等。 */
    const cleanup = () => {
      const timer = setTimeout(() => {
        this.#settle(sessionId, 'timeout');
      }, this.#waitMs);
      timer.unref?.();

      // 孤儿保护：闸门等的是"浏览器半来查 pending"。如果开闸后一小段时间内**没有任何
      // 客户端来查**，说明这个页面上根本没有能点按钮的半边（插件刚装还没刷新页面、
      // 页面被换掉、client 半加载失败…）。这时干等满 120 秒是纯伤害 —— 用户只会看到
      // "运行中"卡两分钟，然后按 DSH 原生语义失败。
      const orphanWaitMs = options.orphanWaitMs;
      let orphanTimer;
      if (Number.isFinite(orphanWaitMs) && orphanWaitMs > 0) {
        orphanTimer = setTimeout(() => {
          if (!entry.probed) this.#settle(sessionId, 'no-client');
        }, orphanWaitMs);
        orphanTimer.unref?.();
      }

      const clearAll = () => {
        clearTimeout(timer);
        if (orphanTimer !== undefined) clearTimeout(orphanTimer);
      };

      const onAbort = () => {
        this.#settle(sessionId, 'aborted');
      };
      if (signal === undefined || signal === null) {
        return clearAll;
      }
      if (signal.aborted) {
        // 已经取消的 turn 不该挂闸门：立刻按 aborted 结算。
        clearAll();
        queueMicrotask(() => this.#settle(sessionId, 'aborted'));
        return clearAll;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      return () => {
        clearAll();
        signal.removeEventListener('abort', onAbort);
      };
    };

    this.#cleanups.set(sessionId, cleanup());
    return { decision, snapshot: entry.snapshot(this.#now()) };
  }

  /**
   * 标记"这个会话有客户端来问过了"。
   *
   * 由 RPC 的 `pending` 端点调用。它是孤儿保护的反证：只要有人来问，就说明界面上
   * 有一个能点按钮的半边在等着，闸门可以继续等用户慢慢决定。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  markProbed(sessionId) {
    const entry = this.#entries.get(sessionId);
    if (entry !== undefined) entry.probed = true;
  }

  /**
   * 让一个等待中的闸门放行。
   *
   * @param {string} sessionId - 会话 id。
   * @param {'retry' | 'canceled'} decision - 用户动作。
   * @returns {boolean} 是否真的有一个闸门在等。
   */
  settle(sessionId, decision) {
    return this.#settle(sessionId, decision);
  }

  /**
   * 读取一个会话的等待快照（浏览器半轮询/确认时用）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object | undefined} 快照；没有等待时 undefined。
   */
  get(sessionId) {
    const entry = this.#entries.get(sessionId);
    return entry === undefined ? undefined : entry.snapshot(this.#now());
  }

  /**
   * 列出所有等待中的快照（诊断/工具用）。
   *
   * @returns {object[]} 快照数组。
   */
  list() {
    const now = this.#now();
    return [...this.#entries.values()].map((entry) => entry.snapshot(now));
  }

  /**
   * 插件卸载：把所有等待按 `disposed` 放行并清空。
   *
   * 不做的话，插件重载会让挂起的 turn 永远等下去（旧 fiber 的 promise 没人放行）。
   *
   * @returns {void}
   */
  dispose() {
    for (const sessionId of [...this.#entries.keys()]) {
      this.#settle(sessionId, 'disposed');
    }
  }

  /**
   * 内部结算。
   *
   * @param {string} sessionId - 会话 id。
   * @param {string} decision - 决策原因。
   * @returns {boolean} 是否真的结算了一个闸门。
   */
  #settle(sessionId, decision) {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return false;
    this.#entries.delete(sessionId);
    const cleanup = this.#cleanups.get(sessionId);
    this.#cleanups.delete(sessionId);
    cleanup?.();
    entry.resolve(decision);
    return true;
  }
}

/**
 * 把等待时长规整成"合理的正数"，避免配置成 0 或负数时立刻超时。
 *
 * @param {unknown} value - 候选值。
 * @returns {number} 毫秒。
 */
export function normalizeWaitMs(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_MS;
  const rounded = Math.trunc(parsed);
  if (rounded < 5_000) return 5_000;
  if (rounded > 3_600_000) return 3_600_000;
  return rounded;
}
