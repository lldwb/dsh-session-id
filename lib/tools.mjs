/**
 * `session_lookup` —— 按会话 id 查「这个会话是什么，以及它有哪些子代理」。
 *
 * ## 为什么只有一个工具
 *
 * 这个名字回答的是用户唯一会问的那句话：*我给 Agent 一个会话 id，让它看看那个
 * 会话和它的子代理*。一个工具、三个参数（其中两个有默认值），模型不需要在
 * 目录里挑选。查子代理的更多细节（事件级）应由 `session_event_*` 承担——本插件
 * 不复制那套查询界面。
 *
 * ## 严格 schema 的账
 *
 * 第三方插件不能 import `defineTool`，所以参数与**返回值**都要手写注册表接受的
 * JSON Schema 子集（`type` 单一字符串、`properties`、`required`、
 * `additionalProperties: false`、`items`、`enum`、`oneOf`、`const`、`description`）。
 * 注意几点：
 *
 * - 没有 `minimum` / `maximum` / `pattern`——写了也会被忽略，范围在 `execute`
 *   里收口；
 * - 每个对象节点的 `required` 必须列全，且返回值不能出现 `null`（用 `''` / `0`
 *   / `false` 表达缺失），否则运行时校验报 `tool returned invalid output`；
 * - `render` 只消费自己声明的字段。
 *
 * @module dsh-session-id/lib/tools
 */

import { lookupSession } from './service.mjs';

/**
 * 消息条数的默认值。
 *
 * 10 条 × 800 字符上限 ≈ 2K token，够回答"这个会话最近在做什么"，又不会
 * 一次调用就把整篇历史喂进上下文。需要更多时模型显式调大 `messageLimit`。
 */
export const DEFAULT_MESSAGE_LIMIT = 10;

/** 消息条数的硬上限，防止一次调用读进过多文本。 */
export const MAX_MESSAGE_LIMIT = 200;

/** 工具返回的文本块。 */
function text(content) {
  return [{ type: 'text', text: content }];
}

/** 一个 schema 属性节点。 */
function prop(type, description, extra = {}) {
  return { type, ...(description === undefined ? {} : { description }), ...extra };
}

