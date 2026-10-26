# Changelog

本插件的改动都记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。

## 0.2.0 — 2026-10-26

会话增强。

### 新增

- **会话分享**（参考 DeepSeek 网页版的会话分享）：
  - 浏览器半：标题栏新增「分享会话」按钮（复制按钮左侧），对话框内可创建链接、复制、
    打开、下载单文件 HTML、两段式停止分享；
  - Host 半：免登录只读路由 `GET /share/<token>`——24 字节随机 token、每次请求现读
    会话日志（撤销即 404）、严格 CSP、页面不含会话 id / cwd / token / 工具参数；
    `?download=1` 存成单文件 HTML 直接发给别人；
  - 认证 RPC 通道 `/dsh-session-id`（`connection.admit` 校验）：`share.status` /
    `share.create` / `share.revoke`；
  - 新工具 `session_share`（create / status / revoke / list）：让 Agent 在用户明确要求
    时也能分享；描述里写明"只在用户明确要求时调用"；
  - 分享记录存 `<DSH_HOME>/dsh-session-id/shares.json`，只存
    `{ sessionId, createdAt, includeDescendants }`，不存会话内容。
- **插件显示名改为「会话增强」**（`meta.title` 与 locale）。包名 / 仓库名保留
  `dsh-session-id`，避免已有安装路径与链接失效。

### 修复（真实回归暴露）

- `share.create` 在拿不到分享地址时先写记录再报错，会留下打不开的孤儿分享；现在先校验
  origin 与会话存在性，再落盘。
- `shares.json` 带 UTF-8 BOM（Windows 编辑器 / `Set-Content` 常见）时被当作损坏文件，
  导致分享功能整体拒绝写入；现在读取时容忍 BOM。

### 已验证

- 离线单测 47/47：新增分享存储（幂等/撤销/持久化/损坏文件/BOM）、HTML 转义、分享视图、
  `session_share` 全流程、`presentShare` 拼 URL、公开路由 token 解析。
- headless 真实 Loader：`session_share` 在无 web server 的部署里返回结构化失败（不崩）；
  `session_lookup` 与真实子代理发现仍通过。
- web 沙箱真实 HTTP 端到端：`share.create` → 公开页 200（约 4.5 KB，含消息与只读徽标）→
  下载返回 `attachment` 文件名 → 未知 token 404 → `POST` 405 → 撤销后再访问 404；
  CSP 头存在。
- UI 沙箱真实浏览器（沙箱 Web GUI + 无头 Chrome，真实鼠标事件）：分享按钮 28×28 位于复制
  按钮左侧 → 打开「分享会话」对话框 → 「创建分享链接」得到真实链接（origin + `/share/` +
  32 位 token）→ 「复制链接」toast「链接已复制」→ 两段式「停止分享 / 确认停止分享」→ 回到
  未分享态并 toast「已停止分享」；分享期间 `fetch(url)` 返回 200（标题「会话分享」），撤销后
  同一 url 返回 404；全程控制台 0 错误。
- **说明**：分享页 HTML 里若出现会话 id，是消息正文本身包含它（用户/助手在对话里写了 id），
  不是模板渲染泄漏；`cwd`、token、工具参数均不进入页面。
- 已知限制（写进 README）：分享页需要部署可被访问（DSH 默认只监听 `127.0.0.1`；局域网用
  `--host`，公网需反代/内网穿透/`--public-url`）；离线分享用「下载 HTML」；暂无口令与有效期。

## 0.1.2 — 2026-10-25

### 变更

- **撤回** 0.1.1 的「提交作者邮箱改用 GitHub noreply 地址」做法：开源不改变作者身份，
  真实提交邮箱本来就在账号公开 profile 上，脱敏属于多此一举。仓库历史已重写——全部提交的
  author/committer 邮箱恢复为 `3247187440@qq.com`（作者名与提交日期不变，文件树零变化），
  并强推 `main`；本地 `user.email` 也不再覆盖为 noreply。
- 纯提交元数据/文档改动，无代码行为变化。

## 0.1.1 — 2026-10-22

开源（MIT）。

### 变更

- 许可证：`UNLICENSED` → `MIT`，补 `LICENSE` 文件，仓库转为公开。
- 公开前脱敏：移除 README 里的本机绝对路径与开发工具名；移除测试辅助文件里对内部
  开发工具/文档的引用；提交作者邮箱使用 GitHub noreply 地址。
- 无代码行为变化。

## 0.1.0 — 2026-10-22

首个版本。

### 新增

- **浏览器半**：会话标题栏 `conversation.session.header.utilities` 槽位新增「复制会话 ID」
  按钮（`order: -10`，落在「⋯」左边）。点击写入剪贴板并弹 toast；`navigator.clipboard`
  被拒时降级到 `document.execCommand('copy')`，两条都失败才提示失败。中英文词典齐备。
- **Host 半**：新工具 `session_lookup`，按会话 id 返回标题、工作区、预设、父级链、
  全部子代理（父在前、带 depth / parentId）、最近消息与继承事件数。省略 `sessionId`
  时查当前会话；失败（找不到 / 缺服务 / 空 id）与成功返回同一形状，均通过自身 output
  schema 校验。
- 零 npm 依赖、无 Config、无设置页；`cordis.patch.yml` 在根作用域 insert，任何模式
  都可用。

### 已验证

- 离线单测 28/28：严格 JSON-Schema 子集、`required` 覆盖全部 `properties`、返回值按
  自身 schema 校验、消息角色过滤、血缘拍平、失败分支形状。
- headless 沙箱（真实 Loader）：
  - `session_lookup`（无参数）识别当前会话、标题缺失、无子代理；不存在 id 返回可读失败；
  - 用 `subagent` 真的派生一个子代理后，无参数调用在 `subagents` 里发现它（depth 1），
    再用子代理 id 反查得到 `role=subagent`、`parentSessionId` 指向父会话、祖先链正确。
- 首轮 headless 回归暴露两个真实问题并已修复：一是消息里混入 2700+ 字符的 system 指令，
  二是每轮注入的 runtime context / system-reminder 以 user 角色占满列表。现在按角色与
  注入前缀双重过滤，实测「4 条消息里 3 条噪音」降为只留真实用户消息。
- UI 沙箱（web template，真实非 blank 会话）：
  - 插件客户端半进入页面清单（notes 原文 `client half is in the page's manifest`），
    控制台 0 条错误；
  - 按钮真实渲染：`<BUTTON>` 28×28、可见，位于「⋯」左侧；
  - 真实鼠标点击后 toast「会话 ID 已复制」出现并位于标题栏下方中央；
  - 失败路径：强制 `navigator.clipboard.writeText` reject 且 `document.execCommand('copy')`
    返回 false 后点击，toast 显示「复制失败，无法写入剪贴板」；
  - 两条路径的截图均已目视确认（标题栏按钮位置 + 成功 toast）。
