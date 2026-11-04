/** 新标签页：一键接入 AI 客户端卡片（需 aaNewtab preload，见 src/preload/index.ts） */
export {}
interface DetectResult {
  id: string
  name: string
  file: string
  installed: boolean
  configured: boolean
  outdated: boolean
}
interface SetupResult {
  id: string
  name: string
  status: 'added' | 'updated' | 'skipped' | 'manual' | 'error'
  message: string
}

declare global {
  interface Window {
    aaNewtab?: {
      detectClients: () => Promise<DetectResult[]>
      setupClients: (ids: string[]) => Promise<SetupResult[]>
    }
  }
}

const listEl = document.getElementById('client-list') as HTMLDivElement
const btn = document.getElementById('btn-setup') as HTMLButtonElement
const resultEl = document.getElementById('setup-result') as HTMLDivElement

const STATUS_BADGE: Record<SetupResult['status'], string> = {
  added: '✅ 已写入',
  updated: '✅ 已更新',
  skipped: 'ℹ️ 已配置',
  manual: '⚠️ 需手动',
  error: '❌ 失败'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

async function init(): Promise<void> {
  if (!window.aaNewtab) {
    listEl.innerHTML = '<span class="muted">（当前环境未启用接入面板，请使用下方的手动配置方式）</span>'
    btn.style.display = 'none'
    return
  }
  const clients = await window.aaNewtab.detectClients()
  const installed = clients.filter((c) => c.installed)

  if (!installed.length) {
    listEl.innerHTML =
      '<span class="muted">未检测到已安装的 AI 客户端（支持 ZCode / Claude Code / Cursor / Windsurf / Cline / VS Code / Gemini CLI / Qwen Code）。装好后刷新本页即可一键接入。</span>'
    btn.style.display = 'none'
    return
  }

  listEl.innerHTML = installed
    .map((c) => {
      const badge = c.configured
        ? '<span class="pill ok">已配置</span>'
        : c.outdated
          ? '<span class="pill warn">待更新</span>'
          : '<span class="pill">未配置</span>'
      const checked = c.configured ? 'disabled' : 'checked'
      return `<label class="client-item">
        <input type="checkbox" data-id="${escapeHtml(c.id)}" ${checked} />
        <span class="client-name">${escapeHtml(c.name)}</span>
        ${badge}
      </label>`
    })
    .join('')

  btn.addEventListener('click', async () => {
    const ids = Array.from(listEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'))
      .filter((el) => !el.disabled)
      .map((el) => el.dataset['id'] ?? '')
      .filter(Boolean)
    if (!ids.length) {
      resultEl.innerHTML = '<span class="muted">请先勾选要接入的客户端</span>'
      return
    }
    btn.disabled = true
    resultEl.textContent = '写入中…'
    try {
      const results = await window.aaNewtab!.setupClients(ids)
      resultEl.innerHTML = results
        .map(
          (r) =>
            `<div class="result-line"><b>${STATUS_BADGE[r.status]}</b> ${escapeHtml(r.name)} —— ${escapeHtml(r.message)}</div>`
        )
        .join('')
      // 刷新状态
      void init()
    } catch (err) {
      resultEl.textContent = `写入失败：${(err as Error).message}`
    } finally {
      btn.disabled = false
    }
  })
}

void init()
