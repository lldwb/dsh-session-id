# 会话增强 · dsh-session-id

**一个插件包，三个可单独启停的组件**：复制会话 ID、会话分享、失败重试。

> 开源（MIT）。仓库地址：<https://github.com/lldwb/dsh-session-id>
>
> 插件显示名是**会话增强**；包名与仓库名保留 `dsh-session-id`（沿用已有安装路径与链接，
> 不改名不会让 `dsh plugin add`、`link:` 依赖或外部引用失效）。
>
> **2.0.0 起拆成三个 Loader 行**：「设置 → 插件 → 会话增强 → 包含的组件」里会看到 3 个
> 组件，每个都有独立开关。1.x 只有一行（三件事捆在一起，只能整体开关）。
>
> **原「失败重试」插件（`dsh-turn-retry`）已于 1.0.0 并入本插件**：它的目录、profile 行与
> GitHub 仓库都已删除。升级时请先卸载旧的 `dsh-turn-retry`，否则会出现两个重试按钮。

## 三个组件

| 组件（界面显示名） | Loader 行 | 提供什么 |
|---|---|---|
| 会话增强 | `dsh-session-id` | 会话标题栏复制按钮 + 工具 `session_lookup`（按 id 查会话与全部子代理） |
| 会话分享 | `dsh-session-id/share` | 标题栏分享按钮 + 工具 `session_share` + 免登录只读页 `/share/<token>` |
| 失败重试 | `dsh-session-id/retry` | composer 的「重试」覆盖层 + `agent/request-error` 闸门 |

> **为什么第一个组件叫「会话增强」而不是「会话 ID」**：浏览器半（三块界面）只能挂在
> **精确包名**那一行上——`@deepseek-ai/dsh-client-modules` 的 `locatePkgJson()` 只接受
> 精确包名，子路径 specifier 直接返回 `undefined`，那一行就不会有 client 半。所以第一行
> 必须是 `dsh-session-id`，它的组件标题只能等于包根 `locale/`（也就是卡片标题「会话增强」）。
> 另外两行是子路径，各自有 `share/locale/`、`retry/locale/`，所以能叫「会话分享」「失败重试」。

三部分互相独立：只装 Host 半也能查会话，只装浏览器半也能复制 id / 分享 / 重试。

### 停用某个组件之后

浏览器半只有一份（`dsh.client` 是包级声明，不能按行拆），所以停用某个组件时：

- 停用**会话分享** → 分享按钮仍在，点击提示「当前部署没有提供分享服务」（Host 侧 RPC 已不存在）；
- 停用**失败重试** → 重试覆盖层因为 `pending` 调不通而保持隐藏，不影响其它按钮；
- 停用**会话增强**（第一行）→ 三块界面随 client 半一起消失，`session_lookup` 也不可用。

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

### 会话 ID

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

#### 分享支持到什么程度（重要）

| 场景 | 是否支持 |
|---|---|
| 本机浏览器打开分享链接 | ✅ 开箱即用 |
| 局域网其它机器打开 | ✅ 需要把 DSH web 绑到局域网地址：`dsh web --host <局域网IP>`（或部署时配置） |
| 公网分享链接（像 DeepSeek 网页版那样发出去就能看） | ⚠️ 取决于部署：需要反代 / 内网穿透 / 公网地址 + `--public-url`；DSH 本身默认只监听 `127.0.0.1` |
| 完全离线分享 | ✅ 用「下载 HTML」把单文件发出去 |
| 口令保护 / 有效期 / 访问统计 | ❌ 未实现（token 本身即凭据，可随时撤销） |

链接里的根地址来自 `webApp.getAdvertisedUrl()`（部署配置了对外地址时）或本机监听
origin；两者都拿不到时创建会明确报错，而不是给一个打不开的链接。

### 失败重试

没有额外的提示条、弹窗或新按钮。**官方那个发送/停止按钮的位置**（composer 卡片右下角）
在下列时刻变成一个圆形「重试」图标（循环箭头）：

