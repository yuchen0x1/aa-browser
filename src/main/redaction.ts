const SECRET_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|session[-_]?id|otp|cvv|cvc)/i

/** Audit output is deliberately less detailed than the authorized tool result. */
export function redactText(value: unknown, limit = 1000): string {
  return String(value ?? '')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&#][^=\s]*(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|session|credential|code)[^=\s]*=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/(["']?(?:password|passwd|secret|[\w-]*token|authorization|cookie|credential|api[-_]?key|private[-_]?key|session[-_]?id|otp|cvv|cvc)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)/gi, '$1[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .slice(0, Math.max(0, Math.min(100_000, limit)))
}

export function isSensitiveKey(key: string): boolean { return SECRET_KEY.test(key) }

export function redactData(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]'
  if (typeof value === 'string') return redactText(value, 50_000)
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => redactData(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) =>
      [key, isSensitiveKey(key) ? '[redacted]' : redactData(item, depth + 1)]))
  }
  return value
}
