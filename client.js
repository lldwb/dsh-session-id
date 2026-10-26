/**
 * `dsh-session-id` —— 浏览器半：会话标题栏右上角的「分享会话」与「复制会话 ID」两个按钮。
 *
 * ## 这两个按钮解决什么问题
 *
 * Web GUI 的会话标题栏右侧原本只有「⋯」（下载 Session 日志 / 反馈）。用户有两个高频
 * 但无处安放的诉求：
 *
 * 1. 把当前会话的 id 交给 Agent —— 让 Agent 按 id 查这个会话、它的子代理或它的历史。
 *    标题栏的 crumbs 只显示标题，URL 里也不总是带着 id，所以这里给一个一键复制按钮；
 * 2. 把一个会话只读地分享给别人看（对标 DeepSeek 网页版的会话分享）。分享页本身由
 *    Host 半生成（免登录只读 HTML），浏览器半只负责「生成 / 复制 / 打开 / 下载 / 停止」
 *    这套交互。
 *
 * 两个按钮都挂在同一个 `conversation.session.header.utilities` list 槽位里：分享 order
 * -11、复制 order -10，所以从左到右是「分享、复制、⋯」—— 分享是更重的动作，放在最左。
 *
 * ## 为什么是手写 bundle（而不是构建产物）
 *
 * `dsh.client` 只要求 `exports["./client"]` 解析出一个 JS 文件，DSH 的模块清单会在
 * `/plugins/dsh-session-id/client.js` 上提供它。而 `require` 只能解析 shell 静态模块表
 * 里的两个说明符（见工厂里的注释），所以这里没有 `import`、没有 JSX 语法、没有任何
 * npm 依赖：元素一律用 `jsx`/`jsxs` 工厂函数构造，样式一律内联（CSS 变量 + fallback），
 * 不引任何模块私有 CSS class —— 那些 class 随版本变，且只在浏览器里才会发现它们没了。
 *
 * ## 为什么状态不放在组件里
 *
 * 这个 bundle **拿不到 `react`**（只能 `react/jsx-runtime`），因此没有 `useState`。
 * 所有交互状态（Toast、分享对话框的开合/加载/已分享/错误/两段确认）都由槽位的 `hooks`
 * 注入面承载：本插件在 `inject()` 里为每个 Session 造一个最小的快照源
 * （`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的
 * `useToast(selector)` / `useShare(selector)`；动作里写快照，组件订阅到变化后重渲染。
 *
 * ## 复制为什么有两条路
 *
 * `navigator.clipboard.writeText` 是正路，但它要求安全上下文（HTTPS / localhost）与
 * 剪贴板权限；DSH 有时通过局域网 IP、反向代理或受限的浏览器配置打开，这时它是被拒绝
 * 的（Promise reject，而不是不存在）。所以失败后降级到「隐藏 textarea +
 * `document.execCommand('copy')`」这条老路；两条都失败才把「复制失败」的 Toast 给
 * 用户 —— 悄悄什么都不发生是最坏的体验。分享链接的「复制链接」复用同一条路径。
 *
 * ## 分享为什么走 RPC、停止为什么要两段式
 *
 * 分享的存储、token 与免登录只读页都在 Host 半（浏览器插件拿到不磁盘、也拿不到
 * webServer 的 origin），所以浏览器半只调 `/dsh-session-id` 前缀路由上的
 * `share.status` / `share.create` / `share.revoke`。分享 url 由 Host 拼好返回，
 * 本文件**不拼任何 url**（只有「下载 HTML」按契约追加一个 `download=1` 查询参数）。
 *
 * 「停止分享」是不可撤销的破坏性动作，但 `window.confirm` 会阻塞页面、在自动化验证
 * 里直接卡死，也违反本工作区「不要用 alert/confirm」的约定；所以确认态做在对话框
 * footer 里：第一次点变「确认停止分享」，再点才真正执行，旁边给「取消」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-id',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // shell 的静态模块表里只有这两个说明符可解析（官方设置页 / 随附 Session 导出插件
    // 用的正是这两个）。引别的会抛
    // `client-modules: require("…") missed the module table`，而且只在浏览器里报，
    // 离线单测与 `node --check` 都发现不了。
    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region 词典
    /** 英文文案。 */
    const en = {
      // 复制会话 ID
      'button.copy': 'Copy session ID',
      'toast.copied': 'Session ID copied',
      'toast.copyFailed': 'Could not copy the session ID',

      // 分享会话
      'share.button': 'Share session',
      'share.title': 'Share session',
      'share.close': 'Close',
      'share.cancel': 'Cancel',
      'share.descriptionNew': 'Anyone with the link can view this session read-only.',
      'share.descriptionActive':
        'Anyone with the link can view this session read-only. Stopping the share invalidates the link.',
      'share.loading': 'Reading the share status…',
      'share.emptyBody': 'The link contains the full conversation of this session.',
      'share.create': 'Create share link',
      'share.creating': 'Creating…',
      'share.linkLabel': 'Share link',
      'share.copyLink': 'Copy link',
      'share.openLink': 'Open link',
      'share.downloadHtml': 'Download HTML',
      'share.stop': 'Stop sharing',
      'share.stopConfirm': 'Confirm stop sharing',
      'share.retry': 'Retry',
      'share.unavailable': 'This deployment does not provide session sharing.',
      'share.actionFailed': 'The operation failed.',
      'share.toastCreated': 'Share link created',
      'share.toastCopied': 'Link copied',
      'share.toastRevoked': 'Sharing stopped',
      'share.toastFailed': 'The operation failed.'
    };

    /** 简体中文文案。 */
    const zh = {
      // 复制会话 ID
      'button.copy': '复制会话 ID',
      'toast.copied': '会话 ID 已复制',
      'toast.copyFailed': '复制失败，无法写入剪贴板',

      // 分享会话
      'share.button': '分享会话',
      'share.title': '分享会话',
      'share.close': '关闭',
      'share.cancel': '取消',
      'share.descriptionNew': '任何拿到链接的人都能只读查看这个会话。',
      'share.descriptionActive': '任何拿到链接的人都能只读查看这个会话；停止分享后该链接将失效。',
      'share.loading': '正在读取分享状态…',
      'share.emptyBody': '链接里包含这个会话的完整对话内容。',
      'share.create': '创建分享链接',
      'share.creating': '正在创建…',
      'share.linkLabel': '分享链接',
      'share.copyLink': '复制链接',
      'share.openLink': '打开链接',
      'share.downloadHtml': '下载 HTML',
      'share.stop': '停止分享',
      'share.stopConfirm': '确认停止分享',
      'share.retry': '重试',
      'share.unavailable': '当前部署没有提供分享服务。',
      'share.actionFailed': '操作失败。',
      'share.toastCreated': '分享链接已创建',
      'share.toastCopied': '链接已复制',
      'share.toastRevoked': '已停止分享',
      'share.toastFailed': '操作失败。'
    };
    // #endregion

    // #region 常量
    /**
     * 本插件的词典命名空间。
     *
     * 与 Loader 行 id 同名是刻意的：一个字符串既能当槽位词典键，也便于在开发者工具
     * 里定位。它是 locale 服务里的独立键，不与其他命名空间冲突。
     */
    const NS = 'dsh-session-id';

    /**
     * 槽位名：会话标题栏右侧那组小按钮（「⋯」也在里面）。
     *
     * 这是个 `list` 槽位，我们用自己的 id 并排新增；复用别人的 id 会顶掉别人的按钮。
     */
    const SLOT_NAME = 'conversation.session.header.utilities';

    /** 复制贡献的 id：同槽位里唯一即可。 */
    const COPY_SLOT_ID = 'session-id-copy';

    /**
     * 复制按钮的槽位顺序：排在「⋯」左边。
     *
     * list 槽位按 order 升序渲染。官方「⋯」没有显式 order（等价于 0），所以这里取
     * 负数稳定落在它前面；显式给值而不是留空，是为了不依赖「未声明 order 的贡献按
     * 加载顺序排」这个没写进契约的行为。
     */
    const COPY_SLOT_ORDER = -10;

    /** 分享贡献的 id（`data-session-share` 定位属性与它同源，便于自动化断言）。 */
    const SHARE_SLOT_ID = 'session-share';

    /** 分享按钮的槽位顺序：比复制更小，所以落在复制按钮左侧。 */
    const SHARE_SLOT_ORDER = -11;

    /**
     * Host 半 `lib/rpc.mjs` 注册的前缀路由。
     *
     * 客户端不能 import Host 包，所以这个字符串在这里重复一遍；改名时必须同时改
     * `lib/rpc.mjs` 里的前缀，否则按钮点了只会报「操作失败」。
     */
    const RPC_CHANNEL = '/dsh-session-id';

    /**
     * 图标按钮的样式。
     *
     * 形制对齐官方标题栏按钮（28px 见方、图标 15px、次要文字色），但全部写死在本文件
     * 里：官方那个用的是模块私有 CSS class，随版本变。颜色走 CSS 变量并给 fallback，
     * 深色主题下会跟着外壳的 token 走。
     */
    const BUTTON_STYLE = {
      width: '28px',
      height: '28px',
      minWidth: '28px',
      padding: 0,
      flex: 'none',
      color: 'var(--dsw-alias-label-secondary, currentColor)'
    };

    /** 对话框正文（说明 / 加载 / 空态）。 */
    const DIALOG_TEXT_STYLE = {
      margin: 0,
      fontSize: '13px',
      lineHeight: 1.6,
      color: 'var(--dsw-alias-label-secondary, inherit)'
    };

    /**
     * 对话框里的错误文案。
     *
     * 用主题的 danger 色并带 fallback：拿得到 token 时跟着主题变，拿不到时仍是可读的
     * 红色，而不是「看起来跟正常文案一样」。
     */
    const DIALOG_ERROR_STYLE = {
      ...DIALOG_TEXT_STYLE,
      color: 'var(--dsw-alias-label-danger, #d92d20)'
    };

    /**
     * 分享链接的只读输入框。
     *
     * 用等宽字体：分享链接里 token 很长，等宽更便于用户肉眼比对「复制的是哪一条」；
     * 只读但可聚焦（聚焦时全选，见组件里的 onFocus），这样手快的人可以直接 Ctrl+C。
     */
    const LINK_INPUT_STYLE = {
      width: '100%',
      height: '32px',
      padding: '0 10px',
      boxSizing: 'border-box',
      border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 对话框底部 / 链接操作那一行的布局。 */
    const ACTIONS_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px'
    };
    // #endregion

    // #region 快照源
    /**
     * 一个最小快照源，形状正好是 shell 绑定 hook 所需的
     * `{ getSnapshot, subscribe }`（renderer 内部用它喂 `useSyncExternalStore`）。
     *
     * 不引任何 store 库：本插件只有 Toast 与分享对话框两份小状态，用 `Set` 记订阅者
     * 就是全部。`set`/`update` 在值没变时不通知，避免点击与 `onDone` 之间多余的渲染。
     *
     * `update(mutator)` 用「读-改-写」一次完成，是为了让多个动作（刷新状态与写 Toast）
     * 交叉发生时不会互相覆盖快照里的字段。
     *
     * @param {unknown} initial - 初始快照。
     * @returns {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void, set: (next: any) => void, update: (mutator: (current: any) => any) => void }} 快照源。
     */
    function createSnapshotStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      const publish = (next) => {
        if (Object.is(next, snapshot)) return;
        snapshot = next;
        for (const listener of listeners) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (next) => publish(next),
        update: (mutator) => publish(mutator(snapshot))
      };
    }
    // #endregion

    // #region 剪贴板
    /**
     * 把文本写进剪贴板：现代 API 优先，失败降级到 `execCommand`。
     *
     * 注意两个 API 的失败形态不同：`navigator.clipboard.writeText` 返回 Promise，
     * 权限被拒 / 非安全上下文时是 **reject**（`NotAllowedError`），不是「方法不存在」；
     * 所以必须 `await` 并捕获，而不是只判断方法在不在。`execCommand` 则是同步返回
     * 布尔值，并且在某些浏览器里会抛，两种都要收口成 `false`。
     *
     * @param {string} text - 要复制的文本。
     * @returns {Promise<boolean>} 是否成功写入剪贴板。
     */
    async function writeClipboard(text) {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
        try {
          await clipboard.writeText(text);
          return true;
        } catch {
          // 落到下面的 execCommand 分支：拒绝可能是权限，也可能是策略，两者都还能
          // 用旧 API 试一次。
        }
      }
      return writeClipboardLegacy(text);
    }

    /**
     * 老路：隐藏 textarea + `document.execCommand('copy')`。
     *
     * textarea 必须真的在选择里（`select()`），且要留在文档里才能被复制，所以先挂到
     * `body`、复制完再摘掉。固定在视口外而不是 `display:none`：后者在很多浏览器里
     * 选不中。`try/finally` 保证异常时也不留下垃圾节点。
     *
     * @param {string} text - 要复制的文本。
     * @returns {boolean} 是否成功。
     */
    function writeClipboardLegacy(text) {
      if (typeof document === 'undefined' || document.body === null) return false;
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.setAttribute('aria-hidden', 'true');
      area.tabIndex = -1;
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.left = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      try {
        area.select();
        area.setSelectionRange(0, text.length);
        return document.execCommand('copy') === true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(area);
      }
    }
    // #endregion

    // #region 辅助
    /**
     * 任意抛出值 → 展示文案。
     *
     * RPC 的失败信封是普通对象，网络/传输层错误才是真正的异常；两条路都要能变成一行
     * 给用户看的字。
     *
     * @param {unknown} error - 抛出值。
     * @returns {string} 展示文案。
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    /**
     * 分享链接 + `download=1`。
     *
     * 契约是「同 url 追加 `?download=1`」。这里按 url 里有没有 `?` 选择分隔符：Host 目前
     * 返回的是不带查询串的短链，但一旦以后 url 自己带了参数，硬拼 `?` 会拼出两个问号、
     * Host 收不到 `download` 参数。
     *
     * @param {string} url - Host 返回的分享链接。
     * @returns {string} 下载地址。
     */
    function withDownloadParam(url) {
      const separator = url.indexOf('?') === -1 ? '?' : '&';
      return url + separator + 'download=1';
    }
    // #endregion

    // #region 图标
    /**
     * 复制图标：两张叠放的纸。自绘而不赌 primitives 的图标导出名 —— 图标导出随包名
     * 形如 `IconCopyOutlineRegular`，但那是「可能」，而一个画错的 SVG 是确定的。
     * 用 `currentColor` 描边，颜色由按钮的 `color` 继承。
     *
     * @returns {any} 15×15 的 SVG 元素。
     */
    function copyIcon() {
      return jsxs('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        children: [
          jsx('rect', { x: '5.75', y: '5.75', width: '7.5', height: '7.5', rx: '1.5' }),
          jsx('path', { d: 'M10.25 5.75V3.75a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2' })
        ]
      });
    }

    /**
     * 分享图标：一个方框 + 向上的箭头（「把会话交出去」的通用隐喻，与 iOS/macOS 的
     * 分享图标同形）。同样自绘，理由同上。
     *
     * @returns {any} 15×15 的 SVG 元素。
     */
    function shareIcon() {
      return jsxs('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        children: [
          jsx('path', { d: 'M5.5 6.25H4A1.5 1.5 0 0 0 2.5 7.75v5A1.5 1.5 0 0 0 4 14.25h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6.25h-1.5' }),
          jsx('path', { d: 'M8 10.25V2.25' }),
          jsx('path', { d: 'M5.5 4.75 8 2.25l2.5 2.5' })
        ]
      });
    }
    // #endregion

    // #region 复制按钮
    /**
     * 会话标题栏里的复制按钮。
     *
     * 两个 props 来自两处：`sessionId`、`t` 由槽位按 Session scope 自动注入；
     * `useToast`、`copy`、`dismissToast` 来自本插件 contribution 的 `inject()`。
     *
     * 渲染顺序上先调 `useToast` 再提前返回：hooks 必须在每次渲染时以相同顺序调用，
     * 否则「没有 sessionId」的那次渲染会改变调用顺序，React 会报 hook 顺序错误。
     *
     * Toast 用 `sequence` 当 React key：连续点两次时第二次要在视觉上「重新弹一次」，
     * 复用同一个 Toast 实例的话它可能还停在第一次的动画里。`onDone` 也带上 sequence，
     * 只清掉与当前快照同序号的那条，避免旧 Toast 的结束回调把新 Toast 清掉。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 按钮与（可选的）Toast。
     */
    function SessionIdCopyButton(props) {
      const sessionId = props.sessionId;
      const notice = props.useToast((value) => value);
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return null;

      const id = String(sessionId);
      const toast =
        notice === null
          ? null
          : jsx(
              P.Toast,
              {
                text: notice.text,
                onDone: () => {
                  props.dismissToast(notice.sequence);
                },
                ...(notice.tone === undefined ? {} : { tone: notice.tone })
              },
              notice.sequence
            );

      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Button, {
            size: 'sm',
            style: BUTTON_STYLE,
            // title 给完整 id：按钮只有图标，用户想确认「复制的是哪一个」时 hover 就能看，
            // 不必先点一次再去别处对照。
            title: id,
            'aria-label': props.t('button.copy'),
            'data-session-id-copy': '',
            onClick: () => {
              props.copy();
            },
            children: copyIcon()
          }),
          toast
        ]
      });
    }
    // #endregion

    // #region 分享按钮与对话框
    /**
     * 分享对话框的初始快照。
     *
     * `open` 是对话框开关；`loading` 是首屏拉 `share.status`；`busy` 是创建/停止这类
     * 写操作进行中；`share` 是当前分享（Host 返回的 `{token,url,…}` 或 null）；
     * `error` 是展示用错误；`confirmRevoke` 是「停止分享」的两段式确认态；
     * `notice` 是 Toast（`{text,tone,sequence}`）。
     */
    const SHARE_INITIAL = {
      open: false,
      loading: false,
      busy: false,
      share: null,
      error: '',
      confirmRevoke: false,
      notice: null
    };

    /**
     * 对话框按钮的内联样式。
     *
     * 用原生 `button` 而不是 `P.Button`：这里需要三种明确的语义色（主操作 / 危险 /
     * 次要），而 primitives 按钮的 variant 取值集合没有写进可依赖的契约；内联样式可以
     * 精确控制，也避免依赖模块私有 CSS class。
     *
     * @param {'primary'|'danger'|'secondary'} variant - 变体。
     * @param {boolean} disabled - 是否禁用。
     * @returns {Record<string, any>} 内联样式。
     */
    function dialogButtonStyle(variant, disabled) {
      const base = {
        height: '32px',
        padding: '0 14px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
      if (variant === 'primary') {
        return {
          ...base,
          border: 'none',
          background: 'var(--dsw-alias-brand-primary, #ff5a1f)',
          color: '#ffffff'
        };
      }
      if (variant === 'danger') {
        return {
          ...base,
          border: '0.5px solid currentColor',
          background: 'transparent',
          color: 'var(--dsw-alias-label-danger, #d92d20)'
        };
      }
      return {
        ...base,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)'
      };
    }

    /**
     * 一个对话框按钮。
     *
     * `id` 同时用作 React key 与 `data-share-action`：CSS 选择器没法按文本定位，自动化
     * 验证（以及将来别的 UI 测试）需要稳定的钩子；用同一份 id 也避免两处字符串漂移。
     *
     * @param {string} id - React key + `data-share-action` 值。
     * @param {string} label - 文案（已本地化）。
     * @param {'primary'|'danger'|'secondary'} variant - 变体。
     * @param {boolean} disabled - 是否禁用。
     * @param {() => void} onClick - 点击动作。
     * @returns {any} 元素。
     */
    function dialogButton(id, label, variant, disabled, onClick) {
      return jsx(
        'button',
        {
          type: 'button',
          'data-share-action': id,
          disabled,
          onClick: () => {
            onClick();
          },
          style: dialogButtonStyle(variant, disabled),
          children: label
        },
        id
      );
    }

    /**
     * 对话框正文：加载中 / 错误 / 未分享 / 已分享四种形态。
     *
     * 已分享时把 url 放进只读输入框（而不是纯文本）：用户可以聚焦后 Ctrl+C，也可以
     * 用浏览器的「复制」菜单；旁边再给显式的「复制链接」按钮，因为输入框全选这件事
     * 不是所有人都知道。
     *
     * @param {any} state - 分享快照。
     * @param {any} actions - 对话框动作（来自 inject）。
     * @param {(key: string) => string} t - 词典读取器。
     * @returns {any} 元素或 null。
     */
    function shareDialogBody(state, actions, t) {
      if (state.loading) {
        return jsx('p', { style: DIALOG_TEXT_STYLE, role: 'status', children: t('share.loading') });
      }
      if (state.error !== '') {
        return jsx('p', { style: DIALOG_ERROR_STYLE, role: 'alert', children: state.error });
      }
      if (state.share === null) {
        return jsx('p', { style: DIALOG_TEXT_STYLE, children: t('share.emptyBody') });
      }
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        children: [
          jsx(
            'input',
            {
              type: 'text',
              readOnly: true,
              value: state.share.url,
              'aria-label': t('share.linkLabel'),
              // 测试与用户都靠它确认「这是链接输入框」，而不是同一个对话框里的其它文本。
              'data-share-url': '',
              spellCheck: false,
              onFocus: (event) => {
                event.target.select();
              },
              style: LINK_INPUT_STYLE
            },
            'share-url'
          ),
          jsxs(
            'div',
            {
              style: { ...ACTIONS_STYLE, justifyContent: 'flex-start' },
              children: [
                dialogButton('copy-link', t('share.copyLink'), 'secondary', state.busy, actions.copyLink),
                dialogButton('open-link', t('share.openLink'), 'secondary', state.busy, actions.openLink),
                dialogButton('download-html', t('share.downloadHtml'), 'secondary', state.busy, actions.downloadHtml)
              ]
            },
            'share-link-actions'
          )
        ]
      });
    }

    /**
     * 对话框底部：按状态给主操作。
     *
     * 关闭对话框不在这里放按钮 —— Modal 自带右上角关闭（`closeLabel`）与点遮罩关闭，
     * 同屏再放一个「关闭」只会制造两个同名控件，让自动化断言与用户都分不清点哪个。
     *
     * @param {any} state - 分享快照。
     * @param {any} actions - 对话框动作（来自 inject）。
     * @param {(key: string) => string} t - 词典读取器。
     * @returns {any} 元素或 undefined。
     */
    function shareDialogFooter(state, actions, t) {
      const buttons = [];
      if (state.loading) {
        // 加载中只允许关掉对话框；没有可执行的动作。
      } else if (state.error !== '') {
        buttons.push(dialogButton('retry', t('share.retry'), 'primary', false, actions.retry));
      } else if (state.share === null) {
        buttons.push(
          dialogButton(
            'create',
            state.busy ? t('share.creating') : t('share.create'),
            'primary',
            state.busy,
            actions.createShare
          )
        );
      } else if (state.confirmRevoke) {
        buttons.push(dialogButton('confirm-revoke', t('share.stopConfirm'), 'danger', state.busy, actions.revokeNow));
        buttons.push(dialogButton('cancel-revoke', t('share.cancel'), 'secondary', state.busy, actions.cancelRevoke));
      } else {
        buttons.push(dialogButton('stop', t('share.stop'), 'danger', state.busy, actions.requestRevoke));
      }
      if (buttons.length === 0) return undefined;
      return jsx('div', { style: ACTIONS_STYLE, children: buttons });
    }

    /**
     * 会话标题栏里的分享按钮与其对话框。
     *
     * 与复制按钮同构：`sessionId`、`t` 由槽位注入，`useShare` 与全部动作来自本插件
     * contribution 的 `inject()`。`useShare` 必须在提前返回之前调用（hooks 顺序）。
     *
     * 对话框在 `open` 为假时仍然被构造（只是 Modal 不渲染 portal），所以关闭时保留的
     * `share` 会留在快照里；再次打开时 `openShare()` 会重新拉一次 `share.status`，
     * 因此不会显示过期链接。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 按钮、Toast 与对话框。
     */
    function SessionShareButton(props) {
      const sessionId = props.sessionId;
      const state = props.useShare((value) => value);
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return null;

      const t = props.t;
      const actions = {
        createShare: props.createShare,
        copyLink: props.copyLink,
        openLink: props.openLink,
        downloadHtml: props.downloadHtml,
        requestRevoke: props.requestRevoke,
        cancelRevoke: props.cancelRevoke,
        revokeNow: props.revokeNow,
        retry: props.retry
      };
      const toast =
        state.notice === null
          ? null
          : jsx(
              P.Toast,
              {
                text: state.notice.text,
                onDone: () => {
                  props.dismissNotice(state.notice.sequence);
                },
                ...(state.notice.tone === undefined ? {} : { tone: state.notice.tone })
              },
              state.notice.sequence
            );

      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Button, {
            size: 'sm',
            style: BUTTON_STYLE,
            title: t('share.button'),
            'aria-label': t('share.button'),
            'data-session-share': '',
            onClick: () => {
              props.openShare();
            },
            children: shareIcon()
          }),
          toast,
          jsx(
            P.Modal,
            {
              open: state.open,
              title: t('share.title'),
              description: state.share === null ? t('share.descriptionNew') : t('share.descriptionActive'),
              closeLabel: t('share.close'),
              onClose: () => {
                props.closeShare();
              },
              footer: shareDialogFooter(state, actions, t),
              children: shareDialogBody(state, actions, t)
            },
            'share-dialog'
          )
        ]
      });
    }
    // #endregion

    // #region 插件入口
    /**
     * 浏览器半用到的服务：槽位（挂按钮）、词典、以及到 Host 的 RPC 通道。
     *
     * `connection` 是 RPC carrier（与其他调用宿主服务的 UI 插件用法一致）；不带它时
     * 分享按钮会一直停在「操作失败」，所以这里是硬依赖。
     */
    const inject = ['slots', 'locale', 'connection'];

    /**
     * 挂载两个按钮，并把分享对话框的全部状态与动作绑到各自的 Session。
     *
     * 注册包在 `ctx.slots.inject(SLOT_NAME, …)` 里，而不是裸 `ctx.slots.register`：
     * 槽位名属于 `@deepseek-ai/dsh-client-ui-conversation`，浏览器插件之间的加载顺序
     * 不保证。`slots.inject` 等该槽位被声明出来后才回调注册（随附的 Session 导出插件
     * 与官方反馈插件用的都是同一写法），否则注册可能落在一个还不存在的槽位上、静默
     * 不显示。
     *
     * 每个 Session 各有一份 `inject()` 结果（renderer 按 entry × 会话缓存），所以
     * Toast / 分享快照天然是「每个会话一个」—— 两个会话同时打开时，点其中一个的按钮
     * 不会让另一个的标题栏也弹 Toast 或打开对话框。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-id: 词典');

      // 连续点击时让每条 Toast 都有新序号（key 变化 → 重新挂载 → 重新播放动画）。
      let nextSequence = 1;

      /**
       * 调 Host 半的分享 RPC，并把两种失败形态收口成一个异常。
       *
       * 成功信封是 `{ ok:true, value }`，业务失败是 `{ ok:false, error:{code,message} }`；
       * 只有传输层错误才会让 `call` 自己抛。这里把三者统一成 `Error`，调用方只需
       * `try/catch` 一处，并用 `messageOf` 取出可展示的文案。
       *
       * @param {string} method - `share.status` / `share.create` / `share.revoke`。
       * @param {Record<string, any>} payload - 方法参数。
       * @returns {Promise<any>} 成功时的 `value`。
       * @throws {Error} 传输层错误、业务失败或未提供 RPC 通道。
       */
      async function callRpc(method, payload) {
        const connection = ctx.connection;
        const rpc = connection === undefined || connection === null ? undefined : connection.rpc;
        if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
          throw new Error(t('share.unavailable'));
        }
        const result = await rpc.call(RPC_CHANNEL, method, payload);
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        const error = result !== null && typeof result === 'object' ? result.error : undefined;
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
        const message =
          error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
        if (message !== '' && code !== '') throw new Error(message + '（' + code + '）');
        if (message !== '') throw new Error(message);
        if (code !== '') throw new Error(code);
        throw new Error(t('share.actionFailed'));
      }

      // ---- 复制会话 ID：原有贡献，行为不变 ----
      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: COPY_SLOT_ID,
            order: COPY_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const store = createSnapshotStore(null);
              const id = String(sessionId === undefined || sessionId === null ? '' : sessionId);
              return {
                hooks: { toast: store },
                copy: () => {
                  if (id === '') return;
                  void writeClipboard(id).then((ok) => {
                    store.set({
                      tone: ok ? 'success' : undefined,
                      text: ok ? t('toast.copied') : t('toast.copyFailed'),
                      sequence: nextSequence++
                    });
                  });
                },
                // 只在序号仍然匹配时清空：Toast 自己也会超时调 onDone，那时用户可能
                // 已经点了第二次，不该把新的那条一起清掉。
                dismissToast: (sequence) => {
                  const current = store.getSnapshot();
                  if (current !== null && current.sequence === sequence) store.set(null);
                }
              };
            }
          },
          SessionIdCopyButton
        )
      );

      // ---- 分享会话：新增贡献 ----
      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: SHARE_SLOT_ID,
            order: SHARE_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const id = String(sessionId === undefined || sessionId === null ? '' : sessionId);
              const store = createSnapshotStore(SHARE_INITIAL);
              // 每个会话一份 Toast 序号，连续操作不会吞掉前一条的动画。
              let sequence = 1;

              /** 合并快照；每次都是新对象，订阅者才会重渲染。 */
              const patch = (partial) => {
                store.update((current) => ({ ...current, ...partial }));
              };

              /** 写一条 Toast；tone 为 undefined 时用中性样式（失败场景）。 */
              const notify = (text, tone) => {
                patch({ notice: { text, tone, sequence: sequence++ } });
              };

              /**
               * 重新拉一次分享状态。
               *
               * 不重置 `open`：用户可能在请求返回前就关掉了对话框，那时不该把对话框
               * 再打开（也不该把状态清掉——关闭后状态保留是契约）。
               */
              const refresh = async () => {
                patch({ loading: true, error: '', confirmRevoke: false });
                try {
                  const value = await callRpc('share.status', { sessionId: id });
                  const shares =
                    value !== null && typeof value === 'object' && Array.isArray(value.shares) ? value.shares : [];
                  patch({ loading: false, share: shares.length > 0 ? shares[0] : null });
                } catch (error) {
                  patch({ loading: false, error: messageOf(error) });
                }
              };

              return {
                hooks: { share: store },
                openShare: () => {
                  if (id === '') return;
                  patch({ open: true });
                  void refresh();
                },
                // 关闭只收起对话框、清掉两段确认；已分享的链接留在快照里（契约要求
                // 「关闭后状态保留」），再次打开时 refresh 会用 Host 的最新状态覆盖它。
                closeShare: () => {
                  patch({ open: false, confirmRevoke: false });
                },
                retry: () => {
                  void refresh();
                },
                createShare: async () => {
                  patch({ busy: true, error: '', confirmRevoke: false });
                  try {
                    const value = await callRpc('share.create', { sessionId: id });
                    const share = value !== null && typeof value === 'object' ? value.share : undefined;
                    if (share === undefined || share === null || typeof share !== 'object') {
                      throw new Error(t('share.actionFailed'));
                    }
                    patch({ busy: false, share });
                    notify(t('share.toastCreated'), 'success');
                  } catch (error) {
                    patch({ busy: false, error: messageOf(error) });
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                copyLink: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  void writeClipboard(current.share.url).then((ok) => {
                    notify(ok ? t('share.toastCopied') : t('toast.copyFailed'), ok ? 'success' : undefined);
                  });
                },
                openLink: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  // `noopener`：分享页是 Host 提供的独立页面，不需要拿到本页的 window。
                  // 浏览器拦截弹窗时返回 null，但不算失败（用户仍可手动复制链接）。
                  try {
                    window.open(current.share.url, '_blank', 'noopener');
                  } catch {
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                downloadHtml: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  try {
                    // 用 anchor 而不是 window.open：Host 用 Content-Disposition 让浏览器
                    // 直接下载，导航式点击不会留下一个空白标签页。
                    const anchor = document.createElement('a');
                    anchor.href = withDownloadParam(current.share.url);
                    anchor.rel = 'noopener';
                    document.body.appendChild(anchor);
                    anchor.click();
                    document.body.removeChild(anchor);
                  } catch {
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                // 两段式：第一次只切到确认态，第二次才真的调 revoke。
                requestRevoke: () => {
                  patch({ confirmRevoke: true });
                },
                cancelRevoke: () => {
                  patch({ confirmRevoke: false });
                },
                revokeNow: async () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  patch({ busy: true, error: '' });
                  try {
                    await callRpc('share.revoke', { token: current.share.token });
                    patch({ busy: false, share: null, confirmRevoke: false });
                    notify(t('share.toastRevoked'), 'success');
                  } catch (error) {
                    patch({ busy: false, confirmRevoke: false, error: messageOf(error) });
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                dismissNotice: (value) => {
                  const current = store.getSnapshot();
                  if (current.notice !== null && current.notice.sequence === value) patch({ notice: null });
                }
              };
            }
          },
          SessionShareButton
        )
      );
    }
    // #endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
