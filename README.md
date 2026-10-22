# dsh-session-id

复制当前会话的 ID，并让 Agent 按 ID 查找任意会话及其子代理。

> 开源（MIT）。仓库地址：<https://github.com/lldwb/dsh-session-id>

## 解决什么

DSH Web GUI 的会话标题栏右上角只有一个「⋯」菜单（下载 Session 日志 / 反馈）。当你
想把某个会话交给 Agent 处理时——"看看这个会话在聊什么""那个会话派生了哪些子代理"
——却没有地方能一键拿到会话 id，Agent 拿到 id 后也没有工具能定位那个会话。

本插件补上这两半：

| 半 | 提供什么 |
|---|---|
| 浏览器半 | 会话标题栏「⋯」左边多一个**复制会话 ID**按钮，点击把当前会话 id 写进剪贴板并弹 toast |
| Host 半 | 新工具 **`session_lookup`**：按会话 id 返回标题、工作区、预设、父级链、**全部子代理**与最近消息 |

两者可以独立工作：不装浏览器半，工具照样能用在别的部署；不装 Host 半，按钮照样能复制 id。

## 安装

```powershell
git clone https://github.com/lldwb/dsh-session-id.git
cd dsh-session-id
# 装进当前 profile（例如 desktop）
dsh plugin add .
```

也可以直接把本地目录交给 `dsh plugin add <插件目录>`。

零 npm 依赖、零配置、无设置页：安装后刷新页面即可看到按钮，新会话里即可调用工具。

## 用法

### 复制会话 ID

会话标题栏右侧，在「⋯」之前多一个复制图标按钮：

- 点击 → 剪贴板里就是当前会话 id，顶部弹 toast「会话 ID 已复制」；
- 鼠标悬停 → `title` 显示完整 id，用来确认"复制的是哪一个"；
- `navigator.clipboard` 被拒（非安全上下文 / 权限关闭）时自动降级到
  `document.execCommand('copy')`；两条都失败才提示失败，不会静默无反应。

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

典型对话：

> **你**：点复制按钮拿到某个会话的 id，贴进另一个会话：
> "用 session_lookup 看看 `<id>` 这个会话，它有哪些子代理？"
>
> **Agent**：返回会话标题、工作区、1 个直接子代理（depth 1）与最近消息；再按子代理的
> id 调一次就能看它自己的内容。

只读：不创建、不修改、不删除任何会话。

## 设计说明

### 为什么挂在 `conversation.session.header.utilities`

这个槽位由 `@deepseek-ai/dsh-client-ui-conversation` 声明，是会话标题栏右侧那组小按钮
（随附的 Session 导出插件就在同一槽位注册「⋯」）。`list` 槽位按 `order` 升序渲染，
本插件取 `order: -10`，稳定落在「⋯」左边。

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
- `tool/result`：工具输出本身，概览里复述没有价值；
- 每轮重新注入的 `Current runtime context.`、`<system-reminder>` 虽以 user 角色落盘，
  同样按前缀过滤——实测 4 条消息里 3 条是这类噪音。

结果：一次查询的消息开销从"几乎全是噪音"降到"大约是真正的人话"（默认 10 条 × 单条 800 字符上限）。

### 边界与安全

- **跨工作区不阻断，但可见**：目标会话的 `workspace` 与"是否当前会话"都会出现在返回里。
  会话 id 由用户主动复制并交给 Agent，视为用户的明确授权；本机单用户场景下这比
  "cwd 字符串相等才允许"更符合实际用途。部署若需要更严格策略，可在 Host 半的
  `lookupSession` 前加一层 `filterSessions` 授权（参考 `dsh-tool-session-query` 的做法）。
- **`sessionQuery` 是软依赖**：部署没挂查询服务时工具返回一条说明，插件本身照常加载。
- **Host 半只读**：所有服务调用都是查询接口。

## 验证记录

| 层 | 内容 | 结果 |
|---|---|---|
| 离线单测 | `node --test`：严格 JSON-Schema 子集、required 覆盖、返回值按自身 schema 校验、消息过滤、血缘拍平、失败分支 | 28/28 通过 |
| headless 沙箱 | 真实 Loader 安装后调用 `session_lookup`（无参数 / 不存在 id）；再真的 `subagent` 派生一个子代理，用工具发现它并用子代理 id 反查 `role=subagent`、`parentSessionId` | 通过 |
| UI 沙箱 | 无头 Chrome 打开沙箱 Web GUI：插件进入页面清单、控制台 0 错误；按钮 28×28 可见于「⋯」左侧、真实点击后 toast「会话 ID 已复制」；强制剪贴板失败时显示失败文案 | 通过 |

## 开发笔记

```
index.js          插件入口：注册工具、构建戳
lib/service.mjs   会话视图折叠（血缘 / 标题 / 消息 / 失败同一形状），可离线单测
lib/tools.mjs     session_lookup 的参数与输出 schema（手写严格子集）
client.js         浏览器半：手写 ModuleLoader bundle、复制按钮、toast、i18n
cordis.patch.yml  根作用域 insert 一行（不按 preset 挂载）
```

- **严格 schema 是最大的坑**：第三方插件不能 `import defineTool`，参数与返回值都要手写
  注册表接受的子集。`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个
  字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs`
  就是为了在离线阶段抓这类问题（比真实调用失败便宜得多）。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与
  `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的
  快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **改完必须回归**：`node --test` 看不见"插件没加载 / 槽位没声明 / 返回值过不了校验"，
  得在真实 Loader 与真实浏览器里各跑一遍。

## License

MIT，见 [LICENSE](LICENSE)。
