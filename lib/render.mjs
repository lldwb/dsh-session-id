/**
 * 分享页的 HTML 渲染。
 *
 * ## 为什么是自包含 HTML 而不是前端页面
 *
 * 拿到链接的人可能没有 DSH、没有登录、甚至不在这台机器上（用户把 DSH 绑定到局域网
 * 地址或做了反代）。分享页因此不依赖任何前端 bundle、不发任何额外请求：一个 HTML
 * 文件就是全部（内联 CSS、无 JS、无外部字体/图片）。同一个渲染器同时服务：
 *
 * - `GET /share/<token>` —— 浏览器里看；
 * - `GET /share/<token>?download=1` —— 存成单文件 HTML 发给别人。
 *
 * ## 安全上的三条硬规则
 *
 * 1. **一切动态内容都转义**：会话文本来自用户与模型，是最典型的注入面。
 * 2. **不渲染内部标识**：不输出会话 id、父会话 id、cwd、token，也不渲染工具调用
 *    参数与结果（那些最容易夹带本机路径与凭据）。分享页只呈现"对话本身"。
 * 3. **响应带严格 CSP**：`default-src 'none'` 只允许内联样式，即便某个转义漏了，
 *    页面也无法外联。
 *
 * @module dsh-session-id/lib/render
 */

/** 单条消息在分享页上的最大字符数（超长截断，避免一页几 MB）。 */
export const SHARE_MESSAGE_LIMIT = 8000;

/**
 * HTML 转义。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 可安全放进 HTML 文本节点的字符串。
 */
export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 毫秒时间戳 → `YYYY-MM-DD HH:mm`（服务器本地时区）；非法值返回空串。
 *
 * @param {unknown} timestamp - 毫秒时间戳。
 * @returns {string} 展示用时间。
 */
export function formatTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 消息角色 → 展示标签与样式类。 */
const ROLE_LABELS = {
  user: '用户',
  assistant: '助手',
  summary: '摘要',
};

/**
 * 渲染一条消息。
 *
 * @param {any} message - `{ role, text, time }`。
 * @returns {string} HTML 片段。
 */
function renderMessage(message) {
  const role = typeof message?.role === 'string' ? message.role : 'assistant';
  const label = ROLE_LABELS[role] ?? role;
  const text = String(message?.text ?? '');
  const clipped = text.length > SHARE_MESSAGE_LIMIT ? `${text.slice(0, SHARE_MESSAGE_LIMIT)}\n…（内容过长，已截断）` : text;
  const time = typeof message?.time === 'string' ? message.time.slice(0, 16).replace('T', ' ') : '';
  return [
    `<article class="msg msg-${escapeHtml(role)}">`,
    `<header><span class="role">${escapeHtml(label)}</span>${time === '' ? '' : `<time>${escapeHtml(time)}</time>`}</header>`,
    `<div class="body">${escapeHtml(clipped)}</div>`,
    `</article>`,
  ].join('');
}

/**
 * 渲染子代理列表（只给标题/层级/时间，不给 id）。
 *
 * @param {any[]} subagents - `{ title, depth, createdAt, role }`。
 * @returns {string} HTML 片段。
 */
function renderSubagents(subagents) {
  if (!Array.isArray(subagents) || subagents.length === 0) return '';
  const items = subagents.map((node) => {
    const depth = typeof node?.depth === 'number' && node.depth > 1 ? ` style="margin-left:${Math.min(node.depth - 1, 4) * 18}px"` : '';
    const title = typeof node?.title === 'string' && node.title !== '' ? node.title : '（无标题的子代理会话）';
    const time = formatTime(node?.createdAt);
    return `<li${depth}>${escapeHtml(title)}${time === '' ? '' : ` <time>${escapeHtml(time)}</time>`}</li>`;
  });
  return [
    `<section class="subagents">`,
    `<h2>子代理 <span class="count">${String(subagents.length)}</span></h2>`,
    `<ul>${items.join('')}</ul>`,
    `</section>`,
  ].join('');
}

