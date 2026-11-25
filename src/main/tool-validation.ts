type Schema = {
  type?: string | string[]; enum?: unknown[]; required?: string[]
  properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number
  minItems?: number; maxItems?: number
}

/** Validate the published schema without dropping compatible extension/context fields. */
export function validateToolArguments(schema: unknown, value: unknown): void {
  let nodes = 0
  const visit = (rule: Schema, item: unknown, name: string, depth: number): void => {
    if (++nodes > 10_000 || depth > 16) throw new Error(`[INVALID_ARGUMENT] ${name}: input is too complex`)
    if (rule.anyOf) {
      if (!rule.anyOf.some((option) => { try { visit(option, item, name, depth + 1); return true } catch { return false } })) {
        throw new Error(`[INVALID_ARGUMENT] ${name}: does not match an accepted schema`)
      }
      return
    }
    const kind = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    const allowed = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : []
    if (allowed.length && !allowed.some((type) => type === kind || (type === 'integer' && typeof item === 'number' && Number.isSafeInteger(item)))) {
      throw new Error(`[INVALID_ARGUMENT] ${name}: expected ${allowed.join(' or ')}`)
    }
    if (rule.enum && !rule.enum.includes(item)) throw new Error(`[INVALID_ARGUMENT] ${name}: unsupported value`)
    if (typeof item === 'number' && (!Number.isFinite(item) || (rule.minimum !== undefined && item < rule.minimum) || (rule.maximum !== undefined && item > rule.maximum))) {
      throw new Error(`[INVALID_ARGUMENT] ${name}: number is outside the accepted range`)
    }
    if (typeof item === 'string' && (item.length > Math.min(1_000_000, rule.maxLength ?? 1_000_000) || item.length < (rule.minLength ?? 0) || item.includes('\0'))) {
      throw new Error(`[INVALID_ARGUMENT] ${name}: invalid string length or NUL character`)
    }
    if (Array.isArray(item)) {
      if (item.length > Math.min(1000, rule.maxItems ?? 1000) || item.length < (rule.minItems ?? 0)) throw new Error(`[INVALID_ARGUMENT] ${name}: invalid array length`)
      item.forEach((entry, i) => { visit(rule.items ?? {}, entry, `${name}[${i}]`, depth + 1) })
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      for (const key of rule.required ?? []) {
        if (record[key] === undefined) throw new Error(`[INVALID_ARGUMENT] ${name}.${key}: required`)
      }
      for (const [key, entry] of Object.entries(record)) {
        if (key.startsWith('__aa')) continue
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`[INVALID_ARGUMENT] ${name}: unsafe key`)
        visit(rule.properties?.[key] ?? {}, entry, `${name}.${key}`, depth + 1)
      }
    }
  }
  visit(schema as Schema, value, 'arguments', 0)
}
