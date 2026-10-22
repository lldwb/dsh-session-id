/**
 * 工具定义的结构测试：证明两个工具声明的东西是注册表真正接受的子集。
 *
 * 这些测试不碰真实会话，只回答"加载器会不会收下这份 schema"——真实 Loader
 * 的加载在 devkit 沙箱回归里验证，两层各管一段。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTools, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT } from '../lib/tools.mjs';
import { validateSchemaNode, validateValue } from './strict-schema.mjs';

/** 一个不存在的 ctx：结构测试不需要任何服务。 */
const ctx = { get: () => undefined };

/** 全部工具定义。 */
const tools = buildTools(ctx);

test('至少导出一个工具，且名字是 snake_case', () => {
  assert.ok(tools.length >= 1, 'buildTools 必须返回至少一个工具');
  const seen = new Set();
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `工具名不是 snake_case：${tool.name}`);
    assert.equal(seen.has(tool.name), false, `工具名重复：${tool.name}`);
    seen.add(tool.name);
  }
});

test('每个工具的 description 都非空且能说明用途', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 60, `${tool.name} 的 description 太短，模型不知道何时用它`);
  }
});

test('参数与输出 schema 都落在注册表允许的子集里', () => {
  for (const tool of tools) {
    assert.deepEqual(validateSchemaNode(tool.parameters, `${tool.name}.parameters`), []);
    assert.deepEqual(validateSchemaNode(tool.output.schema, `${tool.name}.output.schema`), []);
  }
});

test('可选参数不写进 required，必填参数必须声明在 properties 里', () => {
  const lookup = tools.find((tool) => tool.name === 'session_lookup');
  assert.ok(lookup, 'session_lookup 必须存在');
  assert.deepEqual(lookup.parameters.required ?? [], [], 'session_lookup 的三个参数都应是可选的');
  assert.deepEqual(Object.keys(lookup.parameters.properties).sort(), ['includeMessages', 'messageLimit', 'sessionId']);
});

test('输出 schema 的 required 覆盖全部 properties（严格对象不留 undefined）', () => {
  for (const tool of tools) {
    const schema = tool.output.schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${tool.name}: required 与 properties 不一致`);
    // 嵌套对象同理：sessionNode / subagentNode / messageNode 里的 required 必须列全。
    const check = (node, path) => {
      if (node === null || typeof node !== 'object') return;
      if (node.properties !== undefined) {
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path}: required 与 properties 不一致`);
      }
      for (const [name, child] of Object.entries(node.properties ?? {})) check(child, `${path}.${name}`);
      if (node.items !== undefined) check(node.items, `${path}[]`);
    };
    check(schema, tool.name);
  }
});

test('render 返回一个 text 内容块', () => {
  for (const tool of tools) {
    const blocks = tool.output.render({}, { summary: '摘要' });
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, '摘要');
  }
});

test('参数缺省时 execute 不会因 args 为 undefined 抛错', async () => {
  const lookup = tools.find((tool) => tool.name === 'session_lookup');
  // 没有 sessionQuery、没有 agent：应当返回一条结构化失败而不是异常。
  const value = await lookup.execute({}, {});
  assert.equal(value.ok, false);
  assert.equal(typeof value.summary, 'string');
  assert.deepEqual(validateValue(value, lookup.output.schema), []);
});

test('messageLimit / includeMessages 的默认值写在描述里', () => {
  const lookup = tools.find((tool) => tool.name === 'session_lookup');
  assert.match(lookup.parameters.properties.messageLimit.description, new RegExp(String(DEFAULT_MESSAGE_LIMIT)));
  assert.match(lookup.parameters.properties.messageLimit.description, new RegExp(String(MAX_MESSAGE_LIMIT)));
  assert.match(lookup.parameters.properties.includeMessages.description, /Defaults to true/);
});

test('presentCall 给出一个可读标题', () => {
  const lookup = tools.find((tool) => tool.name === 'session_lookup');
  assert.equal(lookup.presentCall({}).title, '查找会话：当前会话');
  assert.equal(lookup.presentCall({ sessionId: 'abc' }).title, '查找会话：abc');
});
