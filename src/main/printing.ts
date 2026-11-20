import { dialog } from 'electron'
import { getMainLocale } from './locale'

const busy = new WeakSet<Electron.WebContents>()

/** true 仅表示打印调用已发出，不代表实际输出；拒绝或同步异常返回 false。 */
export function printPage(wc: Electron.WebContents, parent: Electron.BaseWindow | null): boolean {
  const alive = (): boolean => !wc.isDestroyed() && !parent?.isDestroyed()
  if (!alive() || busy.has(wc)) return false
  const locale = getMainLocale()
  const text = locale === 'en-US' ? {
    title: 'Aa Browser — Print',
    failed: 'Printing could not be completed. Check the printer configuration.',
    canceled: 'Printing was not completed.',
    ok: 'OK'
  } : {
    title: 'Aa Browser — 打印',
    failed: '无法完成打印，请检查打印机配置。',
    canceled: '打印未完成。',
    ok: '确定'
  }
  let settled = false
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    busy.delete(wc)
    wc.removeListener('destroyed', onDestroyed)
    parent?.removeListener('closed', onDestroyed)
  }
  const onDestroyed = (): void => {
    settled = true
    release()
  }
  const finish = (success: boolean, reason: string): void => {
    if (settled) return
    settled = true
    if (success || !alive()) {
      release()
      return
    }
    const canceled = reason === 'Print job canceled'
    const options: Electron.MessageBoxOptions = {
      type: canceled ? 'info' : 'error',
      title: text.title,
      message: canceled ? text.canceled : text.failed,
      detail: reason,
      buttons: [text.ok],
      noLink: true
    }
    try {
      const feedback = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
      // Reporting failure must not trigger another dialog, a retry, or an unhandled rejection.
      void feedback.catch(() => {}).finally(release)
    } catch {
      release()
    }
  }
  busy.add(wc)
  wc.once('destroyed', onDestroyed)
  parent?.once('closed', onDestroyed)
  try {
    wc.print({ silent: false }, finish)
    return true
  } catch (error) {
    finish(false, error instanceof Error ? error.message : String(error))
    return false
  }
}
