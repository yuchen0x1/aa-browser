/**
 * 首帧外观引导：在样式表加载前同步套用上次的主题 / 界面语言，避免先渲染浅色中文再跳变。
 * 设置页里的更改会写回同样的 localStorage 键（见 chrome.ts applyTheme / applyLocale）。
 */
;(() => {
  const root = document.documentElement
  let theme = 'light'
  let locale = ''
  try {
    const savedTheme = localStorage.getItem('aa.theme')
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') theme = savedTheme
    const savedLocale = localStorage.getItem('aa.locale')
    if (savedLocale === 'zh-CN' || savedLocale === 'en-US') locale = savedLocale
  } catch {
    /* localStorage 不可用时退回默认外观 */
  }
  if (!locale) {
    const languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
    locale = languages.some((lang) => String(lang).toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en-US'
  }
  const resolved = theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light'
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  root.lang = locale
})()