/** 一个严格对象节点；`additionalProperties: false` 是注册表的硬要求。 */
function obj(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** 一个数组节点。 */
function arr(items, description) {
  return { type: 'array', ...(description === undefined ? {} : { description }), items };
}

/** 把外部传入的条数收口到 `[1, MAX_MESSAGE_LIMIT]`。 */
function clampMessageLimit(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MESSAGE_LIMIT;
  if (number < 1) return 1;
  if (number > MAX_MESSAGE_LIMIT) return MAX_MESSAGE_LIMIT;
  return number;
}

/**
 * 会话节点的 schema。成功与失败分支都返回它（失败时字段为空值），所以
 * `required` 与 `sessionLookup.output.schema` 里的引用保持同一份定义。
 */
const sessionNode = obj(
  {
    id: prop('string', 'Session ID exactly as stored.'),
    title: prop('string', 'Folded session title, or an empty string when no title has been generated yet.'),
    role: prop('string', '"root", "subagent" (a session spawned by a parent agent), or "fork" (a branch of another session).'),
    workspace: prop('string', 'Working directory recorded in the session header, or an empty string.'),
    createdAt: prop('string', 'ISO 8601 creation timestamp, or an empty string when unknown.'),
    agentPreset: prop('string', 'Agent preset id the session ran with, or an empty string.'),
    parentSessionId: prop('string', 'Parent session id, or an empty string for a root session.'),
    delegationDepth: prop('number', 'Delegation depth recorded in the header; 0 for a root session.'),
    isSeeded: prop('boolean', 'True when the session started from another session’s history.'),
    live: prop('boolean', 'True when the session is currently loaded in memory.'),
    persisted: prop('boolean', 'True when the session has a stored log.'),
    isCurrent: prop('boolean', 'True when this is the session that called the tool.'),
  },
  [
    'id',
    'title',
    'role',
    'workspace',
    'createdAt',
    'agentPreset',
    'parentSessionId',
    'delegationDepth',
    'isSeeded',
    'live',
    'persisted',
    'isCurrent',
  ],
);

/** 子代理节点的 schema：会话节点 + 它在树里的位置。 */
const subagentNode = obj(
  {
    ...sessionNode.properties,
    depth: prop('number', 'Depth below the target session: 1 for a direct child.'),
    parentId: prop('string', 'Id of the parent session node this subagent hangs off.'),
  },
  [...sessionNode.required, 'depth', 'parentId'],
);

/** 一条消息的 schema。 */
const messageNode = obj(
  {
    seq: prop('number', 'Event sequence number inside the session log.'),
    type: prop('string', 'Raw event type, e.g. "user/message".'),
    role: prop('string', 'Semantic role: user, assistant, or summary. Framework-injected system/developer messages and tool results are omitted.'),
    text: prop('string', 'Plain text of the message, truncated when very long.'),
    time: prop('string', 'ISO 8601 event time, or an empty string.'),
  },
  ['seq', 'type', 'role', 'text', 'time'],
);

/**
 * 构造全部工具定义。
 *
 * @param {any} ctx - Cordis 插件上下文（`execute` 里现场取服务，避免抓到旧引用）。
 * @returns {any[]} 工具定义数组。
 */
export function buildTools(ctx) {
  /** `session_lookup`。 */
  const sessionLookup = {
    name: 'session_lookup',
    description:
      'Inspect one DSH session by ID: title, workspace, preset, parent chain, every subagent session it spawned, and the most recent messages. ' +
      'Use it when the user pastes a session ID (copied from the session header’s copy button) and asks what that session is or which subagents it has. ' +
      'Omit sessionId to inspect the current session. Read-only; set includeMessages=false for metadata only.',
    parameters: obj({
      sessionId: prop(
        'string',
        'Target session ID as copied from the UI. Omit to use the current session.',
      ),
      includeMessages: prop(
        'boolean',
        'Return the most recent messages of the target session. Framework-injected system/developer messages and per-turn runtime-context reminders are omitted either way. Defaults to true.',
      ),
      messageLimit: prop(
        'number',
        `How many recent messages to return, 1-${MAX_MESSAGE_LIMIT}. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
      ),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the lookup failed; `summary` then explains why.'),
          targetId: prop('string', 'The requested session ID (empty when none was given).'),
          session: sessionNode,
          ancestors: arr(sessionNode, 'Known parent chain, nearest first.'),
          subagents: arr(subagentNode, 'Every descendant session, parents before children.'),
          subagentCount: prop('number', 'Number of descendant sessions.'),
          complete: prop('boolean', 'True when the whole lineage is known.'),
          unresolvedParentId: prop('string', 'Parent id missing from the corpus, or an empty string.'),
          inheritedEventCount: prop('number', 'How many events the target inherited from its parent; 0 when none.'),
          messages: arr(messageNode, 'Most recent semantic messages, oldest first; empty when includeMessages is false.'),
          summary: prop('string', 'Human-readable markdown report; render this verbatim.'),
          hint: prop('string', 'Optional next-step guidance, or an empty string.'),
        },
        [
          'ok',
          'targetId',
          'session',
          'ancestors',
          'subagents',
          'subagentCount',
          'complete',
          'unresolvedParentId',
          'inheritedEventCount',
          'messages',
          'summary',
          'hint',
        ],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次查询。
     *
     * `exec.agent.session.id` 是调用方会话 id：省略 `sessionId` 时用它，
     * 于是"看看我这个会话派生了哪些子代理"不需要先知道自己的 id。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 注册表提供的执行上下文（`agent`、`signal`）。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      const sessionId = requested === '' ? currentId : requested;
      return lookupSession({
        sessionQuery: typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined,
        sessionId,
        currentId,
        includeMessages: args?.includeMessages !== false,
        messageLimit: clampMessageLimit(args?.messageLimit),
        signal: exec?.signal,
      });
    },
    presentCall: (args) => {
      const requested = typeof args?.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : '当前会话';
      return { card: 'generic', title: `查找会话：${requested}` };
    },
  };

  return [sessionLookup];
}