/** 页面样式：内联，深浅色自适应，打印友好。 */
const STYLE = `
:root { color-scheme: light dark; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb; --bg:#ffffff; --chip:#f3f4f6; --user:#eff6ff; --assistant:#f9fafb; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e6e8eb; --muted:#9aa1ab; --line:#2a2f36; --bg:#15181c; --chip:#22272e; --user:#1b2733; --assistant:#1a1d21; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
header.page { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 8px; }
header.page h1 { font-size: 22px; line-height: 1.35; margin: 0 0 8px; word-break: break-word; }
header.page .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.badge { background: var(--chip); border-radius: 999px; padding: 1px 10px; font-size: 12px; color: var(--muted); }
.msg { border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin: 14px 0; }
.msg-user { background: var(--user); }
.msg-assistant { background: var(--assistant); }
.msg-summary { background: var(--chip); }
.msg header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.msg .role { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.msg time { color: var(--muted); font-size: 12px; }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; }
.subagents { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 18px; }
.subagents h2 { font-size: 15px; margin: 0 0 10px; }
.subagents .count { color: var(--muted); font-weight: 400; }
.subagents ul { margin: 0; padding-left: 18px; }
.subagents li { margin: 4px 0; }
.subagents time { color: var(--muted); font-size: 12px; }
footer.page { margin-top: 36px; border-top: 1px solid var(--line); padding-top: 14px; color: var(--muted); font-size: 12px; display:flex; flex-wrap:wrap; gap:6px 14px; }
.empty { color: var(--muted); padding: 24px 0; }
@media print { body { background:#fff; color:#000; } .msg { break-inside: avoid; } }
`;

/**
 * 渲染完整分享文档。
 *
 * @param {{ title: string, createdAt: number, messages: any[], subagents: any[], sharedAt: number, truncated?: boolean }} view - 页面数据。
 * @returns {string} 完整 HTML。
 */
export function renderShareDocument(view) {
  const title = typeof view?.title === 'string' && view.title !== '' ? view.title : '会话分享';
  const messages = Array.isArray(view?.messages) ? view.messages : [];
  const subagents = Array.isArray(view?.subagents) ? view.subagents : [];
  const created = formatTime(view?.createdAt);
  const shared = formatTime(view?.sharedAt);
  const body = messages.length === 0
    ? '<p class="empty">这个会话还没有可展示的消息。</p>'
    : messages.map(renderMessage).join('');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)} · 会话分享</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><main>',
    '<header class="page">',
    `<h1>${escapeHtml(title)}</h1>`,
    '<div class="meta">',
    created === '' ? '' : `<span>创建于 ${escapeHtml(created)}</span>`,
    `<span>${String(messages.length)} 条消息</span>`,
    '<span class="badge">只读分享</span>',
    '</div>',
    '</header>',
    body,
    renderSubagents(subagents),
    '<footer class="page">',
    shared === '' ? '' : `<span>分享于 ${escapeHtml(shared)}</span>`,
    '<span>由 DeepSeek Harness 生成 · 只读 · 链接失效后不可访问</span>',
    '</footer>',
    '</main></body></html>',
  ].join('');
}

/**
 * 渲染一个简短的错误页（404/405/500 都用它，不回显内部细节）。
 *
 * @param {number} status - HTTP 状态码。
 * @param {string} message - 用户可见文案。
 * @returns {string} 完整 HTML。
 */
export function renderErrorDocument(status, message) {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${String(status)} · 会话分享</title>`,
    `<style>${STYLE}</style>`,
    '</head><body><main>',
    `<header class="page"><h1>${escapeHtml(message)}</h1></header>`,
    '<footer class="page"><span>由 DeepSeek Harness 生成</span></footer>',
    '</main></body></html>',
  ].join('');
}
