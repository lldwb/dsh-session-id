/**
 * 分享功能的离线测试：存储、渲染、视图装载、公开路由解析、`session_share` 工具。
 *
 * 全部用临时目录与假 `sessionQuery`，不碰真实 DSH_HOME、不监听端口——真实路由与
 * 页面在 devkit 沙箱回归里验证。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createShareStore, mintToken, sharesFilePath, TOKEN_PATTERN } from '../lib/shares.mjs';
import { escapeHtml, formatTime, renderErrorDocument, renderShareDocument, SHARE_MESSAGE_LIMIT } from '../lib/render.mjs';
import { loadShareView } from '../lib/shareview.mjs';
import { tokenFromPath } from '../lib/public.mjs';
import { presentShare } from '../lib/rpc.mjs';
import { buildTools } from '../lib/tools.mjs';
import { validateSchemaNode, validateValue } from './strict-schema.mjs';

/** 建一个临时目录。 */
function temporaryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-id-test-'));
}

/** 一个已存在会话的假查询服务。 */
function fakeQuery() {
  return {
    async traceSession(sessionId) {
      if (sessionId !== 'session-ok') {
        const error = new Error('not found');
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      return {
        target: {
          header: { id: 'session-ok', createdAt: 1_700_000_000_000, cwd: 'E:\\secret-workspace', isSeeded: false },
          live: true,
          persisted: true,
        },
        ancestors: [],
        descendants: [
          {
            session: { header: { id: 'child-1', createdAt: 1_700_000_100_000, parentSession: 'session-ok', origin: 'subagent', isSeeded: true }, live: false, persisted: true },
            descendants: [],
          },
        ],
        complete: true,
      };
    },
    async readTitleSnapshots(ids) {
      const titles = { 'session-ok': '会话增强：分享功能', 'child-1': '子代理：写测试' };
      return ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { session: { id: sessionId }, ...(titles[sessionId] === undefined ? {} : { title: titles[sessionId] }) } }));
    },
    async readSurface() {
      return {
        inheritedEventCount: 0,
        events: [
          { seq: 1, type: 'user/message', time: 1_700_000_200_000, data: { content: [{ type: 'text', text: '帮我加一个分享功能，参考官方网页。' }] } },
          { seq: 2, type: 'assistant/message', time: 1_700_000_300_000, data: { message: { content: [{ type: 'text', text: '好的：<script>alert(1)</script> 会被转义。' }] } } },
          { seq: 3, type: 'tool/result', time: 1_700_000_400_000, data: { message: { content: [{ type: 'text', text: '不应出现' }] } } },
        ],
      };
    },
  };
}

test('mintToken 生成 URL 安全 token 且避开已有键', () => {
  const token = mintToken({});
  assert.match(token, TOKEN_PATTERN);
  assert.equal(token.length, 32);
  // 连续占用前 8 次也不应抛错（每次重新随机）。
  const shares = {};
  for (let index = 0; index < 5; index += 1) shares[mintToken(shares)] = { sessionId: 'x' };
  assert.equal(Object.keys(shares).length, 5);
});

test('TOKEN_PATTERN 拒绝路径穿越与短 token', () => {
  assert.equal(TOKEN_PATTERN.test('abcdefghijklmnop'), true);
  assert.equal(TOKEN_PATTERN.test('../etc/passwd'), false);
  assert.equal(TOKEN_PATTERN.test('short'), false);
  assert.equal(TOKEN_PATTERN.test('a/b'), false);
});

