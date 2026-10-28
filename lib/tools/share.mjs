/**
 * `session_share` —— 创建 / 查询 / 撤销只读分享链接。
 *
 * 属于「会话分享」组件（Loader 行 `dsh-session-id/share`）。
 *
 * 这是一个**有副作用且会外泄内容**的工具：调用它等于把会话交给任何拿到链接的人。
 * 描述里因此写死"只在用户明确要求时调用"，并且 create 成功后明确提示如何撤销。
 *
 * @module dsh-session-id/lib/tools/share
 */

import { presentShare } from '../rpc.mjs';
import { toIso } from '../service.mjs';
import { arr, enumProp, obj, prop, text } from './schema.mjs';

/** 一条分享记录的输出节点。 */
const shareNode = obj(
  {
    token: prop('string', 'Opaque share token; the URL is what matters to the user.'),
    url: prop('string', 'Read-only share URL, or an empty string when the web server has no origin yet.'),
    createdAt: prop('string', 'ISO 8601 creation time of the share, or an empty string.'),
    includeDescendants: prop('boolean', 'Whether the share page also lists subagent sessions.'),
  },
  ['token', 'url', 'createdAt', 'includeDescendants'],
);

/**
 * 构造 `session_share` 工具定义。
 *
 * @param {{
 *   store?: any,
 *   sessionQuery?: () => any,
 *   originOf?: () => string | null,
 * }} env - 分享依赖；缺省时工具返回结构化的"不可用"而不是抛错。
 * @returns {any} 工具定义。
 */
export function buildShareTool(env = {}) {
  /**
   * 存储记录 → 工具输出节点。
   *
   * @param {any} record - 存储记录。
   * @returns {any} schema 对齐的节点。
   */
  function presentShareNode(record) {
    const originOf = typeof env.originOf === 'function' ? env.originOf : () => null;
    const share = presentShare(record, originOf);
    return {
      token: share.token,
      url: share.url,
      createdAt: toIso(share.createdAt),
      includeDescendants: share.includeDescendants === true,
    };
  }

  return {
    name: 'session_share',
    description:
      'Create, inspect or revoke a read-only share link for a DSH session. ' +
      'ONLY call this when the user explicitly asks to share a session or to stop sharing: the link lets anyone who has it read the conversation. ' +
      'Actions: "create" (default) makes or returns the session’s link; "status" lists one session’s shares; "revoke" deletes a share by token; "list" lists every share on this deployment. ' +
      'Omit sessionId to use the current session.',
    parameters: obj({
      action: enumProp(['create', 'status', 'revoke', 'list'], 'What to do. Defaults to "create".'),
      sessionId: prop('string', 'Session to act on; defaults to the current session.'),
      token: prop('string', 'Share token, required for action="revoke".'),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the action failed; `summary` then explains why.'),
          action: prop('string', 'The action that ran.'),
          summary: prop('string', 'Human-readable verdict; render this verbatim.'),
          shares: arr(shareNode, 'Shares involved in this action; empty when none.'),
        },
        ['ok', 'action', 'summary', 'shares'],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次分享操作。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 执行上下文（`agent`、`signal`）。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'create';
      const store = env.store;
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      const sessionId = requested === '' ? currentId : requested;

      /**
       * 结构化失败。
       *
       * @param {string} summary - 给模型看的说明。
       * @returns {any} 失败结果。
       */
      const fail = (summary) => ({ ok: false, action, shares: [], summary });

      try {
        if (store === undefined || store === null) return fail('❌ 分享存储不可用，无法执行分享操作。');

        if (action === 'list') {
          const shares = store.list().map(presentShareNode);
          if (shares.length === 0) return { ok: true, action, shares, summary: '当前没有任何分享。' };
          const lines = [`当前共有 ${shares.length} 个分享：`, ''];
          for (const share of shares) lines.push(`- \`${share.token.slice(0, 8)}…\` · ${share.url === '' ? '（地址未知）' : share.url} · ${share.createdAt}`);
          return { ok: true, action, shares, summary: lines.join('\n') };
        }

        if (action === 'status') {
          if (sessionId === '') return fail('❌ 需要一个会话 ID。');
          const shares = store.listForSession(sessionId).map(presentShareNode);
          if (shares.length === 0) return { ok: true, action, shares, summary: `会话 \`${sessionId}\` 当前没有分享。` };
          const lines = [`会话 \`${sessionId}\` 的分享：`, ''];
          for (const share of shares) lines.push(`- ${share.url === '' ? '（地址未知）' : share.url}`);
          return { ok: true, action, shares, summary: lines.join('\n') };
        }

        if (action === 'revoke') {
          const token = typeof args?.token === 'string' ? args.token.trim() : '';
          if (token === '') return fail('❌ revoke 需要 `token`。');
          const revoked = store.revoke(token);
          return {
            ok: true,
            action,
            shares: [],
            summary: revoked ? `✅ 已停止分享（${token.slice(0, 8)}…），链接立即失效。` : '⚠️ 没有找到这条分享，可能已经被停止。',
          };
        }

        // create
        if (sessionId === '') return fail('❌ 需要一个会话 ID：请把界面里复制的会话 ID 传进来。');
        // 先确认能拿到分享根地址，再写记录：否则"创建失败"会留下一条用户看不到、
        // 也打不开的孤儿分享记录（真实回归里踩到过）。
        const originRead = typeof env.originOf === 'function' ? env.originOf() : null;
        if (typeof originRead !== 'string' || originRead === '') {
          return fail('❌ 无法确定分享地址（web server 尚未就绪），请稍后再试。');
        }
        const query = typeof env.sessionQuery === 'function' ? env.sessionQuery() : undefined;
        if (query === undefined || query === null) return fail('❌ 本部署没有会话查询服务（sessionQuery），无法分享。');
        try {
          await query.traceSession(sessionId, exec?.signal);
        } catch {
          return fail(`❌ 找不到会话 \`${sessionId}\`。`);
        }
        const record = store.create({ sessionId, includeDescendants: true });
        const share = presentShareNode(record);
        if (share.url === '') return fail('❌ 无法确定分享地址（web server 尚未就绪），请稍后再试。');
        return {
          ok: true,
          action,
          shares: [share],
          summary: [
            '✅ 已创建只读分享链接：',
            '',
            share.url,
            '',
            '任何拿到链接的人都能查看这个会话（含子代理），不需要登录。不需要时用 `session_share action="revoke"` 停止分享。',
          ].join('\n'),
        };
      } catch (error) {
        return fail(`❌ ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `会话分享：${String(args?.action ?? 'create')}` }),
  };
}
