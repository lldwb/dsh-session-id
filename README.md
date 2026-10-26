# 会话增强 · dsh-session-id

复制会话 ID、按 ID 查看会话与子代理，并把会话分享成**免登录只读链接**。

> 开源（MIT）。仓库地址：<https://github.com/lldwb/dsh-session-id>
>
> 插件显示名是**会话增强**；包名与仓库名保留 `dsh-session-id`（沿用已有安装路径与链接，
> 不改名不会让 `dsh plugin add`、`link:` 依赖或外部引用失效）。

## 三个能力

| 能力 | 在哪 | 提供什么 |
|---|---|---|
| 复制会话 ID | 浏览器半 | 会话标题栏一个复制按钮：把当前会话 id 写进剪贴板并弹 toast |
| 按 ID 查会话 | Host 半工具 `session_lookup` | 标题、工作区、预设、父级链、**全部子代理**、最近消息 |
| 会话分享 | 浏览器半 + Host 半 | 生成免登录只读链接 `/share/<token>`：可复制、打开、下载单文件 HTML、停止分享 |

三部分互相独立：只装 Host 半也能查会话，只装浏览器半也能复制 id。

## 安装

```powershell
git clone https://github.com/lldwb/dsh-session-id.git
cd dsh-session-id
# 装进当前 profile（例如 desktop）
dsh plugin add .
```

也可以直接把本地目录交给 `dsh plugin add <插件目录>`。

零 npm 依赖、零配置、无设置页。装好后刷新页面即可看到按钮；新会话里即可调用工具。

## 用法

### 复制会话 ID

会话标题栏右侧、在「⋯」之前多一个复制图标按钮：

- 点击 → 剪贴板里就是当前会话 id，顶部弹 toast「会话 ID 已复制」；
- 鼠标悬停 → `title` 显示完整 id，用来确认"复制的是哪一个"；
- `navigator.clipboard` 被拒（非安全上下文 / 权限关闭）时自动降级到
  `document.execCommand('copy')`；两条都失败才提示失败，不会静默无反应。

拿到 id 后可以直接贴进任何会话问 Agent，例如"用 session_lookup 看看 `<id>`，它有哪些子代理？"

### `session_lookup`

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 目标会话 id。省略时查调用它的会话本身 |
| `includeMessages` | 否 | `true` | 是否附带最近消息 |
| `messageLimit` | 否 | `10`（上限 200） | 返回多少条最近消息 |

返回内容（结构 + 一段人可读的 markdown 摘要）：

```
session            目标会话：id / 标题 / workspace / 预设 / 角色 / 父会话 / delegationDepth / live / persisted / 是否当前会话
ancestors          已知父级链（由近到远）；血缘不完整时 complete=false 并给出 unresolvedParentId
subagents          全部后代会话，父在前：id / 标题 / depth / parentId / 创建时间 / 状态
messages           最近 N 条人对人消息（user / assistant / 压缩摘要）
inheritedEventCount 种子会话从父会话继承的事件数
```

只读：不创建、不修改、不删除任何会话。

### 会话分享

会话标题栏的**分享按钮**（复制按钮左侧）打开「分享会话」对话框：

- 想分享就点「创建分享链接」→ 得到一个 `http://<host>:<port>/share/<token>` 链接；
- 链接可以「复制」、在浏览器里「打开」、或「下载 HTML」（`?download=1`，存成单文件，
  发给别人直接双击就能看）；
- 「停止分享」两段式确认后立即失效（再访问 404）。

分享页是**只读快照**：标题、创建时间、消息（用户 / 助手 / 压缩摘要）、子代理列表，
不依赖 DSH、不需要登录、不带脚本。它**不展示**会话 id、工作目录、token，也不展示工具
调用参数与结果。

Agent 也能分享：用户明确要求时，工具 `session_share` 支持
`create` / `status` / `revoke` / `list` 四个动作（描述里写明"只有用户明确要求时才调用"）。

#### 支持到什么程度（重要）

| 场景 | 是否支持 |
|---|---|
| 本机浏览器打开分享链接 | ✅ 开箱即用 |
| 局域网其它机器打开 | ✅ 需要把 DSH web 绑到局域网地址：`dsh web --host <局域网IP>`（或部署时配置） |
| 公网分享链接（像 DeepSeek 网页版那样发出去就能看） | ⚠️ 取决于部署：需要反代 / 内网穿透 / 公网地址 + `--public-url`；DSH 本身默认只监听 `127.0.0.1` |
| 完全离线分享 | ✅ 用「下载 HTML」把单文件发出去 |
| 口令保护 / 有效期 / 访问统计 | ❌ 未实现（token 本身即凭据，可随时撤销） |

链接里的根地址来自 `webApp.getAdvertisedUrl()`（部署配置了对外地址时）或本机监听
origin；两者都拿不到时创建会明确报错，而不是给一个打不开的链接。

## 设计说明

### 浏览器半挂在 `conversation.session.header.utilities`

这个槽位由 `@deepseek-ai/dsh-client-ui-conversation` 声明，是会话标题栏右侧那组小按钮
（随附的 Session 导出插件就在同一槽位注册「⋯」）。`list` 槽位按 `order` 升序渲染：
分享按钮 `order: -11`、复制按钮 `order: -10`，因此稳定落在「⋯」左边。

槽位注册包在 `ctx.slots.inject(...)` 里：槽位名属于另一个客户端包，浏览器插件加载顺序
不保证；等槽位声明出来再注册，避免静默不显示。

### 会话 id 从哪来

