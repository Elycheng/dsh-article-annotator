/**
 * Zero-dependency Standard Schema for the plugin config.
 *
 * Cordis reads `runtime.Config` synchronously and calls
 * `Config['~standard'].validate(config)` before the plugin activates, so a
 * hand-written schema is both enough and safest: it keeps the host half free
 * of any @deepseek-ai import, which matters because this bundle is installed
 * as a local `link:` whose node_modules chain cannot resolve host packages.
 */

const VENDOR = 'dsh-article-annotator'

function issue(message, path) {
  return { message, path: path?.length ? path : undefined }
}

function validateObject(fields, input) {
  const issues = []
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) {
    return { issues: [issue('配置必须是一个对象')] }
  }
  const value = {}
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(fields, key)) issues.push(issue(`未知的配置项 "${key}"`, [key]))
  }
  for (const [key, field] of Object.entries(fields)) {
    const raw = source[key]
    if (raw === undefined) {
      if (Object.hasOwn(field, 'fallback')) value[key] = field.fallback
      else issues.push(issue(`缺少必填配置项 "${key}"`, [key]))
      continue
    }
    switch (field.type) {
      case 'string':
        if (typeof raw !== 'string') issues.push(issue(`"${key}" 必须是字符串`, [key]))
        else if (field.enum && !field.enum.includes(raw)) issues.push(issue(`"${key}" 必须是 ${field.enum.join(' / ')} 之一`, [key]))
        else value[key] = raw
        break
      case 'boolean':
        if (typeof raw !== 'boolean') issues.push(issue(`"${key}" 必须是布尔值`, [key]))
        else value[key] = raw
        break
      case 'integer':
        if (typeof raw !== 'number' || !Number.isInteger(raw)) issues.push(issue(`"${key}" 必须是整数`, [key]))
        else value[key] = raw
        break
      default:
        issues.push(issue(`"${key}" 类型声明非法`, [key]))
    }
  }
  return issues.length > 0 ? { issues } : { value }
}

/** Build a Standard Schema v1 object schema from a tiny field table. */
export function createConfigSchema(fields) {
  const frozen = Object.freeze(
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Object.freeze({ ...field, enum: field.enum && Object.freeze([...field.enum]) })])),
  )
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1,
      vendor: VENDOR,
      validate: (input) => validateObject(frozen, input),
    }),
    describe: () => Object.keys(frozen),
  })
}

export { validateObject }