| 触发 | 图标提示 | 点击后 |
|---|---|---|
| 模型调用失败（自动重试耗尽） | 「模型调用失败 —— 点击重试」 | `agent-loop` 在**同一 turn / step 重新调用模型**，不产生任何用户消息 |
| 你点了停止 | 「已停止 —— 点击重试」 | Host 用 `agent.followup()` 驱动一次新的 turn（见下方「已知取舍」） |

- 覆盖层是 34×34 正圆、品牌主色，尺寸与位置对齐官方按钮；card 被多行输入/附件撑高时按实际高度重新贴合。
- 点击后图标旋转、按钮置灰；重试会再跑一整轮，期间按钮消失。
- 没有可重试状态时覆盖层不可见，官方按钮原样可用。
- **等待上限 120 秒**：失败挂起后没人点就自动放行，按原有语义让这一轮以错误结束。
- **孤儿保护**：开闸后 5 秒内若没有任何浏览器半来查 `pending`（典型：插件刚装、页面还没刷新），立刻按原生语义结束，不会白等两分钟。
- 状态**按会话各一份**，两个会话互不影响；只在「看起来可能可重试」时才向 Host 查一次，其余时候零请求。
- 等待期间每 8 秒向 Host 复查一次「闸门还在吗」；Host 已经没有闸门时按钮会立即收起，避免「按钮还在但点了没用」。

#### 点了重试却没反应？看按钮上的错误码

以前点击失败会把按钮静默藏起来；现在失败会变成**红色的「重试未生效 (错误码)」**，
3 秒后自动消失。错误码直接告诉你卡在哪：

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `NOT_WAITING` | Host 侧已经没有等待中的闸门（120 秒等待上限已过、Host 重启过） | 1.0.1 起会自动兜底驱动一次新一轮；若仍失败，直接发一句「继续」即可 |
| `NO_LIVE_AGENT` | 这个会话没有活跃 Agent（例如刚重启后打开的历史会话） | 在该会话里随便发一条消息唤醒 Agent，再点重试 |
| `FOLLOWUP_FAILED` | 驱动新一轮时 Agent 内部报错 | 看 DSH 日志里 `followup` 相关错误 |
| `NO_CONNECTION` / `TRANSPORT` | 浏览器半与 Host 的 RPC 通道断了 | 刷新页面；若持续出现，检查 DSH 进程是否还活着 |

**已知取舍**：模型失败后的重试是**原地重发**，历史不变；但用户点「停止」之后这一轮已经
结束，物理上无法原地重试，只能由 Host 用 `agent.followup()` 排一条中性消息
（「上一轮被用户中断。请从中断处继续完成…」）驱动新的一轮 —— 这条消息会进入会话历史，
是 DSH 当前架构下无法回避的代价。

## 设计说明

### 浏览器半的槽位

| 组件 | 槽位 | order |
|---|---|---|
| 分享 | `conversation.session.header.utilities`（标题栏右侧小按钮） | -11 |
| 复制 ID | 同上 | -10 |
| 重试 | `conversation.input.overlay`（composer card 内的绝对定位锚点） | 0 |

标题栏槽位由 `@deepseek-ai/dsh-client-ui-conversation` 声明，`list` 槽位按 `order` 升序
渲染，所以分享/复制稳定落在「⋯」左边。重试按钮放 overlay 槽位是为了**盖住**官方 submit
按钮（`conversation.input.right` 只能"旁边多一个"）。

两处注册都包在 `ctx.slots.inject(...)` 里：槽位名属于另一个客户端包，浏览器插件加载顺序
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

### 重试怎么做到"不追加消息"

`@deepseek-ai/dsh-agent-loop` 在最终失败后会走一个 waterfall：

```js
const action = await this.dispatch.waterfall('agent/request-error', payload, () => Promise.resolve(void 0));
if (action?.kind !== 'retry') throw new LlmError(...);
continue;   // ← 回到同一 turn/step 的模型请求
```