test('createShareStore：创建幂等、查询、撤销、持久化往返', () => {
  const dir = temporaryDir();
  const storeFile = sharesFilePath(dir);
  try {
    const store = createShareStore({ storeFile });
    const first = store.create({ sessionId: 'session-ok', includeDescendants: true });
    const second = store.create({ sessionId: 'session-ok' });
    assert.equal(first.token, second.token, '同一会话应返回同一条分享');
    assert.equal(store.listForSession('session-ok').length, 1);
    assert.match(store.get(first.token).sessionId, /session-ok/);

    // 重新打开：记录应还在。
    const reopened = createShareStore({ storeFile });
    assert.equal(reopened.get(first.token).sessionId, 'session-ok');
    assert.equal(reopened.list().length, 1);

    // 撤销后立即失效，且落盘。
    assert.equal(store.revoke(first.token), true);
    assert.equal(store.get(first.token), undefined);
    assert.equal(createShareStore({ storeFile }).get(first.token), undefined);
    assert.equal(store.revoke(first.token), false, '重复撤销返回 false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createShareStore：带 UTF-8 BOM 的文件仍可读（Windows 编辑器常见）', () => {
  const dir = temporaryDir();
  const storeFile = sharesFilePath(dir);
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const body = JSON.stringify({ version: 1, shares: { 'bomtoken0123456789abcdef': { sessionId: 'session-ok', createdAt: 1, includeDescendants: false } } });
    fs.writeFileSync(storeFile, `\uFEFF${body}`, 'utf8');
    const store = createShareStore({ storeFile });
    assert.equal(store.error(), null);
    assert.equal(store.get('bomtoken0123456789abcdef').sessionId, 'session-ok');
    // 还能继续写入。
    assert.doesNotThrow(() => store.create({ sessionId: 'session-ok' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createShareStore：损坏的文件不被覆盖', () => {
  const dir = temporaryDir();
  const storeFile = sharesFilePath(dir);
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, '{ not json', 'utf8');
    const store = createShareStore({ storeFile });
    assert.ok(store.error() instanceof Error);
    assert.throws(() => store.create({ sessionId: 'session-ok' }));
    // 原文件必须原样保留。
    assert.equal(fs.readFileSync(storeFile, 'utf8'), '{ not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createShareStore：忽略非法 token 与残缺记录', () => {
  const dir = temporaryDir();
  const storeFile = sharesFilePath(dir);
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(
      storeFile,
      JSON.stringify({
        version: 1,
        shares: {
          'valid-token-abcdefghijkl': { sessionId: 'session-ok', createdAt: 1, includeDescendants: true },
          '../evil': { sessionId: 'session-ok', createdAt: 1 },
          'short': { sessionId: 'session-ok', createdAt: 1 },
          'another-valid-token-abcdefgh': { createdAt: 1 },
        },
      }),
      'utf8',
    );
    const store = createShareStore({ storeFile });
    assert.deepEqual(store.list().map((record) => record.token), ['valid-token-abcdefghijkl']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('escapeHtml 转义全部危险字符', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("a&b'c"), 'a&amp;b&#39;c');
  assert.equal(escapeHtml(null), '');
});

test('formatTime 只在合法时间戳上产出内容', () => {
  assert.match(formatTime(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatTime(undefined), '');
  assert.equal(formatTime(Number.NaN), '');
});

test('renderShareDocument：转义内容、不含会话 id / cwd / 工具结果', () => {
  const html = renderShareDocument({
    title: '<img src=x onerror=alert(1)>',
    createdAt: 1_700_000_000_000,
    messages: [
      { role: 'user', text: '你好 <b>世界</b>', time: '2026-10-26T01:00:00.000Z' },
      { role: 'assistant', text: 'x'.repeat(SHARE_MESSAGE_LIMIT + 10), time: '2026-10-26T01:01:00.000Z' },
    ],
    subagents: [{ title: '子代理：写测试', depth: 1, createdAt: 1_700_000_100_000 }],
    sharedAt: 1_700_000_500_000,
  });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /你好 &lt;b&gt;世界&lt;\/b&gt;/);
  assert.match(html, /内容过长，已截断/);
  assert.match(html, /子代理/);
  assert.match(html, /只读分享/);
  assert.equal(html.includes('session-ok'), false, '不能泄漏会话 id');
  assert.equal(html.includes('secret-workspace'), false, '不能泄漏 cwd');
  assert.equal(html.includes('不应出现'), false, '工具结果不应进入分享页');
});

test('renderErrorDocument 不回显内部细节', () => {
  const html = renderErrorDocument(404, '分享不存在或已失效');
  assert.match(html, /404/);
  assert.match(html, /分享不存在或已失效/);
});

test('tokenFromPath 只接受 /share/<token>', () => {
  assert.equal(tokenFromPath('/share/abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.equal(tokenFromPath('/share/'), null);
  assert.equal(tokenFromPath('/share'), null);
  assert.equal(tokenFromPath('/share/a/b'), null);
  assert.equal(tokenFromPath('/other/abcdefghijklmnop'), null);
  assert.equal(tokenFromPath('/'), null);
});

test('presentShare 拼出 URL，origin 缺失时为空串', () => {
  const record = { token: 'abcdefghijklmnop', sessionId: 's', createdAt: 1, includeDescendants: true };
  assert.equal(presentShare(record, () => 'http://127.0.0.1:5555').url, 'http://127.0.0.1:5555/share/abcdefghijklmnop');
  assert.equal(presentShare(record, () => 'http://x/').url, 'http://x/share/abcdefghijklmnop');
  assert.equal(presentShare(record, () => null).url, '');
});

test('loadShareView：产出标题、消息与子代理（不含 id/cwd）', async () => {
  const loaded = await loadShareView({ sessionQuery: fakeQuery(), sessionId: 'session-ok', includeDescendants: true });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.view.title, '会话增强：分享功能');
  assert.equal(loaded.view.messages.length, 2, '工具结果应被过滤');
  assert.deepEqual(loaded.view.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(loaded.view.subagents.length, 1);
  assert.equal(loaded.view.subagents[0].title, '子代理：写测试');
  assert.equal(JSON.stringify(loaded.view).includes('secret-workspace'), false);
  assert.equal(JSON.stringify(loaded.view).includes('session-ok'), false);
});

test('loadShareView：会话不存在 / 无查询服务时返回 ok:false', async () => {
  assert.equal((await loadShareView({ sessionQuery: fakeQuery(), sessionId: 'missing', includeDescendants: false })).ok, false);
  assert.equal((await loadShareView({ sessionQuery: undefined, sessionId: 'session-ok', includeDescendants: false })).ok, false);
  assert.equal((await loadShareView({ sessionQuery: fakeQuery(), sessionId: '', includeDescendants: false })).ok, false);
});

test('loadShareView：includeDescendants=false 时不列子代理', async () => {
  const loaded = await loadShareView({ sessionQuery: fakeQuery(), sessionId: 'session-ok', includeDescendants: false });
  assert.deepEqual(loaded.view.subagents, []);
});

test('session_share 工具：schema 是严格子集，参数与输出都完整', () => {
  const tools = buildTools({ get: () => undefined }, {});
  const share = tools.find((tool) => tool.name === 'session_share');
  assert.ok(share, 'session_share 必须存在');
  assert.deepEqual(validateSchemaNode(share.parameters, 'parameters'), []);
  assert.deepEqual(validateSchemaNode(share.output.schema, 'output'), []);
  assert.deepEqual(Object.keys(share.parameters.properties).sort(), ['action', 'sessionId', 'token']);
  assert.deepEqual([...share.output.schema.required].sort(), Object.keys(share.output.schema.properties).sort());
  assert.equal(share.parameters.properties.action.enum.includes('revoke'), true);
});

test('session_share 工具：create / status / revoke / list 全流程', async () => {
  const dir = temporaryDir();
  try {
    const store = createShareStore({ storeFile: sharesFilePath(dir) });
    const env = { store, sessionQuery: () => fakeQuery(), originOf: () => 'http://127.0.0.1:5555' };
    const share = buildTools({ get: () => undefined }, env).find((tool) => tool.name === 'session_share');

    // create
    const created = await share.execute({ action: 'create', sessionId: 'session-ok' }, { agent: { session: { id: 'me' } } });
    assert.equal(created.ok, true);
    assert.match(created.summary, /http:\/\/127\.0\.0\.1:5555\/share\//);
    assert.equal(created.shares.length, 1);
    assert.equal(created.shares[0].url.includes('/share/'), true);
    assert.deepEqual(validateValue(created, share.output.schema), []);
    const token = created.shares[0].token;

    // status
    const status = await share.execute({ action: 'status', sessionId: 'session-ok' }, {});
    assert.equal(status.ok, true);
    assert.equal(status.shares[0].token, token);

    // list
    const list = await share.execute({ action: 'list' }, {});
    assert.equal(list.shares.length, 1);

    // revoke
    const revoked = await share.execute({ action: 'revoke', token }, {});
    assert.equal(revoked.ok, true);
    assert.equal((await share.execute({ action: 'status', sessionId: 'session-ok' }, {})).shares.length, 0);

    // 失败分支形状一致
    const missing = await share.execute({ action: 'create', sessionId: 'missing' }, {});
    assert.equal(missing.ok, false);
    assert.match(missing.summary, /找不到会话/);
    assert.deepEqual(validateValue(missing, share.output.schema), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session_share 工具：拿不到分享地址时不留下孤儿记录', async () => {
  const dir = temporaryDir();
  try {
    const store = createShareStore({ storeFile: sharesFilePath(dir) });
    const tool = buildTools({ get: () => undefined }, { store, sessionQuery: () => fakeQuery(), originOf: () => null }).find(
      (entry) => entry.name === 'session_share',
    );
    const result = await tool.execute({ action: 'create', sessionId: 'session-ok' }, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /无法确定分享地址/);
    assert.deepEqual(store.list(), [], '失败时不应写入任何记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session_share 工具：缺 store / 缺 sessionQuery / 缺 token 都是结构化失败', async () => {
  const noStore = buildTools({ get: () => undefined }, {}).find((tool) => tool.name === 'session_share');
  const first = await noStore.execute({ action: 'create', sessionId: 'x' }, {});
  assert.equal(first.ok, false);
  assert.match(first.summary, /分享存储不可用/);

  const dir = temporaryDir();
  try {
    const store = createShareStore({ storeFile: sharesFilePath(dir) });
    const noQuery = buildTools({ get: () => undefined }, { store, sessionQuery: () => undefined, originOf: () => 'http://x' }).find((tool) => tool.name === 'session_share');
    const second = await noQuery.execute({ action: 'create', sessionId: 'session-ok' }, {});
    assert.equal(second.ok, false);
    assert.match(second.summary, /没有会话查询服务/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = temporaryDir();
  try {
    const store = createShareStore({ storeFile: sharesFilePath(dir2) });
    const tool = buildTools({ get: () => undefined }, { store, sessionQuery: () => fakeQuery(), originOf: () => 'http://x' }).find((entry) => entry.name === 'session_share');
    const revoke = await tool.execute({ action: 'revoke' }, {});
    assert.equal(revoke.ok, false);
    assert.match(revoke.summary, /token/);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
