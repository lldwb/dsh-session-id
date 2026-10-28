# Changelog

本插件的改动都记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。

## 2.0.1 — 2026-10-28

修 2.0.0 的组件边界漏洞：**停用「会话分享」或「失败重试」组件后，浏览器半的对应 UI 仍然在。**

### 修复

- **浏览器半新增组件能力探测**。浏览器半是包级一份（`dsh.client` 不能按行拆），只要
  第一行还在它就一定被加载；而 Host 侧的分享/重试是两条独立的 Loader 行，停用后它们
  注册的 RPC 前缀路由不再存在，请求会落到 SPA fallback —— 于是按钮还挂着、点了永远失败。
  现在 client 启动时各发一次探测请求，按 HTTP 状态判定：
  - `200` = 组件在（缺参数的业务信封也是 200）；
  - `405` = 已停用（SPA fallback）；
  - 其它状态与网络异常一律**乐观保留** UI（宁可多一个按钮，也不撤掉正在工作的按钮）。
  探测不阻塞注册、最多退避重试 3 次（400/800/1200ms）。
  - 停用「会话分享」→ 标题栏分享按钮换成隐藏占位 `data-session-share="disabled"`；
  - 停用「失败重试」→ 覆盖层换成隐藏占位 `data-turn-retry="disabled"`。
- `retryHalf` 导出 `RPC_CHANNEL`，探测复用同一个通道名常量（避免字符串写两遍）。
- 两个 UI 贡献的 `inject()` 新增 `hooks: { capability }`。

### 已验证

- 单测 101/101；`node --check client.js` 通过。
- UI 沙箱（tarball 安装）：
  - 三行启用：占位是 `[data-turn-retry="hidden"]`；`diag` 端点返回
    `hasLiveClient=true`、`waitMs=120000`（闸门条件正常，按钮该出现时会出现）；
  - 在 profile patch 里写 `- id: dsh-session-id-retry` + `disabled: true` 并重启：
    修复前同一场景下 `[data-turn-retry="hidden"]`、重试样式表与加载标记**全部还在**
    （复现 bug）；修复后返回 `[data-turn-retry="disabled"]`，按钮不再渲染。

## 2.0.0 — 2026-10-28

**结构性变更**：「一个插件三件事」拆成**三个可单独启停的组件**（三个 Loader 行）。

### 为什么

界面上每个 Loader 行就是一个「组件」，带独立开关。1.x 只有一行，用户只能整体启用/停用
「会话增强」，没法"只留复制 ID、关掉分享和重试"。拆开后「设置 → 插件 → 会话增强 →
包含的组件」显示 **3 个组件**，每个都能单独停用。

### 变更（结构性）

- `cordis.patch.yml` 由 insert 一行改为 **三行**：

  | 行 id | Loader name | 组件 |
  |---|---|---|
  | `dsh-session-id` | `dsh-session-id` | 会话增强（= 会话 ID + 浏览器半） |
  | `dsh-session-id-share` | `dsh-session-id/share` | 会话分享 |
  | `dsh-session-id-retry` | `dsh-session-id/retry` | 失败重试 |

- `index.js` 只保留会话 ID 组件的 Host 半（`session_lookup`）；分享与重试分别搬到
  `share/index.js`、`retry/index.js`。
- `lib/tools.mjs` 拆成 `lib/tools/{lookup,share,schema}.mjs`；`buildTools()` 保留为
  兼容门面（仍一次返回两个工具，行为与 1.x 一致，离线单测零改动）。
- 新增 `lib/build.mjs`：三个组件共用的构建戳。
- 新增 `share/locale/`、`retry/locale/` 与对应 `exports`：组件行的标题/描述来自
  **各自子路径**的 locale——`dsh-app-boot` 的 `readPluginMeta()` 对子路径 specifier
  **不读** `package.json`，只读 `<specifier>/locale/en.json`。
- `exports` 新增 `./share`、`./retry`、`./share/locale/*.json`、`./retry/locale/*.json`、
  `./share/icon`、`./retry/icon`。

### 注意（升级要知道的）

- **浏览器半仍是包级一份**，只能挂在**精确包名**那一行：`dsh-client-modules` 的
  `locatePkgJson()` 对子路径 specifier 直接返回 `undefined`。所以三块界面都挂在第一行
  `dsh-session-id` 上，并因此：
  - 停用「会话分享」→ 分享按钮仍在，点击提示「当前部署没有提供分享服务」；
  - 停用「失败重试」→ 重试覆盖层因 `pending` 调不通而保持隐藏；
  - 停用第一行「会话增强」→ 三块界面一起消失（client 半随该行卸载）。
- 第一行的组件显示名是「会话增强」（与卡片同名），因为它的标题只能来自包根 `locale/`；
  另外两行才叫「会话分享」「失败重试」。
- 从 1.x 升级：`dsh plugin add` 后 patch 自动变三行。旧的 `dsh-turn-retry` 仍需卸载，
  否则会出现两个重试按钮。

### 已验证

