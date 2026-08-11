// @ts-check

// 小型、确定性的 JSON Schema 子集校验器。
// 仅覆盖本项目函数工具与 Skill action 使用的关键词；不在运行时引入大型依赖。

function validateJsonSchema(value, schema = {}, options = {}) {
  const errors = [];
  validateNode(value, schema || {}, options.path || "$", errors);
  return { ok: errors.length === 0, errors };
}

function validateNode(value, schema, currentPath, errors) {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => validateJsonSchema(value, candidate, { path: currentPath }).ok);
    if (matches.length !== 1) errors.push(`${currentPath} 必须匹配 oneOf 中恰好一个 schema`);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((candidate) => validateJsonSchema(value, candidate, { path: currentPath }).ok);
    if (!matched) errors.push(`${currentPath} 不匹配 anyOf 中的任何 schema`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${currentPath} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join(" / ")}`);
    return;
  }
  const allowedTypes = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (allowedTypes.length && !allowedTypes.some((type) => matchesType(value, type))) {
    errors.push(`${currentPath} 类型应为 ${allowedTypes.join(" / ")}`);
    return;
  }
  if (value === null) return;
  if (Array.isArray(value)) validateArray(value, schema, currentPath, errors);
  else if (typeof value === "object") validateObject(value, schema, currentPath, errors);
  else if (typeof value === "string") validateString(value, schema, currentPath, errors);
  else if (typeof value === "number") validateNumber(value, schema, currentPath, errors);
}

function validateObject(value, schema, currentPath, errors) {
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${currentPath}.${key} 为必填字段`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${currentPath}.${key} 是未声明字段`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateNode(value[key], childSchema, `${currentPath}.${key}`, errors);
    }
  }
}

function validateArray(value, schema, currentPath, errors) {
  if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${currentPath} 至少需要 ${schema.minItems} 项`);
  if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${currentPath} 最多允许 ${schema.maxItems} 项`);
  if (schema.items) value.forEach((item, index) => validateNode(item, schema.items, `${currentPath}[${index}]`, errors));
}

function validateString(value, schema, currentPath, errors) {
  if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${currentPath} 长度不能小于 ${schema.minLength}`);
  if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${currentPath} 长度不能超过 ${schema.maxLength}`);
  if (schema.pattern) {
    try {
      if (!(new RegExp(schema.pattern)).test(value)) errors.push(`${currentPath} 格式不符合 ${schema.pattern}`);
    } catch {
      errors.push(`${currentPath} 的 schema.pattern 无效`);
    }
  }
}

function validateNumber(value, schema, currentPath, errors) {
  if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${currentPath} 不能小于 ${schema.minimum}`);
  if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${currentPath} 不能大于 ${schema.maximum}`);
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function hardenFunctionToolSchema(schema = {}) {
  const cloned = typeof structuredClone === "function"
    ? structuredClone(schema)
    : JSON.parse(JSON.stringify(schema));
  const parameters = cloned?.function?.parameters;
  if (parameters?.type === "object" && parameters.additionalProperties === undefined) {
    parameters.additionalProperties = false;
  }
  return cloned;
}

module.exports = {
  validateJsonSchema,
  hardenFunctionToolSchema
};
