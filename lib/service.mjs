/**
 * 会话查询服务：把 `ctx.sessionQuery` 的原始记录折叠成「人 + 模型都能读」的视图。
 *
 * ## 为什么单独一层
 *
 * 工具定义只需要声明 schema 与渲染，不需要知道 `traceSession` 的树形结构、
 * 标题快照的 `fulfilled/rejected` 包装、或消息事件里文本块藏在 `content` 还是
 * `message.content`。这些形状是随附包的内部约定，随版本变化；把它们收在一处，
 * 升级时只改这个文件，工具 schema 与测试保持稳定。
 *
 * ## 三条设计决定
 *
 * 1. **跨工作区不阻断，但可见**。会话 id 由用户主动从界面复制并粘给模型，
 *    那是用户的明确授权；同时输出里带上目标与会话方的 `workspace`，让模型
 *    自己发现"这不是同一个工作区"，而不是静默读别处的历史。
 * 2. **输出形状固定，失败也固定**。工具返回值会被注册表按 schema 校验，
 *    少一个字段或出现 `null` 就是 `tool returned invalid output`；所以失败
 *    分支也返回同一个对象，空值用 `''` / `0` / `false` 表示。
 * 3. **消息只取语义文本**。`readSurface` 返回当前模型表层事件；工具结果与
 *    未知事件对"这个会话是什么"没有帮助，只保留 user/assistant/system/
 *    developer/summary 五种，并截断超长文本。
 *
 * @module dsh-session-id/lib/service
 */

/** 单条消息保留的最大字符数（超长只保留前段，避免一次工具调用喂进整篇历史）。 */
export const MESSAGE_TEXT_LIMIT = 800;

/**
 * 事件类型 → 消息角色。
 *
 * 只列**人对人**的语义事件：`system/message` 与 `developer/message` 是 Agent
 * 框架注入的指令（实测一条 system 消息就有 2700+ 字符），它们描述的是"这个
 * Agent 被要求怎么工作"，不是"这个会话在聊什么"，一并排除；`tool/result`
 * 同理（工具输出本身不值得在概览里复述）。
 */
const ROLE_BY_EVENT_TYPE = new Map([
  ['user/message', 'user'],
  ['assistant/message', 'assistant'],
  ['compaction/summary', 'summary'],
]);

/**
 * 框架每轮注入、但以 `user` 角色落进事件的文本前缀。
 *
 * 这些不是用户说的话：runtime context 与 skill 目录每轮都会重发一遍，一条
 * 动辄上千字符，不滤掉会把"最近消息"挤满噪音（实测 4 条消息里 3 条是注入）。
 * 前缀由随附包生成、文案稳定，且用户真实输入几乎不可能以它们开头——判断
 * 保守且无副作用；真出现误判，也只是少列一条消息，不影响主结论。
 */
const INJECTED_PREFIXES = [
  '<system-reminder>',
  'Current runtime context.',
  'The following skills are available',
  'Skill instructions:',
  'This is the session runtime context',
];

/**
 * 判断一段文本是否是框架注入的上下文。
 *
 * @param {string} text - 消息文本。
 * @returns {boolean} 是注入文本时返回 true。
 */