- 离线单测 **101/101**（原 97 + 新增 4：三入口形状与 name、各入口注册物、分享存储路径）。
- headless 沙箱真实 Loader：`session_lookup` 与 `session_share` 均可调用（三行都加载成功）。
- UI 沙箱（tarball 安装，非 link）：`dsh-session-id@2.0.0 is loaded: its client half is in
  the page's manifest`；「包含的组件 **共 3 个 · 3 运行中**」，三行标题/描述分别来自包根、
  `share/locale/`、`retry/locale/`；重试覆盖层占位 `[data-turn-retry]` 存在（第三块 UI 注册成功）。
- 拆分经过一次真实返工：最初三行都写成子路径，UI 沙箱直接报 "client half is absent from the
  page's manifest"——这就是上面「精确包名」那条约束的来源。

## 1.0.3 — 2026-10-27

### 变更

- **插件图标改为手绘 SVG，对齐 dsh 官方插件图标的矢量语言**（36×36、透明底、官方蓝色渐变、
  同一描边与留白）：`icon` 与 `files` 里的 `icon.png` 改回 `icon.svg`，旧 PNG 删除；不涉及任何代码逻辑。

## 1.0.2 — 2026-10-27

### 变更

- **插件图标换成 gpt-image-2.5 生成的 PNG 图标**（256×256，圆角透明）：`icon` 与 `files` 里的
  `icon.svg` 改为 `icon.png`，旧 SVG 删除；不涉及任何代码逻辑。

## 1.0.1 — 2026-10-26

修「点击重试按钮没有生效」。

### 修复

- **失败不再静默**：以前点击重试后，只要 Host 返回失败（或传输层报错），浏览器半就只是把
  按钮藏起来 —— 用户看到的是「按钮消失、什么都没发生」。现在按钮进入明确的失败态
  （`data-turn-retry="failed"`），`title` / `aria-label` 里显示错误码（`NOT_WAITING` /
  `NO_LIVE_AGENT` / `FOLLOWUP_FAILED` …），3 秒后自动隐藏。
- **等待期间定期复查**：以前进入「可重试」状态后前端不再问 Host，而 Host 的闸门有
  120 秒等待上限（超时即删除记录）—— 上限过后按钮仍挂在界面上，点击必然无效。现在
  等待期间每 8 秒复查一次，Host 没有闸门就立即收起按钮（上限 20 次 / 160 秒）。
- **Host 侧 `retry` 端点新增兜底路径**：闸门已超时或被清掉、但用户仍然点了重试时，
  不再直接返回 `NOT_WAITING`，而是用 `agent.followup()` 驱动一次新的 turn（按钮只会
  在「失败挂起」或「停止后可重试」两种状态出现，这两种状态下这一轮都已结束，这是唯一
  还能真的重试的路径）；失败时把真实原因透出给界面，而不是吞掉。

### 已验证

- 离线单测 **97/97**（原 95 + 新增 2：闸门已不在时 followup 兜底成功 / 兜底失败透出
  `NO_LIVE_AGENT`）。
- 说明：重试本身的「原地重发」语义没有变（`{ kind: 'retry' }` 交回 agent-loop）；兜底
  路径只在前端状态与 Host 状态不同步时触发。

## 1.0.0 — 2026-10-26

**合并插件**：「失败重试」（原 `dsh-turn-retry`）并入「会话增强」，一个插件三个组件。

### 变更（结构性）

- **新增组件「失败重试」**：模型调用失败（自动重试耗尽）或用户点停止后，composer 右下角
  官方按钮变成圆形「重试」图标；点击后失败路径在**同一 turn/step 原地重新调用模型**
  （不追加用户消息），停止路径用 `agent.followup()` 驱动新一轮。
  - Host 半：`lib/retry/{host,gate,recovery,rpc,diagnostics}.mjs`；
  - 浏览器半：`conversation.input.overlay` 槽位上的 34×34 覆盖层（IIFE 隔离作用域并入
    `client.js`）；
  - 闸门语义保留：先 `await next()` 问下游自动重试、放弃时不调 `next()`、120 秒等待上限、
    5 秒孤儿保护、非 root Agent / 无活跃客户端 / 已 abort 都不挂起；
  - 重试 RPC 通道保留旧名 `/dsh-turn-retry`（仅插件内部，避免无谓回归）。
- **`dsh-turn-retry` 插件已删除**：本地目录、profile 行与 GitHub 仓库都不再存在。
  升级本插件前请先卸载旧的 `dsh-turn-retry`（`dsh plugin remove dsh-turn-retry`），
  否则会出现两个重试按钮。
- 插件描述/显示名/locale 更新为三组件（会话 ID、会话分享、失败重试）。

### 已验证

- 离线单测 **95/95**：原 47（会话/分享）+ 并入的 48（闸门状态机含孤儿保护、恢复记录 TTL、
  RPC 信封与两条重试路径、`installTurnRetry` mock-ctx 集成）。
- headless 真实 Loader：会话查询/分享失败降级仍通过；重试闸门在无活跃客户端时 fail-closed。
- UI 沙箱真实浏览器：标题栏分享/复制按钮 + 分享对话框全流程仍通过；重试覆盖层在无失败态时
  为 `[data-turn-retry="hidden"]` 隐藏占位（证明第三个组件注册成功），composer 正常。

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
