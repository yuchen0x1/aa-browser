export type Locale = 'zh-CN' | 'en-US'
export type LocaleSetting = 'auto' | Locale

export function resolveLocale(setting: LocaleSetting | undefined, candidates: readonly string[] = []): Locale {
  if (setting === 'zh-CN' || setting === 'en-US') return setting
  const values = candidates.length ? candidates : ['zh-CN']
  for (const value of values) {
    const normalized = String(value).toLowerCase()
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US'
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  }
  return 'zh-CN'
}

export const localeLabels: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' }
