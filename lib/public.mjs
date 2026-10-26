/**
 * 公开的分享读取路由：`GET /share/<token>`。
 *
 * ## 为什么走 webServer 而不是 connection
 *
 * `connection` 的 fetch 路由面向"已认证的浏览器会话"，而分享链接要能被**任何知道
 * token 的人**打开（官方网页的会话分享也是这个语义）。`dsh-host-webserver` 是纯
 * HTTP 载体、不认识 harness 认证，正好是这条路由该待的地方。安全边界因此完全落在
 * token 上：24 字节随机、不可枚举、可撤销。
 *
 * ## 这条路由做什么、不做什么
 *
 * - 只读：GET / HEAD，不写任何状态；
 * - 只认 token：其它路径一律 404，不暴露"哪个 token 存在过"；
 * - 每次请求现读会话日志：撤销后立刻 404，也不需要把会话内容另存一份；
 * - 下载模式：`?download=1` 加 `Content-Disposition`，同一个页面存成单文件 HTML
 *   就能离线发给别人（DSH 默认只监听本机，这是让"分享"真正可用的关键）；
 * - 响应头收紧：`no-store` + 严格 CSP + `noindex`。
 *
 * @module dsh-session-id/lib/public
 */

import { renderErrorDocument, renderShareDocument } from './render.mjs';
import { loadShareView } from './shareview.mjs';

/** 公开路由前缀。 */
export const SHARE_PREFIX = '/share';

/**
 * 写一个 HTML 响应。
 *
 * @param {any} res - Node 响应。
 * @param {number} status - 状态码。
 * @param {string} html - 页面。
 * @param {{ headers?: Record<string, string>, headOnly?: boolean }} [options] - 额外响应头与 HEAD 处理。
 * @returns {void}
 */
function sendHtml(res, status, html, options = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...(options.headers ?? {}),
  });
  if (options.headOnly === true) {
    res.end();
    return;
  }
  res.end(html);
}

/**
 * 解析 `/share/<token>`；其它形状返回 null。
 *
 * @param {string} pathname - URL pathname。
 * @returns {string | null} token 或 null。
 */
export function tokenFromPath(pathname) {
  const parts = String(pathname).split('/').filter((part) => part !== '');
  if (parts.length !== 2) return null;
  if (parts[0] !== 'share') return null;
  return parts[1];
}

/**
 * 挂载公开分享路由。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {{
 *   store: any,
 *   sessionQuery: () => any,
 *   sessions: () => any,
 *   logger?: any,
 * }} deps - 依赖。
 * @returns {void}
 */
export function mountShareRoutes(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer', 'sessionQuery'], (routeCtx) => {
    routeCtx.effect(
      () =>
        routeCtx.webServer.register({
          kind: 'prefix',
          path: SHARE_PREFIX,
          handler: async (req, res) => {
            try {
              const headOnly = req.method === 'HEAD';
              if (req.method !== 'GET' && !headOnly) {
                sendHtml(res, 405, renderErrorDocument(405, '只支持只读访问'), { headOnly });
                return;
              }

              const url = new URL(req.url ?? '/', 'http://share.invalid');
              const token = tokenFromPath(url.pathname);
              const record = token === null ? undefined : deps.store.get(token);
              if (record === undefined) {
                sendHtml(res, 404, renderErrorDocument(404, '分享不存在或已失效'), { headOnly });
                return;
              }

              const loaded = await loadShareView({
                sessionQuery: deps.sessionQuery(),
                sessions: deps.sessions(),
                sessionId: record.sessionId,
                includeDescendants: record.includeDescendants === true,
                signal: undefined,
              });
              if (loaded.ok !== true) {
                sendHtml(res, 404, renderErrorDocument(404, '分享的会话已不存在'), { headOnly });
                return;
              }

              const html = renderShareDocument({
                title: loaded.view.title,
                createdAt: loaded.view.createdAt,
                messages: loaded.view.messages,
                subagents: loaded.view.subagents,
                sharedAt: record.createdAt,
              });

              const download = url.searchParams.get('download') === '1';
              sendHtml(res, 200, html, {
                headOnly,
                headers: download
                  ? { 'content-disposition': `attachment; filename="dsh-session-share-${record.token.slice(0, 8)}.html"` }
                  : {},
              });
            } catch (error) {
              deps.logger?.warn?.(`dsh-session-id: share page failed: ${error instanceof Error ? error.message : String(error)}`);
              sendHtml(res, 500, renderErrorDocument(500, '分享页面暂时无法打开'), { headOnly: req.method === 'HEAD' });
            }
          },
        }),
      'dsh-session-id: public share routes',
    );
  });
}