监听器返回 `{ kind: 'retry' }`，loop 就在原地重新 dispatch 模型调用。因为用户点击是异步的，
监听器返回一个**尚未 resolve 的 Promise**把这次失败挂住，点击经 RPC 送回后再放行。

两条关键语义（实测踩过）：

1. **先 `await next()` 问下游**：`agent/request-error` 是每次 attempt 失败都触发的 waterfall，
   DSH 自带自动重试挂在它下游。下游说 `{ kind: 'retry' }` 就放行（自动重试期间不打扰用户）；
   只有下游放弃时这次才是"最终失败"，才挂起等用户。
2. **放弃时不能调用 `next()`**：那等于把决定交回自动重试策略，它会继续重试；直接返回
   `undefined` 才是"让这一轮失败"。

另外只拦"有人能看见"的失败：非 root Agent（子代理）不拦、没有活跃浏览器客户端不拦
（`typertGateway.hasLiveClient()`，探测服务缺失时 fail-closed 不挂起）、`signal` 已 abort 不拦。
闸门有 120 秒上限、孤儿保护 5 秒、插件卸载时全部放行，不会把 Agent 永久卡住。

重试半的浏览器动作通道保留旧通道名 `/dsh-turn-retry`（合并前是独立插件，改名只增加回归
风险），Host 侧同样用 `webServer` prefix 路由 + `connection.admit` 认证。

### 存储

`<DSH_HOME>/dsh-session-id/shares.json`，只存 `{ sessionId, createdAt, includeDescendants }`。
原子写（临时文件 + rename）。文件损坏时**拒绝写入并报错**而不是覆盖（避免把用户已有的
分享记录清空）；读取时容忍 UTF-8 BOM（Windows 编辑器常见）。

## 验证记录

| 层 | 内容 | 结果 |
|---|---|---|
| 离线单测 | `node --test`：严格 JSON-Schema 子集、required 覆盖、返回值自校验、消息过滤、血缘拍平、分享存储（幂等/撤销/持久化/损坏文件/BOM）、HTML 转义、分享视图、`session_share` 全流程；**并入的重试半 48 个用例**（闸门状态机含孤儿保护、恢复记录 TTL、RPC 信封与两条重试路径、mock-ctx 集成） | **95/95 通过** |
| headless 沙箱 | 真实 Loader：`session_lookup`（无参数 / 不存在 id）；真实 `subagent` 派生后反查 `role=subagent`、`parentSessionId`；`session_share` 在无 web server 的部署里返回结构化失败；重试闸门在无活跃客户端时 fail-closed（不挂起） | 通过 |
| web 沙箱（真实 HTTP） | RPC `share.create` → 公开页 200（约 4.5 KB，含消息与只读徽标）→ `?download=1` 返回 `attachment` → 未知 token 404 → `POST` 405 → 撤销后再访问 404；CSP 头存在 | 通过 |
| UI 沙箱 | 真实浏览器：标题栏分享/复制按钮可见；分享对话框创建/复制/停止全流程；重试覆盖层在无失败态时是隐藏占位（注册成功）、composer 区域正常 | 通过 |
| 2.0.0 拆分回归 | 单测 101/101；headless 真实 Loader 两工具均可用；UI 沙箱「设置 → 插件 → 会话增强」显示**包含的组件 共 3 个 · 3 运行中**，三行标题/描述分别来自包根、`share/locale/`、`retry/locale/` | 通过 |

> 0.2.0 回归里抓到并修掉两个真 bug：`share.create` 拿不到地址时先落盘留下孤儿记录；
> `shares.json` 带 UTF-8 BOM 时被当成损坏文件导致分享功能锁死。

## 开发笔记

