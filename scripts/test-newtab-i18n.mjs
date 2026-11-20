/** New-tab i18n regression: compiled Electron renderer, disposable profile, clipboard APIs stubbed. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const page = path.join(root, 'out/renderer/newtab.html')
const profileVariable = 'AA_NEWTAB_TEST_PROFILE'

if (!process.versions.electron) {
  assert.ok(fs.existsSync(page), 'Build the renderer with npm run build first')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-newtab-i18n-'))
  const env = { ...process.env, [profileVariable]: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  try {
    const electron = createRequire(import.meta.url)('electron')
    const result = spawnSync(electron, [file], { env, stdio: 'inherit', timeout: 45_000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Electron test exited (${result.signal ?? 'no signal'})`)
    assert.equal(fs.readFileSync(path.join(profile, 'passed'), 'utf8'), 'ok')
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
} else {
  void testRenderer()
}

async function testRenderer() {
  const { app, BrowserWindow, nativeTheme } = createRequire(import.meta.url)('electron')
  try {
    const profile = process.env[profileVariable]
    assert.ok(profile, 'Run this test through Node to create a disposable profile')
    app.setPath('userData', profile)
    app.setPath('sessionData', profile)
    await app.whenReady()
    nativeTheme.themeSource = 'light'
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    })
    await win.loadFile(page, { query: { theme: 'dark' } })
    const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
    const readUi = () => run(() => {
      const text = (selector) => document.querySelector(selector).textContent.trim()
      const label = (selector) => document.querySelector(selector).getAttribute('aria-label')
      return {
        locale: document.documentElement.lang,
        title: document.title,
        hero: text('h1 span'),
        intro: text('.intro'),
        stepsLabel: label('.steps'),
        steps: [...document.querySelectorAll('.step')].map((step) => ({
          label: step.querySelector('.step-label [data-en]').textContent,
          title: step.querySelector('h2').textContent,
          body: step.querySelector('p').textContent
        })),
        promptTitle: text('#prompt-title'),
        promptLabel: label('#connection-prompt'),
        copy: text('#copy-prompt'),
        note: text('#copy-status'),
        shortcut: text('.footer > span:last-child'),
        theme: document.documentElement.dataset.theme,
        scheme: document.documentElement.style.colorScheme,
        background: getComputedStyle(document.body).backgroundColor
      }
    })
    const applyLocale = (locale) => run((value) => window.__aaApplyLocale(value), locale)
    // Override only the fixture renderer's language candidates, not the host preferences.
    const setLanguages = (languages, fallback = 'en-US') => run((values, language) => {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: values })
      Object.defineProperty(navigator, 'language', { configurable: true, value: language })
      window.dispatchEvent(new Event('languagechange'))
    }, languages, fallback)

    const normalize = (value) => value.replace(/\r\n/g, '\n')
    const sourcePrompt = normalize(fs.readFileSync(path.join(root, 'installer/connect-prompt.md'), 'utf8')).trim()
    const originalPrompt = `<!-- aa-universal-prompt:start -->\n${sourcePrompt}\n<!-- aa-universal-prompt:end -->`
    const assertPrompt = async () => {
      const prompt = await run(() => {
        const field = document.querySelector('#connection-prompt')
        return { value: field.value, readOnly: field.readOnly }
      })
      assert.deepEqual(prompt, { value: originalPrompt, readOnly: true })
    }
    await setLanguages(['fr-FR', 'en-GB', 'zh-Hans'])
    assert.equal((await readUi()).locale, 'en-US', 'Initial auto setting follows the first supported candidate')
    await applyLocale('zh-CN')
    const zh = await readUi()
    assert.equal(zh.locale, 'zh-CN')
    assert.equal(zh.title, 'Aa Browser — 安装并连接 AI')
    assert.equal(zh.hero, '让 AI 直接使用')
    assert.equal(zh.stepsLabel, '安装与连接步骤')
    assert.deepEqual(zh.steps.map(({ label }) => label), ['复制接入提示词', '发给 AI 执行', '确认连接状态'])
    assert.equal(zh.promptLabel, '可复制的通用 AI 安装与接入提示词')
    assert.equal(zh.copy, '复制接入提示词')
    assert.match(zh.note, /^前提.*不能自动完成/)
    assert.match(zh.shortcut, /Ctrl \+ T 新建标签/)
    assert.deepEqual([zh.theme, zh.scheme, zh.background], ['dark', 'dark', 'rgb(17, 22, 25)'])
    await assertPrompt()

    await setLanguages(['zh-TW', 'en-US'])
    await applyLocale('en-US')
    const en = await readUi()
    assert.equal(en.locale, 'en-US', 'Explicit English overrides Chinese candidates')
    assert.equal(en.title, 'Aa Browser — Install and connect AI')
    assert.equal(en.hero, 'Let AI use')
    assert.match(en.intro, /web-only AI.*cannot complete the setup automatically/)
    assert.equal(en.stepsLabel, 'Installation and connection steps')
    assert.deepEqual(en.steps.map(({ label, title }) => [label, title]), [
      ['Copy the connection prompt', 'Open and copy the prompt'],
      ['Send it to your AI', 'Let AI configure your client'],
      ['Confirm the connection', 'Check the left side of the toolbar']
    ])
    assert.match(en.steps[0].body, /does not reinstall/)
    assert.match(en.steps[1].body, /MCP configuration.*browser_tabs/)
    assert.match(en.steps[2].body, /browser_tabs.*does not count as a connection/)
    assert.equal(en.promptTitle, 'Installation and connection prompt for AI')
    assert.equal(en.promptLabel, 'Universal AI installation and connection prompt')
    assert.equal(en.copy, 'Copy the connection prompt')
    assert.match(en.note, /^Prerequisites.*cannot finish setup automatically/)
    assert.match(en.shortcut, /Ctrl \+ T New tab/)
    assert.deepEqual([en.theme, en.scheme, en.background], [zh.theme, zh.scheme, zh.background])
    await assertPrompt()

    await run(() => window.__aaApplyTheme('light'))
    const light = await readUi()
    assert.deepEqual([light.locale, light.theme, light.scheme, light.background], ['en-US', 'light', 'light', 'rgb(247, 249, 251)'])
    await run(() => window.__aaApplyTheme('system'))
    nativeTheme.themeSource = 'dark'
    let system = await readUi()
    for (let i = 0; system.theme !== 'dark' && i < 50; i++) {
      await delay(50)
      system = await readUi()
    }
    assert.deepEqual([system.locale, system.theme, system.scheme], ['en-US', 'dark', 'dark'])
    await setLanguages(['zh-Hans'])
    assert.equal((await readUi()).locale, 'en-US', 'languagechange does not override explicit settings')
    await applyLocale('auto')
    assert.equal((await readUi()).locale, 'zh-CN')
    await setLanguages(['de-DE'])
    assert.equal((await readUi()).locale, 'zh-CN', 'Unsupported candidates fall back to Chinese')
    await setLanguages([], 'en-AU')
    assert.equal((await readUi()).locale, 'en-US', 'Empty navigator.languages falls back to navigator.language')

    const copyWith = (mode, switchTo = null) => run(async (outcome, nextLocale) => {
      const writes = []
      const commands = []
      const field = document.querySelector('#connection-prompt')
      let settle
      let pending
      const clipboard = {
        async writeText(value) {
          writes.push(value)
          if (nextLocale) {
            return new Promise((resolve, reject) => {
              settle = () => outcome === 'clipboard' ? resolve() : reject(new Error('Stubbed delayed write failure'))
            })
          }
          if (outcome !== 'clipboard') throw new Error('Stubbed write failure')
        }
      }
      const execCommand = (command) => {
        commands.push(command)
        if (outcome === 'throw') throw new Error('Stubbed legacy copy failure')
        return outcome === 'legacy'
      }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
      Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
      if (navigator.clipboard !== clipboard || document.execCommand !== execCommand) throw new Error('Clipboard stubs not installed')
      document.querySelector('#copy-prompt').click()
      if (nextLocale) {
        if (!settle) throw new Error('Expected clipboard write to be pending')
        window.__aaApplyLocale(nextLocale)
        pending = {
          locale: document.documentElement.lang,
          status: document.querySelector('#copy-status').textContent,
          commands: [...commands]
        }
        settle()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      return {
        writes,
        commands,
        pending,
        status: document.querySelector('#copy-status').textContent,
        selected: document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === field.value.length
      }
    }, mode, switchTo)

    for (const [locale, copiedText, manualText] of [
      ['zh-CN', '接入提示词已复制。粘贴到你正在使用的 AI 客户端即可。', '已选中接入提示词，请按 Ctrl+C 复制，再粘贴到 AI 客户端。'],
      ['en-US', 'Connection prompt copied. Paste it into your AI client.', 'The connection prompt is selected. Press Ctrl+C to copy it, then paste it into your AI client.']
    ]) {
      await applyLocale(locale)
      for (const mode of ['clipboard', 'legacy', 'manual', 'throw']) {
        const result = await copyWith(mode)
        assert.deepEqual(result.writes, [originalPrompt], `${locale}/${mode}: copy the unchanged generated prompt`)
        assert.deepEqual(result.commands, mode === 'clipboard' ? [] : ['copy'])
        assert.equal(result.status, mode === 'clipboard' || mode === 'legacy' ? copiedText : manualText)
        if (mode !== 'clipboard') assert.equal(result.selected, true)
      }
    }
    await applyLocale('zh-CN')
    assert.match((await readUi()).note, /^已选中接入提示词/)
    const delayedSuccess = await copyWith('clipboard', 'en-US')
    assert.deepEqual(delayedSuccess.writes, [originalPrompt])
    assert.deepEqual(delayedSuccess.pending, {
      locale: 'en-US',
      status: 'The connection prompt is selected. Press Ctrl+C to copy it, then paste it into your AI client.',
      commands: []
    })
    assert.deepEqual(delayedSuccess.commands, [])
    assert.equal(delayedSuccess.status, 'Connection prompt copied. Paste it into your AI client.')

    const delayedFailure = await copyWith('manual', 'zh-CN')
    assert.deepEqual(delayedFailure.writes, [originalPrompt])
    assert.deepEqual(delayedFailure.pending, {
      locale: 'zh-CN', status: '接入提示词已复制。粘贴到你正在使用的 AI 客户端即可。', commands: []
    })
    assert.deepEqual(delayedFailure.commands, ['copy'])
    assert.equal(delayedFailure.status, '已选中接入提示词，请按 Ctrl+C 复制，再粘贴到 AI 客户端。')
    assert.equal(delayedFailure.selected, true)
    await assertPrompt()
    win.destroy()
    fs.writeFileSync(path.join(profile, 'passed'), 'ok')
    console.log('PASS: new-tab locale, theme and copy (no system clipboard access)')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
