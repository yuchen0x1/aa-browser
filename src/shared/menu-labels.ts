/** 主进程原生右键菜单文案（纯数据，不依赖渲染层，也不触发 Electron 导入） */

export interface ContextMenuLabels {
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  openLink: string
  openLinkNewTab: string
  copyLink: string
  copyImage: string
  saveImage: string
  back: string
  forward: string
  reload: string
  viewSource: string
  devtools: string
  saveScreenshot: string
  print: string
}

const ZH: ContextMenuLabels = {
  undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
  openLink: '打开链接', openLinkNewTab: '在新标签页打开链接', copyLink: '复制链接地址',
  copyImage: '复制图片地址', saveImage: '图片另存为',
  back: '后退', forward: '前进', reload: '刷新',
  viewSource: '查看源代码', devtools: '开发者工具', saveScreenshot: '截图保存', print: '打印'
}

const EN: ContextMenuLabels = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
  openLink: 'Open Link', openLinkNewTab: 'Open Link in New Tab', copyLink: 'Copy Link Address',
  copyImage: 'Copy Image Address', saveImage: 'Save Image As…',
  back: 'Back', forward: 'Forward', reload: 'Reload',
  viewSource: 'View Source', devtools: 'Developer Tools', saveScreenshot: 'Save Screenshot', print: 'Print'
}

/** 'auto' 由调用方按系统语言解析后再传入 */
export function contextMenuLabels(locale: 'zh' | 'en'): ContextMenuLabels {
  return locale === 'en' ? EN : ZH
}
