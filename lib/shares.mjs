/**
 * 分享记录的持久化存储。
 *
 * ## 存什么、不存什么
 *
 * 一条记录只有 `{ sessionId, createdAt, includeDescendants }`，键是随机 token。
 * **不存会话内容**：分享页每次请求都从会话日志现读，所以"停止分享"立刻生效，
 * 也不会在磁盘上多出一份用户对话的副本（那是分享功能最容易做错的地方）。
 *
 * ## 为什么把 token 当键、不另建 id
 *
 * 撤销、查询、下载都只拿得到 URL 里的 token；一个随机 24 字节 base64url 串本身就是
 * 不可猜的凭据（192 bit 熵），不需要第二个 id 去映射。
 *
 * ## 文件
 *
 * `<DSH_HOME>/dsh-session-id/shares.json`，原子写（同目录临时文件 + rename）。
 * 文件损坏时不覆盖它：插件进入"只读失败"状态并把错误交给调用方，避免一次读取
 * 失败就把用户已有的分享记录清空。
 *
 * @module dsh-session-id/lib/shares
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 磁盘格式版本；不兼容变更时递增。 */
export const STORE_VERSION = 1;

/** 合法 token：URL 安全字符，长度 16..64。 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 生成的 token 字节数（base64url 后 32 字符，192 bit 熵）。 */
const TOKEN_BYTES = 24;

/**
 * 解析 DSH_HOME：显式环境变量优先，否则 `~/.dsh`。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量表。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined;
  return explicit === undefined ? path.join(os.homedir(), '.dsh') : path.resolve(explicit);
}

/**
 * 分享记录文件路径。
 *
 * @param {string} dshHome - 已解析的 DSH_HOME。
 * @returns {string} `shares.json` 的绝对路径。
 */
export function sharesFilePath(dshHome) {
  return path.join(dshHome, 'dsh-session-id', 'shares.json');
}

/**
 * 生成一个新 token，必要时重试直到不与现有记录冲突。
 *
 * @param {Record<string, unknown>} shares - 现有记录。
 * @returns {string} URL 安全 token。
 */
export function mintToken(shares) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    if (shares[token] === undefined) return token;
  }
  throw new Error('无法生成唯一的分享 token（连续 8 次冲突），请重试');
}

/**
 * 创建分享存储。
 *
 * @param {{ storeFile: string, now?: () => number }} options - 存储文件与时钟。
 * @returns {any} 存储对象。
 */
export function createShareStore(options) {
  const storeFile = options.storeFile;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {{ version: number, shares: Record<string, any> }} */
  let state = { version: STORE_VERSION, shares: {} };
  let loaded = false;
  /** 读失败时的原始错误：存在时拒绝一切写操作，避免覆盖用户数据。 */
  let loadError = null;

  /** 惰性加载；只执行一次。 */
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let text;
    try {
      text = fs.readFileSync(storeFile, 'utf8');
    } catch (error) {
      if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'ENOENT') return;
      loadError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    let parsed;
    try {
      // 容忍 UTF-8 BOM：Windows 上的编辑器、PowerShell 的 Set-Content、以及从备份
      // 恢复的文件都可能带 `\uFEFF`；JSON.parse 会因此报错，而"文件损坏"的处置
      // 是停止写入——那会把用户的分享功能整个锁死。真实回归里踩到过。
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
    } catch (error) {
      loadError = new Error(`分享记录文件无法解析，已停止写入以免覆盖：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const shares = parsed !== null && typeof parsed === 'object' && parsed.shares !== null && typeof parsed.shares === 'object' ? parsed.shares : {};
    const cleaned = {};
    for (const [token, value] of Object.entries(shares)) {
      if (!TOKEN_PATTERN.test(token)) continue;
      if (value === null || typeof value !== 'object') continue;
      const record = /** @type {any} */ (value);
      if (typeof record.sessionId !== 'string' || record.sessionId === '') continue;
      cleaned[token] = {
        sessionId: record.sessionId,
        createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : now(),
        includeDescendants: record.includeDescendants === true,
      };
    }
    state = { version: STORE_VERSION, shares: cleaned };
  }

  /** 原子写盘；失败抛错（调用方转成用户可见错误）。 */
  function persist() {
    if (loadError !== null) throw loadError;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const temporary = `${storeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, storeFile);
  }

  return {
    /** 记录文件位置（诊断与设置页用）。 */
    storeFile,

    /** 读取失败时返回的错误（未失败为 null）。 */
    error() {
      ensureLoaded();
      return loadError;
    },

    /**
     * 全部记录，最新在前。
     *
     * @returns {Array<{ token: string, sessionId: string, createdAt: number, includeDescendants: boolean }>} 记录。
     */
    list() {
      ensureLoaded();
      return Object.entries(state.shares)
        .map(([token, value]) => ({ token, .../** @type {any} */ (value) }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /**
     * 某个会话的分享记录，最新在前。
     *
     * @param {string} sessionId - 会话 id。
     * @returns {any[]} 记录。
     */
    listForSession(sessionId) {
      return this.list().filter((record) => record.sessionId === sessionId);
    },

    /**
     * 按 token 取一条记录。
     *
     * @param {string} token - URL 里的 token。
     * @returns {any} 记录，或 undefined。
     */
    get(token) {
      ensureLoaded();
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return undefined;
      const record = state.shares[token];
      return record === undefined ? undefined : { token, ...record };
    },

    /**
     * 为一个会话创建分享；同一会话已存在则直接返回已有记录（幂等）。
     *
     * @param {{ sessionId: string, includeDescendants?: boolean }} request - 创建参数。
     * @returns {any} 新记录或既有记录。
     */
    create(request) {
      ensureLoaded();
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
      if (sessionId === '') throw new Error('缺少 sessionId');
      if (loadError !== null) throw loadError;
      const existing = this.listForSession(sessionId)[0];
      if (existing !== undefined) return existing;
      const token = mintToken(state.shares);
      const record = {
        sessionId,
        createdAt: now(),
        includeDescendants: request?.includeDescendants === true,
      };
      state = { version: STORE_VERSION, shares: { ...state.shares, [token]: record } };
      persist();
      return { token, ...record };
    },

    /**
     * 撤销一条分享。
     *
     * @param {string} token - 要撤销的 token。
     * @returns {boolean} 是否真的删掉了一条记录。
     */
    revoke(token) {
      ensureLoaded();
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
      if (state.shares[token] === undefined) return false;
      const next = { ...state.shares };
      delete next[token];
      state = { version: STORE_VERSION, shares: next };
      persist();
      return true;
    },
  };
}
