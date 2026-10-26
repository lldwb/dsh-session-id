/**
 * 分享页的数据装载：把一次会话读成渲染器要的视图。
 *
 * ## 为什么和 `session_lookup` 复用同一套折叠
 *
 * 两个功能对"什么是一条消息"必须给出同一个答案，否则用户会发现"工具看到的会话"
 * 和"分享出去的会话"不一样。所以消息提取、注入过滤、子代理拍平都走
 * `lib/service.mjs`；这里只负责增量（标题、创建时间、flush 实时日志）与分享页的
 * 取舍（消息条数/长度上限、子代理只留展示字段）。
 *
 * @module dsh-session-id/lib/shareview
 */

import { flattenDescendants, messagesOf, readTitles } from './service.mjs';

/** 分享页最多展示多少条消息（防止一次分享把整部历史塞进一张网页）。 */
export const SHARE_MESSAGE_COUNT = 500;

/** 分享页单条消息的字符上限。 */
export const SHARE_MESSAGE_TEXT = 8000;

/**
 * 把一个实时会话的日志刷到持久层，保证分享页读到最新事件。
 *
 * 冷会话或没有 `sessions` 服务时什么都不做——这不是错误。
 *
 * @param {any} sessions - `ctx.sessions`（可选）。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<void>} 完成后返回。
 */
async function flushLiveSession(sessions, sessionId) {
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return;
  const session = sessions.get(sessionId);
  if (session === undefined) return;
  try {
    await sessions.flush(session);
  } catch {
    // flush 失败不阻断分享：读到的可能少最后几条，但页面仍然可用。
  }
}

/**
 * 装载分享视图。
 *
 * @param {{
 *   sessionQuery: any,
 *   sessions?: any,
 *   sessionId: string,
 *   includeDescendants: boolean,
 *   signal?: AbortSignal,
 * }} request - 装载参数。
 * @returns {Promise<{ ok: boolean, error: string, view: { title: string, createdAt: number, messages: any[], subagents: any[] } }>} 视图或错误。
 */
export async function loadShareView(request) {
  const { sessionQuery, sessions, sessionId, includeDescendants, signal } = request;
  const empty = { title: '', createdAt: 0, messages: [], subagents: [] };
  if (sessionQuery === undefined || sessionQuery === null) {
    return { ok: false, error: 'SESSION_QUERY_UNAVAILABLE', view: empty };
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: 'SESSION_NOT_FOUND', view: empty };
  }

  await flushLiveSession(sessions, sessionId);

  let trace;
  try {
    trace = await sessionQuery.traceSession(sessionId, signal);
  } catch {
    return { ok: false, error: 'SESSION_NOT_FOUND', view: empty };
  }

  const header = trace?.target?.header;
  if (header === undefined || header === null) {
    return { ok: false, error: 'SESSION_NOT_FOUND', view: empty };
  }

  const titles = await readTitles(sessionQuery, [header.id], signal);
  const title = titles.get(header.id) ?? '';

  let messages = [];
  try {
    const surface = await sessionQuery.readSurface(sessionId, signal);
    messages = messagesOf(surface, SHARE_MESSAGE_COUNT, SHARE_MESSAGE_TEXT).map((message) => ({
      role: message.role,
      text: message.text,
      time: message.time,
    }));
  } catch {
    messages = [];
  }

  /** @type {any[]} */
  let subagents = [];
  if (includeDescendants === true) {
    const flat = flattenDescendants(trace?.descendants);
    if (flat.length > 0) {
      const descendantTitles = await readTitles(
        sessionQuery,
        flat.map((node) => node.record.header.id),
        signal,
      );
      subagents = flat.map((node) => {
        const childHeader = node.record.header;
        return {
          title: descendantTitles.get(childHeader.id) ?? '',
          depth: node.depth,
          createdAt: typeof childHeader.createdAt === 'number' ? childHeader.createdAt : 0,
          role: 'subagent',
        };
      });
    }
  }

  return {
    ok: true,
    error: '',
    view: {
      title,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      messages,
      subagents,
    },
  };
}
