/**
 * 工具 schema 的最小构造器：两个工具（`session_lookup` / `session_share`）共用。
 *
 * ## 为什么手写而不是 `defineTool`
 *
 * 第三方插件不能 import `@deepseek-ai/dsh-tools` 的 `defineTool`（它在 profile 下解析
 * 不了），所以参数与**返回值**都要手写注册表接受的 JSON Schema 子集。这个子集只认：
 * `type`（单一字符串）、`properties`、`required`、`additionalProperties`、`items`、
 * `enum`、`const`、`oneOf`、`description`。
 *
 * ## 三条硬规则（踩过的坑）
 *
 * 1. 没有 `minimum` / `maximum` / `pattern` —— 写了会被忽略，范围必须在 `execute`
 *    里自己收口；
 * 2. 每个对象节点的 `required` 必须列全，且返回值**不能出现 `null`**（用 `''` / `0` /
 *    `false` 表达缺失），否则运行时校验报 `tool returned invalid output`；
 * 3. `render` 只消费自己声明的字段。
 *
 * @module dsh-session-id/lib/tools/schema
 */

/**
 * 工具返回的文本块。
 *
 * @param {string} content - 文本。
 * @returns {any[]} 内容块数组。
 */
export function text(content) {
  return [{ type: 'text', text: content }];
}

/**
 * 一个 schema 属性节点。
 *
 * @param {string} type - JSON Schema 类型。
 * @param {string} [description] - 说明（省略时不写该字段）。
 * @param {Record<string, unknown>} [extra] - 附加关键字（如 `enum`）。
 * @returns {any} 属性节点。
 */
export function prop(type, description, extra = {}) {
  return { type, ...(description === undefined ? {} : { description }), ...extra };
}

/**
 * 一个严格对象节点；`additionalProperties: false` 是注册表的硬要求。
 *
 * @param {Record<string, any>} properties - 属性表。
 * @param {string[]} [required] - 必填字段；省略时不写 `required`。
 * @returns {any} 对象节点。
 */
export function obj(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

/**
 * 一个数组节点。
 *
 * @param {any} items - 元素 schema。
 * @param {string} [description] - 说明。
 * @returns {any} 数组节点。
 */
export function arr(items, description) {
  return { type: 'array', ...(description === undefined ? {} : { description }), items };
}

/**
 * 一个字符串枚举节点。
 *
 * @param {string[]} values - 允许值。
 * @param {string} description - 说明。
 * @returns {any} 枚举节点。
 */
export function enumProp(values, description) {
  return { type: 'string', enum: values, description };
}
