import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'

const pendingOperations = `(async () => {
  if (location.protocol !== 'file:' || !/\\/renderer\\/index\\.html$/.test(location.pathname)) throw new Error('Approval driver requires the trusted browser shell');
  if (!window.aa?.getState || !window.aa?.decideApproval) return [];
  const state = await window.aa.getState();
  return state.pendingApprovals.filter(item => item.kind === 'operation').map(item => item.id);
})()`

/** Test-side user decisions use the production shell IPC, with no application bypass. */
export function startOperationApprovalDriver(evaluate, { beforeApproval } = {}) {
  let enabled = true
  let stopped = false
  let failure
  let tick = Promise.resolve()
  let approved = 0
  const loop = (async () => {
    while (!stopped) {
      if (enabled) {
        tick = (async () => {
          const ids = await evaluate(pendingOperations)
          for (const id of ids) {
            if (!enabled || stopped) break
            await beforeApproval?.(id)
            const accepted = await evaluate(`window.aa.decideApproval(${JSON.stringify(id)}, true)`)
            if (accepted) approved++
          }
        })()
        try { await tick } catch (error) { failure = error; stopped = true }
      }
      if (!stopped) await delay(25)
    }
  })()
  return {
    async pause() { enabled = false; await tick.catch(() => {}) },
    resume() { if (failure) throw failure; enabled = true },
    assertHealthy() { if (failure) throw failure },
    get approved() { return approved },
    async stop() { stopped = true; await loop }
  }
}

/** The smoke runner attaches only to its own loopback debugging port and trusted shell. */
export async function connectTrustedShell(debugPort, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let endpoint
  while (!endpoint && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) })
      const pages = await response.json()
      endpoint = pages.find((page) => {
        try { const url = new URL(page.url); return page.type === 'page' && url.protocol === 'file:' && /\/renderer\/index\.html$/.test(url.pathname) } catch { return false }
      })?.webSocketDebuggerUrl
    } catch { /* Chromium may still be starting. */ }
    if (!endpoint) await delay(50)
  }
  if (!endpoint || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(endpoint)) throw new Error('Trusted smoke shell debugging endpoint was not found')
  const socket = new WebSocket(endpoint)
  const pending = new Map()
  let nextId = 0
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const rejectPending = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  socket.on('error', rejectPending)
  socket.on('close', () => rejectPending(new Error('Trusted smoke shell debugging connection closed')))
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new Error(message.error.message))
    else if (message.result?.exceptionDetails) item.reject(new Error(message.result.exceptionDetails.text))
    else item.resolve(message.result?.result?.value)
  })
  return {
    evaluate(expression) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Trusted shell evaluation timed out')) }, 10_000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
    },
    close() { rejectPending(new Error('Trusted smoke shell driver stopped')); socket.close() }
  }
}