export function looksInjected(text) {
  return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** 空会话占位：失败分支也返回完整 schema 形状时用它。 */
const EMPTY_SESSION = Object.freeze({
  id: '',
  title: '',
  role: 'root',
  workspace: '',
  createdAt: '',
  agentPreset: '',
  parentSessionId: '',
  delegationDepth: 0,
  isSeeded: false,
  live: false,
  persisted: false,
  isCurrent: false,
});

/**
 * 毫秒时间戳 → ISO 8601 字符串；缺失或非法返回空串。
 *
 * 输出 schema 里 `createdAt` / `time` 都是 string，不允许 `null`，所以这里
 * 统一收口，调用方不必再判空。
 *
 * @param {unknown} timestamp - 毫秒时间戳。
 * @returns {string} ISO 时间，或空串。
 */
export function toIso(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * 判断一个会话在血缘里的身份。
 *
 * - `subagent`：`origin` 只能是 `'subagent'`（`dsh-session` 的 header 校验），
 *   也就是 subagent / teammate 派生的会话；
 * - `fork`：有父会话但不是 subagent（用户从某轮分支出来的会话）；
 * - `root`：没有父会话。
 *
 * @param {{ origin?: string, parentSession?: string }} header - 会话头。
 * @returns {'root'|'subagent'|'fork'} 身份。
 */
export function classifyRole(header) {
  if (header !== null && typeof header === 'object' && header.origin === 'subagent') return 'subagent';
  if (header !== null && typeof header === 'object' && header.parentSession !== undefined) return 'fork';
  return 'root';
}

/**
 * 会话头 → 输出 schema 里的 session 节点。
 *
 * @param {any} header - `SessionHeader`。
 * @param {{ live?: boolean, persisted?: boolean }} availability - 语料库来源标志。
 * @param {string} title - 折叠标题（可能为空）。
 * @param {string} currentId - 调用方会话 id（用于 `isCurrent`）。
 * @returns {any} schema 对齐的会话节点。
 */
export function describeSession(header, availability, title, currentId) {
  return {
    id: typeof header.id === 'string' ? header.id : '',
    title: typeof title === 'string' ? title : '',
    role: classifyRole(header),
    workspace: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: toIso(header.createdAt),
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : '',
    delegationDepth: typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0,
    isSeeded: header.isSeeded === true,
    live: availability?.live === true,
    persisted: availability?.persisted === true,
    isCurrent: typeof header.id === 'string' && header.id === currentId,
  };
}

/**
 * 递归展开后代树，父在前、子在后，带深度与父 id。
 *
 * `traceSession` 返回的是嵌套 `{ session, descendants }`；模型读扁平的
 * 列表比读嵌套 JSON 更省 token，也更容易在回答里逐条引用。
 *
 * @param {any[]} nodes - `trace.descendants`。
 * @param {number} depth - 当前深度（根的直接子会话为 1）。
 * @param {string} parentId - 当前父会话 id。
 * @returns {any[]} 扁平节点，每项 `{ record, depth, parentId }`。
 */
export function flattenDescendants(nodes, depth = 1, parentId = '') {
  const flat = [];
  if (!Array.isArray(nodes)) return flat;
  for (const node of nodes) {
    if (node === null || typeof node !== 'object' || node.session === null || typeof node.session !== 'object') continue;
    const header = node.session.header;
    if (header === null || typeof header !== 'object') continue;
    flat.push({ record: node.session, depth, parentId });
    flat.push(...flattenDescendants(node.descendants, depth + 1, typeof header.id === 'string' ? header.id : ''));
  }
  return flat;
}

/**
 * 一次批量读取多个会话的折叠标题；逐会话失败只让该条标题为空。
 *
 * @param {any} sessionQuery - `ctx.sessionQuery`。
 * @param {string[]} sessionIds - 需要标题的会话 id（可重复，服务会去重）。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<Map<string, string>>} id → 标题。
 */
export async function readTitles(sessionQuery, sessionIds, signal) {
  const titles = new Map();
  if (sessionIds.length === 0) return titles;
  let observations;
  try {
    observations = await sessionQuery.readTitleSnapshots(sessionIds, signal);
  } catch {
    // 标题是锦上添花：整批失败不该让"按 id 找到会话"这个主任务失败。
    return titles;
  }
  if (!Array.isArray(observations)) return titles;
  for (const observation of observations) {
    if (observation === null || typeof observation !== 'object' || observation.status !== 'fulfilled') continue;
    const value = observation.value;
    if (value === null || typeof value !== 'object') continue;
    const id = typeof observation.sessionId === 'string' ? observation.sessionId : value.session?.id;
    if (typeof id !== 'string' || typeof value.title !== 'string') continue;
    titles.set(id, value.title);
  }
  return titles;
}

/**
 * 从一条表层事件里取出可读文本。
 *
 * 事件形状由 `dsh-session` 的折叠器决定，文本块可能位于三处：
 * `data.content`（user/message、tool/ptc-dispatch）、`data.message.content`
 * （assistant/system/developer/tool）、`data.summary`（compaction/summary，
 * 它本身是 content 数组）。三处都试，取不到就是空串。
 *
 * @param {any} event - 一条会话事件。
 * @returns {string} 拼接后的纯文本。
 */
export function messageTextOf(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return '';
  const blocks = Array.isArray(data.content)
    ? data.content
    : Array.isArray(data.message?.content)
      ? data.message.content
      : Array.isArray(data.summary)
        ? data.summary
        : [];
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 截断超长文本，保留前段并标记。
 *
 * @param {string} text - 原文。
 * @param {number} limit - 最大字符数。
 * @returns {string} 可能被截断的文本。
 */
export function truncateText(text, limit = MESSAGE_TEXT_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…（已截断，原长 ${text.length} 字符）`;
}

/**
 * 表层事件 → 最近 N 条语义消息。
 *
 * @param {any} surface - `sessionQuery.readSurface` 的返回值。
 * @param {number} limit - 最多保留多少条（取最后 N 条）。
 * @returns {any[]} schema 对齐的消息列表。
 */
export function messagesOf(surface, limit) {
  const events = Array.isArray(surface?.events) ? surface.events : [];
  const messages = [];
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const role = ROLE_BY_EVENT_TYPE.get(event.type);
    if (role === undefined) continue;
    const text = messageTextOf(event);
    if (text === '') continue;
    if (looksInjected(text)) continue;
    messages.push({
      seq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0,
      type: event.type,
      role,
      text: truncateText(text),
      time: toIso(event.time),
    });
  }
  return messages.slice(-limit);
}

/**
 * 工具调用失败时的完整输出（与成功同形状）。
 *
 * @param {string} targetId - 请求的会话 id。
 * @param {string} summary - 给模型看的失败说明。
 * @returns {any} 输出 schema 对齐的失败结果。
 */
export function failureResult(targetId, summary) {
  return {
    ok: false,
    targetId: typeof targetId === 'string' ? targetId : '',
    session: { ...EMPTY_SESSION },
    ancestors: [],
    subagents: [],
    subagentCount: 0,
    complete: false,
    unresolvedParentId: '',
    inheritedEventCount: 0,
    messages: [],
    summary,
    hint: '',
  };
}

/**
 * 把血缘、标题与消息拼成工具输出，并生成给模型读的 markdown 摘要。
 *
 * @param {any} input - `{ trace, titles, currentId, messages, messageLimit, includeMessages, inheritedEventCount }`。
 * @returns {any} 工具输出对象。
 */
export function renderLookup(input) {
  const { trace, titles, currentId, messages, includeMessages, inheritedEventCount } = input;
  const titleOf = (header) => titles.get(header.id) ?? '';

  const target = trace.target;
  const session = describeSession(target.header, target, titleOf(target.header), currentId);
  const ancestors = (Array.isArray(trace.ancestors) ? trace.ancestors : []).map((record) =>
    describeSession(record.header, record, titleOf(record.header), currentId),
  );
  const flat = flattenDescendants(trace.descendants);
  const subagents = flat.map((node) => ({
    ...describeSession(node.record.header, node.record, titleOf(node.record.header), currentId),
    depth: node.depth,
    parentId: node.parentId,
  }));

  const lines = [];
  lines.push(`## 会话 ${session.id}`);
  lines.push('');
  lines.push(`- 标题：${session.title === '' ? '（尚未生成标题）' : session.title}`);
  lines.push(`- 类型：${session.role === 'root' ? '根会话' : session.role === 'subagent' ? '子代理会话' : '分支会话'}`);
  lines.push(`- 工作区：${session.workspace === '' ? '（未记录）' : `\`${session.workspace}\``}`);
  lines.push(`- 创建时间：${session.createdAt === '' ? '（未知）' : session.createdAt}`);
  if (session.agentPreset !== '') lines.push(`- 预设：\`${session.agentPreset}\``);
  if (session.parentSessionId !== '') lines.push(`- 父会话：\`${session.parentSessionId}\``);
  lines.push(`- 状态：${session.live ? '运行中（live）' : '未运行'} · ${session.persisted ? '已持久化' : '仅内存'}`);
  if (session.isCurrent) lines.push('- 这是**当前会话**。');

  if (ancestors.length > 0) {
    lines.push('');
    lines.push(`### 祖先链（由近到远，共 ${ancestors.length} 个）`);
    for (const ancestor of ancestors) {
      const label = ancestor.title === '' ? '（无标题）' : ancestor.title;
      lines.push(`- \`${ancestor.id}\` · ${label} · ${ancestor.role}`);
    }
    if (trace.complete !== true) {
      lines.push(`- ⚠️ 血缘不完整：父会话 \`${String(trace.unresolvedParentId ?? '')}\` 不在可查询语料里。`);
    }
  }

  lines.push('');
  if (subagents.length === 0) {
    lines.push('### 子代理');
    lines.push('这个会话没有子代理会话。');
  } else {
    lines.push(`### 子代理（共 ${subagents.length} 个，父在前）`);
    for (const subagent of subagents) {
      const indent = subagent.depth > 1 ? '  '.repeat(subagent.depth - 1) : '';
      const label = subagent.title === '' ? '（无标题）' : subagent.title;
      const state = subagent.live ? ' · live' : '';
      lines.push(`${indent}- [d${subagent.depth}] \`${subagent.id}\` · ${label} · ${subagent.createdAt}${state}`);
    }
  }

  if (includeMessages === true) {
    lines.push('');
    if (messages.length === 0) {
      lines.push('### 最近消息');
      lines.push('没有可读的语义消息（会话可能是空的，或表层不含文本）。');
    } else {
      lines.push(`### 最近消息（${messages.length} 条）`);
      for (const message of messages) {
        const text = message.text.replace(/\n+/g, ' ').trim();
        lines.push(`- **${message.role}**（seq ${message.seq}）：${text}`);
      }
    }
  }

  const hints = [];
  if (subagents.length > 0) {
    hints.push('要了解某个子代理具体做了什么，可以再调用本工具把 sessionId 指向它；若部署挂载了 session_event_* 工具，也可按会话 id 读事件。');
  }
  if (includeMessages === false) hints.push('本次未返回消息正文；需要时用 includeMessages=true 再查一次。');
  if (typeof inheritedEventCount === 'number' && inheritedEventCount > 0) {
    hints.push(`该会话是种子会话：前 ${inheritedEventCount} 个事件继承自父会话，消息列表里可能包含父会话内容。`);
  }

  return {
    ok: true,
    targetId: session.id,
    session,
    ancestors,
    subagents,
    subagentCount: subagents.length,
    complete: trace.complete === true,
    unresolvedParentId: typeof trace.unresolvedParentId === 'string' ? trace.unresolvedParentId : '',
    inheritedEventCount: typeof inheritedEventCount === 'number' ? inheritedEventCount : 0,
    messages: includeMessages === true ? messages : [],
    summary: lines.join('\n'),
    hint: hints.join(' '),
  };
}

/**
 * 按会话 id 查一次：血缘 + 标题 + 最近消息。
 *
 * @param {{ sessionQuery: any, sessionId: string, currentId: string, includeMessages: boolean, messageLimit: number, signal?: AbortSignal }} request - 查询参数。
 * @returns {Promise<any>} 工具输出对象（成功与失败同形状）。
 */
export async function lookupSession(request) {
  const { sessionQuery, sessionId, currentId, includeMessages, messageLimit, signal } = request;
  const targetId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (targetId === '') {
    return failureResult('', '❌ 需要一个会话 ID：请把界面里复制的会话 ID 传进来。');
  }
  if (sessionQuery === undefined || sessionQuery === null) {
    return failureResult(targetId, '❌ 本部署没有会话查询服务（sessionQuery），无法按 id 查会话。');
  }

  let trace;
  try {
    trace = await sessionQuery.traceSession(targetId, signal);
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return failureResult(
        targetId,
        `❌ 找不到会话 \`${targetId}\`。它可能已被删除、属于另一台机器，或 id 复制得不完整。`,
      );
    }
    return failureResult(targetId, `❌ 查询会话失败${code === '' ? '' : `（${code}）`}：${message}`);
  }

  const headers = [trace.target.header, ...(trace.ancestors ?? []).map((record) => record.header)];
  for (const node of flattenDescendants(trace.descendants)) headers.push(node.record.header);
  const titles = await readTitles(
    sessionQuery,
    headers.map((header) => header.id),
    signal,
  );

  let messages = [];
  let inheritedEventCount = 0;
  if (includeMessages === true) {
    try {
      const surface = await sessionQuery.readSurface(targetId, signal);
      inheritedEventCount = typeof surface?.inheritedEventCount === 'number' ? surface.inheritedEventCount : 0;
      messages = messagesOf(surface, messageLimit);
    } catch {
      // 表层读取可能因日志损坏或超大历史失败；元信息仍然有价值，不整体失败。
      messages = [];
    }
  }

  return renderLookup({ trace, titles, currentId, messages, includeMessages, inheritedEventCount });
}