```
index.js            组件①「会话增强」Host 半：注册 session_lookup（同时是包根导出）
share/index.js      组件②「会话分享」Host 半：session_share + /share 路由 + 分享 RPC
retry/index.js      组件③「失败重试」Host 半：agent/request-error 闸门 + 重试 RPC
locale/             包根词典：卡片标题与组件①的标题/描述（两者共用这一份）
share/locale/       组件②的标题/描述（子路径 specifier 不读包根 package.json）
retry/locale/       组件③的标题/描述
lib/build.mjs       三个组件共用的构建戳
lib/service.mjs     会话视图折叠（血缘 / 标题 / 消息 / 失败同一形状），可离线单测
lib/tools.mjs       聚合门面（buildTools 兼容 1.x）+ re-export 两个构建器
lib/tools/lookup.mjs  session_lookup 的参数与输出 schema（手写严格子集）
lib/tools/share.mjs   session_share 的参数与输出 schema
lib/tools/schema.mjs  两个工具共用的 schema 构造器
lib/shareview.mjs   分享页的数据装载（复用 service 的消息折叠）
lib/render.mjs      自包含只读 HTML（转义、CSP、深浅色、打印友好）
lib/shares.mjs      shares.json 存储（原子写、容忍 BOM、损坏不覆盖）
lib/rpc.mjs         分享的认证 RPC 通道（/dsh-session-id）
lib/public.mjs      免登录的 /share/<token> 只读路由
lib/retry/host.mjs  重试半 Host 侧：agent/request-error 闸门、停止记录、RPC 接线
lib/retry/gate.mjs  重试等待闸门（按会话去重、等待上限、孤儿保护；纯 JS）
lib/retry/recovery.mjs  「停止后可重试」记录（TTL）
lib/retry/rpc.mjs   重试的认证 RPC 通道（/dsh-turn-retry，兼容旧名）
lib/retry/diagnostics.mjs 重试诊断记录（diag 端点）
client.js           浏览器半：三块界面 + 对话框 + toast + i18n（重试半用 IIFE 隔离作用域）
cordis.patch.yml    根作用域 insert 三行（不按 preset 挂载）
test/               分享/会话视图/三入口测试；test/retry/ 是并入的重试半测试
```

- **严格 schema 是最大的坑**：第三方插件不能 `import defineTool`，参数与返回值都要手写
  注册表接受的子集。`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个
  字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs`
  就是为了在离线阶段抓这类问题（比真实调用失败便宜得多）。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与
  `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的
  快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **两个 bundle 合并时用 IIFE 隔离**：重试半与分享/复制半的顶层标识符大量重名
  （`NS` / `en` / `zh` / `SLOT_NAME` / `BUTTON_STYLE` …），把重试半整体包进
  `const retryHalf = (() => { … })();` 比逐个改名安全得多，也保留了它原有的注释与结构。
- **改完必须回归**：`node --test` 看不见"插件没加载 / 槽位没声明 / 返回值过不了校验 / 路由
  被回退吃掉"，得在真实 Loader 与真实浏览器里各跑一遍。
- **浏览器半只能挂在「精确包名」那一行**：`dsh-client-modules` 的 `locatePkgJson()` 对
  `pkg/sub` 这种子路径 specifier 直接返回 `undefined`（`exactPackageSpecifier` 不认），
  于是该行没有 client 半。2.0 拆三行时第一行因此必须写 `dsh-session-id`——这也是它的
  组件标题只能等于卡片标题的原因。改 patch 时别把第一行换成子路径，否则界面按钮会整体消失。
- **组件行文案走的是另一套逻辑**：`dsh-app-boot` 的 `readPluginMeta()` 对子路径 specifier
  **不读** `specifier/package.json`，标题/描述只来自 `<specifier>/locale/en.json` 的
  `meta`，并且 `exports` 必须暴露 `<子路径>/locale/*.json`（否则静默回退到裸 specifier）。
- **`node_modules` 形态会决定 client 半是否出现**：以 `link:` 指向**源码目录**安装时，
  client 半可能进不了页面清单；要验证 UI 就用 `pnpm pack` 打成 tarball 再装（真实目录）。

## License

MIT，见 [LICENSE](LICENSE)。