不存在 `window` 全局变量或 URL 路由里。session scope 的槽位贡献者由 renderer 注入
`binding.key`——也就是会话 id：组件 props 上有 `sessionId`，`inject(sessionId)` 也拿得到。
Host 半的 `execute(args, exec)` 则从 `exec.agent.session.id` 取调用方会话 id。

### 子代理怎么识别

`dsh-session` 的会话头里 `origin` 只允许 `'subagent'`（派生会话），`parentSession` 指父会话。
血缘来自 `ctx.sessionQuery.traceSession(id)`：`target` / `ancestors` / `descendants`（嵌套）。
本插件把 `descendants` 递归拍平成"父在前"的列表并带 `depth`，比嵌套 JSON 更省 token 也更好引用。

### 消息为什么只留三种角色

- `system/message`、`developer/message`：Agent 框架指令（实测一条 system 消息 2700+ 字符），
  说明"Agent 被要求怎么工作"，不是"会话在聊什么"；
- `tool/result`：工具输出本身，概览/分享页里复述没有价值；
- 每轮重新注入的 `Current runtime context.`、`<system-reminder>` 虽以 user 角色落盘，
  同样按前缀过滤——实测 4 条消息里 3 条是这类噪音。

### 分享为什么是"公开路由 + 随机 token"

`connection` 的路由面向已认证的浏览器会话，而分享链接要能被**任何知道链接的人**打开
（DeepSeek 网页版的会话分享也是这个语义）。所以分享页注册在 `dsh-host-webserver` 的
普通 HTTP 路由上（它不认识 harness 认证），安全边界完全落在 token：24 字节
（192 bit）随机、不可枚举、可撤销、每次请求现读日志（撤销即失效，也不在磁盘上多存一份
会话内容）。

创建/查询/撤销这些**有副作用**的接口则走认证通道：`connection.admit(req)` 校验后才会
执行，浏览器半用 `ctx.connection.rpc.call('/dsh-session-id', …)` 调用。

### 存储

`<DSH_HOME>/dsh-session-id/shares.json`，只存 `{ sessionId, createdAt, includeDescendants }`。
原子写（临时文件 + rename）。文件损坏时**拒绝写入并报错**而不是覆盖（避免把用户已有的
分享记录清空）；读取时容忍 UTF-8 BOM（Windows 编辑器常见）。

## 验证记录

| 层 | 内容 | 结果 |
|---|---|---|
| 离线单测 | `node --test`：严格 JSON-Schema 子集、required 覆盖、返回值按自身 schema 自校验、消息过滤、血缘拍平、分享存储（幂等/撤销/持久化/损坏文件/BOM）、HTML 转义（XSS）、分享视图、`session_share` 全流程 | 47/47 通过 |
| headless 沙箱 | 真实 Loader：`session_lookup`（无参数 / 不存在 id）；真实 `subagent` 派生后用工具发现并反查 `role=subagent`、`parentSessionId`；`session_share` 在无 web server 的部署里返回结构化失败 | 通过 |
| web 沙箱（真实 HTTP） | 端到端：RPC `share.create` → 公开页 `GET /share/<token>` **200 / 4.5 KB HTML**（含标题、用户/助手消息、只读徽标）→ `?download=1` 返回 `attachment; filename="dsh-session-share-….html"` → 未知 token **404** → `POST` **405** → `share.revoke` 后再访问 **404**；响应头带严格 CSP | 通过 |
| UI 沙箱 | 真实浏览器：分享按钮可见（在复制按钮左侧）；点击打开「分享会话」对话框；创建后对话框显示真实链接与「复制链接 / 打开链接 / 下载 HTML / 停止分享」；toast「分享链接已创建」；两段式停止后 toast「已停止分享」并回到未分享态；分享期间 `fetch(url)` 200，撤销后同一 url 404 | 通过 |

> 回归里抓到并修掉两个真 bug：一是 `share.create` 拿不到分享地址时先落盘再报错，留下
> 打不开的孤儿记录；二是 `shares.json` 带 UTF-8 BOM 时被当成损坏文件，导致分享功能
> 整个锁死。

## 开发笔记

```
index.js          插件入口：分享存储、RPC、公开路由、工具注册
lib/service.mjs   会话视图折叠（血缘 / 标题 / 消息 / 失败同一形状），可离线单测
lib/tools.mjs     session_lookup + session_share 的参数与输出 schema（手写严格子集）
lib/shareview.mjs 分享页的数据装载（复用 service 的消息折叠）
lib/render.mjs    自包含只读 HTML（转义、CSP、深浅色、打印友好）
lib/shares.mjs    shares.json 存储（原子写、容忍 BOM、损坏不覆盖）
lib/rpc.mjs       认证的创建/查询/撤销通道
lib/public.mjs    免登录的 /share/<token> 只读路由
client.js         浏览器半：手写 ModuleLoader bundle、复制/分享按钮、对话框、toast、i18n
cordis.patch.yml  根作用域 insert 一行（不按 preset 挂载）
```

- **严格 schema 是最大的坑**：第三方插件不能 `import defineTool`，参数与返回值都要手写
  注册表接受的子集。`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个
  字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs`
  就是为了在离线阶段抓这类问题（比真实调用失败便宜得多）。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与
  `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的
  快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **改完必须回归**：`node --test` 看不见"插件没加载 / 槽位没声明 / 返回值过不了校验 / 路由
  被回退吃掉"，得在真实 Loader 与真实浏览器里各跑一遍。分享功能的两个 bug 都是真实
  HTTP/浏览器回归里才暴露的。

## License

MIT，见 [LICENSE](LICENSE)。
