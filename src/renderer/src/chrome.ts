import type { TabInfo, UiState } from '@shared/types'

declare global {
  interface Window {
    aa: {
      getState: () => Promise<UiState>
      tabNew: (url?: string) => Promise<void>
      tabClose: (id: string) => Promise<void>
      tabSelect: (id: string) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      submit: (value: string) => Promise<void>
      devtools: () => Promise<void>
      onState: (cb: (state: UiState) => void) => void
      onFocusOmnibox: (cb: () => void) => void
    }
  }
}

let state: UiState = { tabs: [], activeId: null, agentCount: 0 }

const tabsEl = document.getElementById('tabs') as HTMLDivElement
const omnibox = document.getElementById('omnibox') as HTMLInputElement
const agentPill = document.getElementById('agent-pill') as HTMLDivElement
const btnBack = document.getElementById('btn-back') as HTMLButtonElement
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement

function activeTab(): TabInfo | null {
  return state.tabs.find((t) => t.active) ?? null
}

function shortenUrl(u: string): string {
  if (/^file:\/\//i.test(u)) return u.replace(/^file:\/\/\/?/, '本地文件 ')
  try {
    const url = new URL(u)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host + url.pathname + url.search
    return u
  } catch {
    return u
  }
}

/** 渲染标签条 */
function renderTabs(): void {
  tabsEl.textContent = ''
  for (const t of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (t.active ? ' active' : '')
    el.title = `${t.title}\n${t.url}`

    const fav = document.createElement('div')
    fav.className = 'favicon'
    if (t.loading) {
      const dot = document.createElement('div')
      dot.className = 'dot'
      fav.appendChild(dot)
    } else if (t.favicon && /^https?:|^data:/i.test(t.favicon)) {
      const img = document.createElement('img')
      img.src = t.favicon
      img.onerror = () => {
        img.remove()
        fav.textContent = '•'
        fav.style.color = '#66676e'
      }
      fav.appendChild(img)
    } else {
      fav.textContent = '•'
      fav.style.color = '#66676e'
    }
    el.appendChild(fav)

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t.title || '无标题'
    el.appendChild(title)

    const close = document.createElement('button')
    close.className = 'close'
    close.title = '关闭标签页 (Ctrl+W)'
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void window.aa.tabClose(t.id)
    })
    el.appendChild(close)

    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        void window.aa.tabClose(t.id)
      }
    })
    el.addEventListener('click', () => void window.aa.tabSelect(t.id))

    tabsEl.appendChild(el)
  }
}

/** 渲染工具栏状态 */
function renderToolbar(): void {
  const active = activeTab()
  if (active) {
    if (document.activeElement !== omnibox) omnibox.value = shortenUrl(active.url)
    btnBack.disabled = !active.canBack
    btnForward.disabled = !active.canForward
  } else {
    omnibox.value = ''
    btnBack.disabled = true
    btnForward.disabled = true
  }
  if (state.agentCount > 0) {
    agentPill.textContent = `● Agent 已连接 ×${state.agentCount}`
    agentPill.classList.add('connected')
  } else {
    agentPill.textContent = '○ Agent 未连接'
    agentPill.classList.remove('connected')
  }
}

function applyState(next: UiState): void {
  state = next
  renderTabs()
  renderToolbar()
}

/* ── 事件绑定 ─────────────────────── */

btnBack.addEventListener('click', () => void window.aa.back())
btnForward.addEventListener('click', () => void window.aa.forward())
btnReload.addEventListener('click', () => void window.aa.reload())
document.getElementById('btn-newtab')?.addEventListener('click', () => void window.aa.tabNew())

omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = omnibox.value.trim()
    if (v) void window.aa.submit(v)
    omnibox.blur()
  } else if (e.key === 'Escape') {
    omnibox.blur()
  }
})
omnibox.addEventListener('focus', () => omnibox.select())

window.aa.onState(applyState)
window.aa.onFocusOmnibox(() => {
  omnibox.focus()
})

/* 键盘快捷键（chrome UI 焦点时） */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key.toLowerCase() === 't') {
    e.preventDefault()
    void window.aa.tabNew()
  } else if (ctrl && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    const active = activeTab()
    if (active) void window.aa.tabClose(active.id)
  } else if (ctrl && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    omnibox.focus()
  } else if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
    e.preventDefault()
    void window.aa.reload()
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    void window.aa.devtools()
  }
})

/* 初始化拉取一次状态 */
void window.aa.getState().then(applyState)
