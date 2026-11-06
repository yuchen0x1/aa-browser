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
      decideApproval: (id: string, allowed: boolean) => Promise<boolean>
      interruptAgent: () => Promise<boolean>
      resumeAgent: () => Promise<boolean>
      onState: (cb: (state: UiState) => void) => void
      onFocusOmnibox: (cb: () => void) => void
    }
  }
}

let state: UiState = { tabs: [], activeId: null, agentCount: 0, bridgeState: 'waiting', connectionMessage: '等待 MCP 桥启动并连接', pendingApprovals: [], agentInterrupted: false }

const tabsEl = document.getElementById('tabs') as HTMLDivElement
const omnibox = document.getElementById('omnibox') as HTMLInputElement
const agentPill = document.getElementById('agent-pill') as HTMLDivElement
const btnBack = document.getElementById('btn-back') as HTMLButtonElement
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement
const agentStop = document.getElementById('agent-stop') as HTMLButtonElement
const approvalPanel = document.getElementById('approval-panel') as HTMLDivElement
const btnFeed = document.getElementById('btn-feed') as HTMLButtonElement | null
const feedDrawer = document.getElementById('action-feed-drawer') as HTMLDivElement | null
const feedList = document.getElementById('action-feed-list') as HTMLDivElement | null
const btnCloseFeed = document.getElementById('btn-close-feed') as HTMLButtonElement | null

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
  agentPill.title = state.connectionMessage
  agentPill.classList.toggle('connected', state.bridgeState === 'connected')
  agentPill.classList.toggle('waiting', state.bridgeState === 'waiting')
  if (state.bridgeState === 'connected') {
    agentPill.textContent = `● 浏览器已连接 ×${state.agentCount}`
  } else if (state.bridgeState === 'waiting') {
    agentPill.textContent = '◌ 等待 AI 桥接'
  } else {
    agentPill.textContent = '○ AI 桥未连接'
  }
  agentStop.textContent = state.agentInterrupted ? '恢复' : '中断'
  agentStop.classList.toggle('active', state.agentInterrupted)
  agentStop.title = state.agentInterrupted ? '恢复 Agent 浏览器操作' : '中断 Agent 的后续浏览器操作'
  renderApprovals()
}

function renderApprovals(): void {
  const pending = state.pendingApprovals ?? []
  approvalPanel.hidden = pending.length === 0
  approvalPanel.textContent = ''
  for (const item of pending) {
    const title = document.createElement('div')
    title.className = 'approval-title'
    title.textContent = '需要你亲自填写敏感信息'
    const meta = document.createElement('div')
    meta.className = 'approval-meta'
    meta.textContent = `网站：${item.site} · 标签：${item.tabTitle} · 字段：${item.fieldLabel}`
    const help = document.createElement('div')
    help.className = 'approval-help'
    help.textContent = '请直接在网页输入框中填写内容；敏感内容不会由 Agent 写入或回传。填写完成后再点“允许继续”。'
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    const deny = document.createElement('button')
    deny.className = 'approval-deny'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => void window.aa.decideApproval(item.id, false))
    const allow = document.createElement('button')
    allow.className = 'approval-allow'
    allow.textContent = '允许继续'
    allow.addEventListener('click', () => void window.aa.decideApproval(item.id, true))
    actions.append(deny, allow)
    approvalPanel.append(title, meta, help, actions)
  }
}

function renderFeed(): void {
  if (!feedList) return
  const actions = state.recentActions || []
  if (!actions.length) {
    feedList.innerHTML = '<div class="empty-feed">暂无 Agent 操作记录</div>'
    return
  }
  feedList.innerHTML = ''
  for (const item of actions.slice().reverse()) {
    const el = document.createElement('div')
    el.className = 'feed-item' + (item.isError ? ' error' : '')
    const timeStr = new Date(item.ts).toLocaleTimeString()
    el.innerHTML = `
      <div class="feed-head">
        <span class="feed-tool">${item.tool}</span>
        <span class="feed-time">${timeStr}</span>
      </div>
      <div class="feed-summary">${item.summary}</div>
    `
    feedList.appendChild(el)
  }
}

function applyState(next: UiState): void {
  state = next
  renderTabs()
  renderToolbar()
  renderFeed()
}

/* ── 事件绑定 ─────────────────────── */

btnBack.addEventListener('click', () => void window.aa.back())
btnForward.addEventListener('click', () => void window.aa.forward())
btnReload.addEventListener('click', () => void window.aa.reload())
agentStop.addEventListener('click', () => void (state.agentInterrupted ? window.aa.resumeAgent() : window.aa.interruptAgent()))
document.getElementById('btn-newtab')?.addEventListener('click', () => void window.aa.tabNew())

btnFeed?.addEventListener('click', () => {
  if (!feedDrawer) return
  feedDrawer.hidden = !feedDrawer.hidden
})
btnCloseFeed?.addEventListener('click', () => {
  if (feedDrawer) feedDrawer.hidden = true
})

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
