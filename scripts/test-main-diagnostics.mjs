/** Production diagnostic branches, compiled and exercised under Node without starting Electron. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import Module, { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const verificationDir = path.join(root, '.local-verification')
fs.mkdirSync(verificationDir, { recursive: true })
const runDir = fs.mkdtempSync(path.join(verificationDir, 'main-diagnostics-'))
const savedEnvironment = { ...process.env }
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const savedResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const originalLoad = Module._load
let failures = 0
let checks = 0

try {
  const config = path.join(runDir, 'tsconfig.json')
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      esModuleInterop: true, skipLibCheck: true, types: ['node'],
      rootDir: path.join(root, 'src'), outDir: path.join(runDir, 'compiled')
    },
    files: ['main/clients.ts', 'main/downloads.ts'].map((file) => path.join(root, 'src', file))
  }))
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
  assert.equal(compiled.status, 0, compiled.error?.message || 'Diagnostic fixture compilation failed')

  // These modules load without Electron or any filesystem/settings dependency.
  const { resolveLocale } = require(path.join(runDir, 'compiled/shared/locale.js'))
  const { diagnosticMessage, errorDetail } = require(path.join(runDir, 'compiled/shared/diagnostics/index.js'))
  const home = path.join(runDir, '用户 空格 e\u0301')
  const appRoot = path.join(runDir, '应用 Ω e\u0301')
  const bin = path.join(runDir, 'Node 程序 Ω')
  for (const directory of [home, appRoot, bin]) fs.mkdirSync(directory, { recursive: true })
  for (const name of ['node', 'node.exe']) fs.writeFileSync(path.join(bin, name), 'fixture; never executed')
  delete process.env.Path
  process.env.PATH = bin
  process.env.AA_BROWSER_SETTINGS_FILE = path.join(runDir, 'settings.json')
  fs.writeFileSync(process.env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ locale: 'en-US' }))
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(runDir, 'resources') })

  let systemLocale = 'zh-TW'
  let localeReads = 0
  let settingsReads = 0
  let fsFault
  let fsObserver
  let lastFilesystemError
  const operations = []
  const violations = []
  const app = {
    isPackaged: false,
    getLocale: () => { localeReads++; return systemLocale },
    getAppPath: () => appRoot,
    getPath: (name) => {
      assert.ok(['appData', 'userData'].includes(name), `Unexpected app path: ${name}`)
      return path.join(home, name)
    }
  }
  const electron = {
    app,
    shell: {
      openPath: () => { throw new Error('Shell operations are forbidden in diagnostic tests') },
      showItemInFolder: () => { throw new Error('Shell operations are forbidden in diagnostic tests') }
    }
  }
  // Every production filesystem access is guarded, including reads and PATH probes.
  const sandboxFs = { constants: fs.constants }
  const pathArguments = {
    existsSync: [0], statSync: [0], lstatSync: [0], realpathSync: [0], readFileSync: [0], copyFileSync: [0, 1], mkdirSync: [0],
    writeFileSync: [0], openSync: [0], fsyncSync: [], closeSync: [], renameSync: [0, 1], unlinkSync: [0], readdirSync: [0], rmSync: [0]
  }
  for (const [method, indexes] of Object.entries(pathArguments)) {
    sandboxFs[method] = (...args) => {
      for (const index of indexes) {
        if (method === 'writeFileSync' && typeof args[index] === 'number') continue
        const relative = path.relative(runDir, path.resolve(args[index]))
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          violations.push(`${method}: ${args[index]}`)
          throw new Error(`Production filesystem access escaped the sandbox: ${args[index]}`)
        }
      }
      operations.push({ method, args })
      fsFault?.(method, args)
      fsObserver?.(method, args)
      try { return fs[method](...args) }
      catch (error) { lastFilesystemError = error; throw error }
    }
  }
  let clients
  let DownloadTracker
  let getMainLocale
  let getSettingsStore
  try {
    Module._load = function (name, ...args) {
      if (name === 'electron') return electron
      if (name === 'node:fs') return sandboxFs
      if (name === 'node:os') return { homedir: () => home }
      return originalLoad.call(this, name, ...args)
    }
    clients = require(path.join(runDir, 'compiled/main/clients.js'))
    ;({ DownloadTracker } = require(path.join(runDir, 'compiled/main/downloads.js')))
    ;({ getMainLocale } = require(path.join(runDir, 'compiled/main/locale.js')))
    ;({ getSettingsStore } = require(path.join(runDir, 'compiled/main/settings.js')))
  } finally { Module._load = originalLoad }

  const originalDefs = [...clients.CLIENT_DEFS]
  const store = getSettingsStore()
  const originalGet = store.get
  store.get = function (...args) { settingsReads++; return originalGet.apply(this, args) }
  let sequence = 0
  const nextDir = () => {
    const directory = path.join(runDir, `case-${++sequence}`, '配置 e\u0301 Ω')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }
  function test(label, fn) {
    checks++
    fsFault = fsObserver = undefined
    lastFilesystemError = undefined
    operations.length = 0
    try {
      fn()
      assert.deepEqual(violations, [], 'No production read/write may escape the fixture directory')
      console.log(`PASS: ${label}`)
    } catch (error) {
      failures++
      console.error(`FAIL: ${label}\n${error.stack || error}`)
    } finally {
      fsFault = fsObserver = undefined
      clients.CLIENT_DEFS.splice(0, clients.CLIENT_DEFS.length, ...originalDefs)
    }
  }
  function useLocale(setting, candidate) {
    store.set({ locale: setting })
    systemLocale = candidate
    localeReads = settingsReads = 0
    operations.length = 0
  }
  function withDefs(defs, fn) {
    const previous = [...clients.CLIENT_DEFS]
    clients.CLIENT_DEFS.splice(0, clients.CLIENT_DEFS.length, ...defs)
    try { return fn() }
    finally { clients.CLIENT_DEFS.splice(0, clients.CLIENT_DEFS.length, ...previous) }
  }
  function setup(defs, ids = defs.map((def) => def.id)) {
    const before = localeReads
    const reads = settingsReads
    const result = withDefs(defs, () => clients.setupClients(ids))
    assert.equal(localeReads - before, 1, 'Capture the system locale once per setup call')
    assert.equal(settingsReads - reads, 1, 'Capture the saved locale once per setup call')
    return result
  }
  function retry(tracker, id) {
    const before = localeReads
    const reads = settingsReads
    const result = tracker.retry(id)
    assert.equal(localeReads - before, 1, 'Capture the system locale once per retry call')
    assert.equal(settingsReads - reads, 1, 'Capture the saved locale once per retry call')
    return result
  }
  function fixture(id = 'cursor', text, installed = true) {
    const directory = nextDir()
    const original = originalDefs.find((def) => def.id === id)
    assert.ok(original)
    const file = path.join(directory, original.toml ? '配置.toml' : '配置.json')
    const detect = path.join(directory, '客户端目录')
    if (installed) fs.mkdirSync(detect)
    if (text !== undefined) fs.writeFileSync(file, text)
    return { ...original, file: () => file, detectPath: () => detect, fileCandidates: undefined }
  }
  const backups = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.aa-backup-`))
  function assertSetup(result, def, status, message) {
    assert.deepEqual(result, { id: def.id, name: def.name, status, message })
  }
  const rawError = 'EACCES 原始错误 Ω e\u0301 / 原样保留\n$& {clients.added}'

  test('pure locale resolver honors explicit settings, auto candidates and the existing fallback', () => {
    assert.equal(resolveLocale('zh-CN', ['en-GB']), 'zh-CN')
    assert.equal(resolveLocale('en-US', ['zh-HK']), 'en-US')
    for (const [candidate, expected] of [['EN-gb', 'en-US'], ['zh-HK', 'zh-CN'], ['fr-FR', 'zh-CN'], ['', 'zh-CN']]) {
      assert.equal(resolveLocale('auto', [candidate]), expected)
      assert.equal(resolveLocale(undefined, [candidate]), expected)
    }
    assert.equal(resolveLocale('auto', ['fr-FR', 'en-AU']), 'en-US')
    assert.equal(resolveLocale('auto'), 'zh-CN')
  })
  test('pure diagnostic parameters and exception details remain opaque Unicode text', () => {
    const file = 'C:\\用户\\e\u0301 Ω\\配置.json'
    const command = 'C:\\程序 Files\\Node Ω\\node.exe'
    const bridge = 'C:\\同步盘\\Aa $& {clients.added}\\桥.cjs'
    for (const locale of ['zh-CN', 'en-US']) {
      const message = diagnosticMessage(locale, 'clients.unparseable', file, command, bridge)
      for (const value of [file, command, bridge]) assert.ok(message.includes(value))
      assert.ok(message.includes(`command="${command}", args=["${bridge}"]`))
      assert.ok(diagnosticMessage(locale, 'downloads.failed', rawError).endsWith(rawError))
    }
    assert.equal(errorDetail(new Error(rawError)), rawError)
    assert.equal(errorDetail(rawError), rawError)
    assert.equal(errorDetail({ toString: () => rawError }), rawError)
  })
  test('main locale uses the persisted setting rather than the opposite system locale', () => {
    assert.equal(getMainLocale(), 'en-US')
    assert.equal(JSON.parse(fs.readFileSync(process.env.AA_BROWSER_SETTINGS_FILE, 'utf8')).locale, 'en-US')
    useLocale('auto', 'fr-FR')
    assert.equal(getMainLocale(), 'zh-CN')
    systemLocale = 'en-GB'
    assert.equal(getMainLocale(), 'en-US')
    systemLocale = 'zh-TW'
    assert.equal(getMainLocale(), 'zh-CN')
  })

  function withAppImage(hasNode, fn) {
    const previousPackaged = app.isPackaged
    const previousPath = process.env.PATH
    const previousAppImage = process.env.APPIMAGE
    const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    const resources = nextDir()
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: 'linux' })
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    app.isPackaged = true
    process.env.APPIMAGE = path.join(resources, 'Aa Browser.AppImage')
    process.env.PATH = hasNode ? bin : resources
    try { return fn(resources) }
    finally {
      app.isPackaged = previousPackaged
      process.env.PATH = previousPath
      if (previousAppImage === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = previousAppImage
      Object.defineProperty(process, 'platform', savedPlatform)
      Object.defineProperty(process, 'resourcesPath', previousResources)
    }
  }
  function downloadItem(url = 'https://example.test/下载/e\u0301?原文=Ω') {
    const item = new EventEmitter()
    item.getFilename = () => '下载 e\u0301.txt'
    item.getURL = () => url
    item.getTotalBytes = () => 100
    item.getReceivedBytes = () => 20
    item.setSavePath = (file) => { item.savePath = file }
    return item
  }
  function downloadFixture(state = 'cancelled') {
    const tracker = new DownloadTracker()
    tracker.setDirectoryProvider(() => path.join(home, '下载 e\u0301'))
    const session = new EventEmitter()
    const requested = []
    session.downloadURL = (url) => {
      requested.push(url)
      session.emit('will-download', {}, downloadItem(url))
    }
    tracker.attach(session)
    tracker.attach(session)
    assert.equal(session.listenerCount('will-download'), 1)
    const item = downloadItem()
    session.emit('will-download', {}, item)
    if (state !== 'progressing') item.emit('done', {}, state)
    return { tracker, session, item, record: tracker.list()[0], requested }
  }

  const profiles = [
    { setting: 'zh-CN', system: 'en-GB', effective: 'zh-CN' },
    { setting: 'en-US', system: 'zh-TW', effective: 'en-US' },
    { setting: 'auto', system: 'en-GB', effective: 'en-US' },
    { setting: 'auto', system: 'zh-HK', effective: 'zh-CN' }
  ]
  for (const profile of profiles) {
    const t = (zh, en) => profile.effective === 'zh-CN' ? zh : en
    const run = (label, fn) => test(`${profile.setting}/${profile.system}: ${label}`, () => {
      useLocale(profile.setting, profile.system)
      fn()
    })
    run('manual client result has unchanged identity/status and never accesses client files', () => {
      const def = fixture('deepseek-harness')
      def.file = def.detectPath = () => { throw new Error('Manual setup must not access paths') }
      const [result] = setup([def])
      assertSetup(result, def, 'manual', t(
        '请在 DeepSeek Harness 插件市场安装并启用 Aa Browser 插件；本应用不会修改 .dsh 配置或内部状态。启用后让 Agent 实际调用 mcp__aa-browser__browser_tabs 验证。',
        'Install and enable the Aa Browser plugin in the DeepSeek Harness plugin marketplace; this app will not modify .dsh configuration or internal state. After enabling it, ask the Agent to call mcp__aa-browser__browser_tabs to verify the connection.'
      ))
      assert.deepEqual(operations, [])
    })
    run('JSON add for an undetected client retains the Unicode path and missing-directory note', () => {
      const def = fixture('cursor', undefined, false)
      const [result] = setup([def])
      assertSetup(result, def, 'added', t(
        `已写入 ${def.name} 配置：${def.file()}（客户端目录未检测到，已创建新配置）`,
        `Wrote ${def.name} configuration: ${def.file()} (Client directory not detected; created a new configuration)`
      ))
      assert.deepEqual(JSON.parse(fs.readFileSync(def.file(), 'utf8')).mcpServers['aa-browser'], clients.entryFor(def))
      assert.equal(backups(def.file()).length, 0)
    })
    run('JSONC add preserves unrelated configuration and backs up the original bytes', () => {
      const original = '{ // keep settings\n "preference": "原文 Ω", "mcpServers": { "other": { "command": "keep" }, },\n}\n'
      const def = fixture('cursor', original)
      const [result] = setup([def])
      assertSetup(result, def, 'added', t(`已写入 ${def.name} 配置：${def.file()}`, `Wrote ${def.name} configuration: ${def.file()}`))
      const written = parseJsonc(fs.readFileSync(def.file(), 'utf8'))
      assert.equal(written.preference, '原文 Ω')
      assert.deepEqual(written.mcpServers.other, { command: 'keep' })
      assert.deepEqual(written.mcpServers['aa-browser'], clients.entryFor(def))
      assert.equal(backups(def.file()).length, 1)
      assert.equal(fs.readFileSync(path.join(path.dirname(def.file()), backups(def.file())[0]), 'utf8'), original)
    })
    run('JSONC insertion honors the file indent unit; minified files stay compact', () => {
      const { replaceJsonEntry } = require(path.join(runDir, 'compiled/main/client-config.js'))
      const pretty = '{\n  "preference": "keep",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n'
      const prettyOut = replaceJsonEntry(pretty, 'mcpServers', { command: 'node', args: ['b.cjs'] })
      assert.ok(prettyOut.split('\n').length > pretty.split('\n').length, 'pretty files gain real lines')
      assert.ok(prettyOut.includes('\n    "aa-browser"'), 'inserted entry uses the file indent unit')
      assert.equal(JSON.parse(prettyOut).preference, 'keep')
      const miniOut = replaceJsonEntry('{"a":1}', 'mcpServers', { command: 'n' })
      assert.ok(!miniOut.includes('\n  '), 'minified files stay minified')
      assert.deepEqual(JSON.parse(miniOut).mcpServers['aa-browser'], { command: 'n' })
    })
    run('TOML repeated updates do not accumulate blank lines and stay parseable', () => {
      const { replaceTomlEntry } = require(path.join(runDir, 'compiled/main/client-config.js'))
      const { parse: parseToml } = require('smol-toml')
      let text = '[other]\nkey = "v"\n\n[mcp_servers.other]\nc = "x"\n'
      for (const command of ['node1', 'node2', 'node3']) {
        text = replaceTomlEntry(text, `[mcp_servers."aa-browser"]\ncommand = "${command}"\n`)
      }
      assert.ok(!/\n{3,}/.test(text), 'No triple+ newline runs after repeated updates')
      assert.equal(parseToml(text).mcp_servers['aa-browser'].command, 'node3')
      assert.equal(parseToml(text).other.key, 'v')
    })
    run('JSON update and skip retain statuses, unrelated keys and existing backup behavior', () => {
      const original = JSON.stringify({ preference: '保留', mcpServers: { other: { command: 'keep' }, 'aa-browser': { command: 'old' } } })
      const def = fixture('cursor', original)
      const [updated] = setup([def])
      assertSetup(updated, def, 'updated', t(`已更新 ${def.name} 配置：${def.file()}`, `Updated ${def.name} configuration: ${def.file()}`))
      const written = fs.readFileSync(def.file(), 'utf8')
      assert.equal(JSON.parse(written).preference, '保留')
      assert.deepEqual(JSON.parse(written).mcpServers.other, { command: 'keep' })
      assert.equal(fs.readFileSync(path.join(path.dirname(def.file()), backups(def.file())[0]), 'utf8'), original)
      operations.length = 0
      const [skipped] = setup([def])
      assertSetup(skipped, def, 'skipped', t(`已配置且无需更新：${def.file()}`, `Already configured; no update needed: ${def.file()}`))
      assert.equal(fs.readFileSync(def.file(), 'utf8'), written)
      assert.equal(operations.filter(({ method }) => method === 'copyFileSync').length, 0, 'An unchanged entry does not create another backup')
      assert.equal(operations.filter(({ method }) => method === 'writeFileSync').length, 0)
    })
    run('corrupt JSON is backed up but not overwritten, with original command and bridge in manual advice', () => {
      const original = '{ 损坏 JSON e\u0301'
      const def = fixture('cursor', original)
      const entry = clients.bridgeEntry()
      const [result] = setup([def])
      assertSetup(result, def, 'manual', t(
        `配置文件存在但无法解析（${def.file()}），已跳过自动写入。请手动添加 MCP 条目：command="${entry.command}", args=["${entry.args[0]}"]`,
        `The configuration file exists but could not be parsed (${def.file()}); automatic writing was skipped. Add the MCP entry manually: command="${entry.command}", args=["${entry.args[0]}"]`
      ))
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
      assert.equal(fs.readFileSync(path.join(path.dirname(def.file()), backups(def.file())[0]), 'utf8'), original)
      assert.equal(operations.filter(({ method }) => method === 'writeFileSync').length, 0)
    })
    run('Codex add then skip preserves TOML, line endings and avoids repeat writes', () => {
      const original = '# 用户设置\r\nmodel = "keep"\r\n\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n'
      const def = fixture('codex', original)
      const [added] = setup([def])
      assertSetup(added, def, 'added', t(`已写入 Codex MCP 配置：${def.file()}`, `Wrote Codex MCP configuration: ${def.file()}`))
      const written = fs.readFileSync(def.file(), 'utf8')
      assert.ok(written.startsWith(original))
      assert.ok(written.includes('[mcp_servers.aa-browser]\r\n'))
      assert.equal(fs.readFileSync(path.join(path.dirname(def.file()), backups(def.file())[0]), 'utf8'), original)
      operations.length = 0
      const [skipped] = setup([def])
      assertSetup(skipped, def, 'skipped', t(`已配置且无需更新：${def.file()}`, `Already configured; no update needed: ${def.file()}`))
      assert.equal(fs.readFileSync(def.file(), 'utf8'), written)
      assert.equal(operations.filter(({ method }) => ['copyFileSync', 'writeFileSync', 'renameSync'].includes(method)).length, 0)
      const detected = withDefs([def], () => clients.detectClients())[0]
      assert.equal(detected.configured, true)
      assert.equal(detected.outdated, false)
    })
    run('Codex creation and update do not alter unrelated TOML blocks', () => {
      const fresh = fixture('codex')
      assertSetup(setup([fresh])[0], fresh, 'added', t(`已写入 Codex MCP 配置：${fresh.file()}`, `Wrote Codex MCP configuration: ${fresh.file()}`))
      assert.equal(backups(fresh.file()).length, 0)
      const original = '# keep\n[mcp_servers."aa-browser"]\ncommand = "old"\n[mcp_servers."aa-browser".env]\nOLD = "remove"\n[mcp_servers.other]\ncommand = "keep"\n'
      const def = fixture('codex', original)
      assertSetup(setup([def])[0], def, 'updated', t(`已更新 Codex MCP 配置：${def.file()}`, `Updated Codex MCP configuration: ${def.file()}`))
      const written = fs.readFileSync(def.file(), 'utf8')
      assert.ok(written.includes('[mcp_servers.other]\ncommand = "keep"'))
      assert.ok(!written.includes('OLD = "remove"'))
      assert.equal((written.match(/\[mcp_servers\.aa-browser\]/g) || []).length, 1)
      assert.equal(fs.readFileSync(path.join(path.dirname(def.file()), backups(def.file())[0]), 'utf8'), original)
    })
    for (const id of ['cursor', 'codex']) {
      for (const method of ['copyFileSync', 'readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
        run(`${id} ${method} error retains the raw exception and error status`, () => {
          const original = id === 'codex' ? 'model = "keep"\n' : '{"preference":"keep"}'
          const def = fixture(id, original)
          const detail = `${rawError}\n${def.file()}`
          fsFault = (called, args) => {
            if (called === method) throw new Error(detail)
          }
          const expected = id === 'codex'
            ? t(`写入 Codex 配置失败：${detail}`, `Failed to write Codex configuration: ${detail}`)
            : t(`写入 ${def.name} 失败：${detail}`, `Failed to write ${def.name} configuration: ${detail}`)
          assertSetup(setup([def])[0], def, 'error', expected)
          assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
        })
      }
      run(`${id} native filesystem error keeps the exact Unicode path and native error text`, () => {
        const def = fixture(id)
        const blocker = path.join(path.dirname(def.file()), '不可建目录 e\u0301')
        fs.writeFileSync(blocker, 'not a directory')
        def.file = () => path.join(blocker, '配置.json')
        const [result] = setup([def])
        assert.ok(lastFilesystemError instanceof Error)
        assert.ok(lastFilesystemError.message.includes(blocker))
        const expected = id === 'codex'
          ? t(`写入 Codex 配置失败：${lastFilesystemError.message}`, `Failed to write Codex configuration: ${lastFilesystemError.message}`)
          : t(`写入 ${def.name} 失败：${lastFilesystemError.message}`, `Failed to write ${def.name} configuration: ${lastFilesystemError.message}`)
        assertSetup(result, def, 'error', expected)
        assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory')
      })
    }
    run('AppImage missing-Node preflight localizes the Aa error for every selected client', () => {
      const defs = [fixture('cursor'), fixture('deepseek-harness'), fixture('codex')]
      const results = withAppImage(false, () => setup(defs, ['codex', 'unknown', 'cursor', 'deepseek-harness']))
      assert.equal(results.length, 3)
      for (const [index, def] of defs.entries()) {
        assertSetup(results[index], def, 'error', t('Error: 请先安装 Node.js 22 并重新打开 Aa Browser。', 'Error: Install Node.js 22 and reopen Aa Browser first.'))
        assert.equal(fs.existsSync(def.file()), false)
      }
      assert.equal(operations.some(({ method }) => method === 'writeFileSync'), false)
    })
    run('AppImage bridge-sync preflight returns the untouched external error for each client', () => {
      const defs = [fixture('cursor'), fixture('codex')]
      const results = withAppImage(true, () => setup(defs))
      assert.ok(lastFilesystemError instanceof Error)
      for (const [index, def] of defs.entries()) {
        assertSetup(results[index], def, 'error', String(lastFilesystemError))
        assert.equal(fs.existsSync(def.file()), false)
      }
      assert.equal(operations.some(({ method }) => method === 'writeFileSync'), false)
    })
    run('download missing-record reason retains the original Unicode id', () => {
      const id = '下载记录 e\u0301 $& Ω'
      assert.deepEqual(retry(new DownloadTracker(), id), { ok: false, reason: t(`找不到下载记录 ${id}`, `Download record not found: ${id}`) })
    })
    run('download active reason takes precedence over the URL guard', () => {
      const { tracker, record, requested } = downloadFixture('progressing')
      tracker.setUrlGuard(() => { throw new Error('The guard must not run for an active download') })
      assert.deepEqual(retry(tracker, record.id), { ok: false, reason: t('该下载仍在进行中，无法重试', 'This download is still in progress and cannot be retried') })
      assert.deepEqual(requested, [])
      assert.equal(record.state, 'progressing')
    })
    run('download default deny and explicit allowlist rejection never dispatch a download', () => {
      const { tracker, record, requested } = downloadFixture()
      const expected = { ok: false, reason: t('该下载地址不在当前站点白名单内，已拒绝重试', 'This download URL is not on the current site allowlist; retry denied') }
      assert.deepEqual(retry(tracker, record.id), expected)
      tracker.setUrlGuard((url) => { assert.equal(url, record.url); return false })
      assert.deepEqual(retry(tracker, record.id), expected)
      assert.deepEqual(requested, [])
    })
    run('download missing-session reason is emitted only after allowlist approval', () => {
      const { tracker, record, requested } = downloadFixture()
      tracker.setUrlGuard(() => true)
      // Simulate a record whose original session is no longer available.
      tracker.recordSessions.delete(record.id)
      assert.deepEqual(retry(tracker, record.id), { ok: false, reason: t('无法找到该下载所属的浏览器会话', 'The browser session for this download could not be found') })
      assert.deepEqual(requested, [])
    })
    run('download dispatch failure keeps raw errors and rolls back the pending retry marker', () => {
      const { tracker, session, record } = downloadFixture()
      const detail = `${rawError}\n${record.savePath}`
      tracker.setUrlGuard(() => true)
      session.downloadURL = () => { throw new Error(detail) }
      assert.deepEqual(retry(tracker, record.id), { ok: false, reason: t(`重新发起下载失败：${detail}`, `Failed to restart the download: ${detail}`) })
      session.emit('will-download', {}, downloadItem())
      assert.equal(tracker.list().at(-1).retriedFrom, undefined)
      assert.equal(record.state, 'cancelled')
    })
    run('successful download retries keep the original URL, record, session and success shape', () => {
      for (const state of ['completed', 'cancelled', 'interrupted']) {
        const { tracker, record, requested } = downloadFixture(state)
        const original = { ...record }
        tracker.setUrlGuard((url) => { assert.equal(url, original.url); return true })
        assert.deepEqual(retry(tracker, record.id), { ok: true })
        assert.deepEqual(requested, [original.url])
        assert.deepEqual(record, original)
        const retried = tracker.list().at(-1)
        assert.equal(retried.retriedFrom, record.id)
        assert.equal(retried.state, 'progressing')
        assert.notEqual(retried.savePath, record.savePath)
        assert.ok(path.basename(retried.savePath).includes('-r'))
        assert.equal(retried.filename, '下载 e\u0301.txt')
      }
    })
  }

  for (const id of ['cursor', 'codex', 'workbuddy']) {
    test(`${id} keeps the current recovery point plus four historical backups, ignoring lookalikes`, () => {
      useLocale('en-US', 'zh-TW')
      const original = id === 'codex' ? 'model = "keep"\r\n' : '{"preference":"keep"}\r\n'
      const def = fixture(id, original)
      const dir = path.dirname(def.file())
      const prefix = `${path.basename(def.file())}.aa-backup-`
      const uuid = '00000000-0000-4000-8000-000000000001'
      const old = [`${prefix}2000-01-01T00-00-00`, `${prefix}2000-01-02T00-00-00-001Z-${uuid}`]
      const future = Array.from({ length: 5 }, (_, i) => `${prefix}2099-01-01T00-00-0${i}${i % 2 ? `-001Z-${uuid}` : ''}`)
      if (id === 'workbuddy') future[4] += '-001Z' // Also produced by the standalone WorkBuddy installer.
      for (const name of [...old, ...future]) fs.writeFileSync(path.join(dir, name), name)

      const notes = [`${prefix}notes`, `${prefix}1999-01-01T00-00-00-000Z-${uuid}.notes`, `${prefix}1999-02-30T00-00-00`]
      if (id !== 'workbuddy') notes.push(`${prefix}1999-01-01T00-00-00-000Z`)
      const otherConfig = 'other.json.aa-backup-1999-01-01T00-00-00'
      for (const name of [...notes, otherConfig]) fs.writeFileSync(path.join(dir, name), 'user data')
      const directory = `${prefix}1999-01-02T00-00-00`
      fs.mkdirSync(path.join(dir, directory))
      const target = path.join(dir, directory, 'user.txt')
      fs.writeFileSync(target, 'keep target')
      const link = `${prefix}1999-01-03T00-00-00`
      const linkPath = path.join(dir, link)
      try {
        fs.symlinkSync(target, linkPath, 'file')
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
        fs.symlinkSync(path.dirname(target), linkPath, 'junction')
      }
      const linkTarget = fs.readlinkSync(linkPath)

      assert.equal(setup([def])[0].status, 'added')
      const kept = backups(def.file()).filter((name) => ![...notes, directory, link].includes(name))
      const fresh = kept.filter((name) => !future.includes(name))
      assert.equal(fresh.length, 1)
      assert.deepEqual(kept.sort(), [...future.slice(1), fresh[0]].sort(), 'Keep the current backup and the four newest historical backups')
      assert.equal(fs.readFileSync(path.join(dir, fresh[0]), 'utf8'), original)
      for (const name of future.slice(1)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name)
      for (const name of [...notes, otherConfig]) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'user data')
      assert.ok(fs.lstatSync(path.join(dir, directory)).isDirectory())
      assert.equal(fs.readlinkSync(linkPath), linkTarget)
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep target')
    })
  }
  test('write failures preserve all historical backups as well as the pre-write copy', () => {
    useLocale('en-US', 'zh-TW')
    for (const [id, original] of [['cursor', '{}\n'], ['codex', 'model = "keep"\n']]) {
      const def = fixture(id, original)
      const dir = path.dirname(def.file())
      const old = Array.from({ length: 5 }, (_, i) => `${path.basename(def.file())}.aa-backup-2000-01-01T00-00-0${i}`)
      for (const name of old) fs.writeFileSync(path.join(dir, name), name)
      fsFault = (method, args) => { if (method === 'renameSync' && args[1] === def.file()) throw new Error('fixture write failure') }
      assert.equal(setup([def])[0].status, 'error')
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
      for (const name of old) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name)
      const fresh = backups(def.file()).filter((name) => !old.includes(name))
      assert.equal(fresh.length, 1)
      assert.equal(fs.readFileSync(path.join(dir, fresh[0]), 'utf8'), original)
    }
  })

  test('JSONC preserves string contents, comments and unrelated formatting', () => {
    useLocale('en-US', 'zh-TW')
    const original = '{\r\n  // keep comment\r\n  "url": "https://example.test/a//b",\r\n  "literal": "/*not a comment*/ ,}",\r\n  "servers": { "other": { "command": "keep" }, },\r\n}\r\n'
    const def = fixture('vscode', original)
    assert.equal(setup([def])[0].status, 'added')
    const written = fs.readFileSync(def.file(), 'utf8')
    assert.ok(written.includes('  // keep comment\r\n'))
    assert.ok(written.includes('"url": "https://example.test/a//b"'))
    assert.ok(written.includes('"literal": "/*not a comment*/ ,}"'))
    assert.ok(written.includes('"other": { "command": "keep" }'))
    assert.equal(setup([def])[0].status, 'skipped')
  })
  test('non-object JSON roots and incompatible containers are never replaced', () => {
    useLocale('en-US', 'zh-TW')
    for (const original of ['[]', '[1]', 'null', '"text"', '42', '{"mcpServers":[]}', '{"mcpServers":"keep"}', '{"mcpServers":null}']) {
      const def = fixture('cursor', original)
      const result = setup([def])[0]
      assert.equal(result.status, 'manual', original)
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
    }
  })
  test('Codex replacement preserves unrelated array tables and header-looking multiline strings', () => {
    useLocale('en-US', 'zh-TW')
    const original = '# keep\nmodel = "keep"\nprompt = """\n[mcp_servers.aa-browser]\nThis is not a table.\n"""\n[mcp_servers.aa-browser]\ncommand = "old"\n[mcp_servers.aa-browser.env]\nOLD = "old"\n[[projects]]\nname = "keep"\n[[projects.rules]]\npattern = "keep too"\n'
    const def = fixture('codex', original)
    assert.equal(setup([def])[0].status, 'updated')
    const written = fs.readFileSync(def.file(), 'utf8')
    assert.ok(written.includes('prompt = """\n[mcp_servers.aa-browser]\nThis is not a table.\n"""'))
    assert.ok(written.includes('[[projects]]\nname = "keep"\n[[projects.rules]]\npattern = "keep too"'))
    assert.equal(setup([def])[0].status, 'skipped')
  })
  test('invalid TOML is left untouched rather than appending to a broken document', () => {
    useLocale('en-US', 'zh-TW')
    for (const original of ['model = "unterminated', '[mcp_servers.aa-browser]\ncommand = "first"\ncommand = "duplicate"\n']) {
      const def = fixture('codex', original)
      assert.equal(setup([def])[0].status, 'error')
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
    }
  })
  test('same-millisecond downloads have unique paths and IDs even after the history cap', () => {
    const now = Date.now
    Date.now = () => 1234567890
    try {
      const tracker = new DownloadTracker()
      tracker.setDirectoryProvider(() => path.join(home, 'downloads'))
      const session = new EventEmitter()
      tracker.attach(session)
      const ids = new Set()
      const paths = new Set()
      for (let index = 0; index < 105; index++) {
        const item = downloadItem()
        session.emit('will-download', {}, item)
        const current = tracker.list(1)[0]
        assert.ok(!paths.has(item.savePath), 'Distinct downloads must never share an output path')
        assert.ok(!ids.has(current.id), 'Opaque record IDs must remain unique after trimming')
        assert.match(current.id, /^d[a-z0-9]+$/, 'Preserve the existing alphanumeric download ID shape')
        paths.add(item.savePath)
        ids.add(current.id)
        item.emit('done', {}, 'completed')
      }
      assert.equal(tracker.list(100).length, 100)
    } finally { Date.now = now }
  })
  test('unique download prefixes keep long Unicode filenames within the leaf-name budget', () => {
    const tracker = new DownloadTracker()
    tracker.setDirectoryProvider(() => path.join(home, 'downloads'))
    const session = new EventEmitter()
    tracker.attach(session)
    for (const name of ['报告😀'.repeat(80) + '.pdf', 'x'.repeat(250) + '.txt', 'ordinary.txt']) {
      const item = downloadItem()
      item.getFilename = () => name
      session.emit('will-download', {}, item)
      const current = tracker.list(1)[0]
      assert.equal(current.filename, name, 'Keep the original display name')
      assert.ok(Buffer.byteLength(path.basename(item.savePath)) <= 255)
      assert.ok(item.savePath.endsWith(path.extname(name)))
      assert.ok(!path.basename(item.savePath).includes('\uFFFD'), 'Do not split a Unicode code point')
      item.emit('done', {}, 'completed')
    }
  })
  test('duplicate JSON keys are ambiguous and stay untouched', () => {
    useLocale('en-US', 'zh-TW')
    for (const original of ['{"mcpServers":{},"mcpServers":{"other":{"command":"keep"}}}', '{"preference":{"same":1,"same":2}}']) {
      const def = fixture('cursor', original)
      assert.equal(setup([def])[0].status, 'manual')
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
    }
  })
  test('inline and dotted TOML entry layouts fail closed without modifying the file', () => {
    useLocale('en-US', 'zh-TW')
    for (const original of ['mcp_servers = { aa-browser = { command = "keep" } }\n', 'mcp_servers.aa-browser.command = "keep"\n']) {
      const def = fixture('codex', original)
      assert.equal(setup([def])[0].status, 'error')
      assert.equal(fs.readFileSync(def.file(), 'utf8'), original)
      assert.equal(backups(def.file()).length, 0)
    }
  })
  test('a broken client file cannot abort discovery for healthy clients', () => {
    const broken = fixture('cursor', 'broken JSON')
    const codex = fixture('codex', 'model = "broken')
    const healthy = fixture('vscode')
    assert.equal(setup([healthy])[0].status, 'added')
    const results = withDefs([broken, codex, healthy], () => clients.detectClients())
    assert.equal(results.length, 3)
    assert.deepEqual(results.map((result) => result.configured), [false, false, true])
  })
  test('setup captures the saved locale before any write and re-resolves on the next call', () => {
    useLocale('en-US', 'en-GB')
    const defs = [fixture('cursor'), fixture('deepseek-harness'), fixture('codex')]
    let changed = false
    fsObserver = (method, args) => {
      if (!changed && method === 'renameSync' && args[1] === defs[0].file()) {
        changed = true
        store.set({ locale: 'zh-CN' })
        systemLocale = 'zh-HK'
      }
    }
    const results = withDefs(defs, () => clients.setupClients(defs.map((def) => def.id)))
    assert.equal(changed, true)
    assert.equal(localeReads, 1)
    assertSetup(results[0], defs[0], 'added', `Wrote ${defs[0].name} configuration: ${defs[0].file()}`)
    assert.ok(results[1].message.startsWith('Install and enable'))
    assertSetup(results[2], defs[2], 'added', `Wrote Codex MCP configuration: ${defs[2].file()}`)
    fsObserver = undefined
    assertSetup(setup([defs[0]])[0], defs[0], 'skipped', `已配置且无需更新：${defs[0].file()}`)
  })
  test('auto setup captures the system candidate before writing any client', () => {
    useLocale('auto', 'en-GB')
    const defs = [fixture('cursor'), fixture('codex')]
    fsObserver = (method, args) => {
      if (method === 'renameSync' && args[1] === defs[0].file()) systemLocale = 'zh-HK'
    }
    const results = setup(defs)
    assertSetup(results[0], defs[0], 'added', `Wrote ${defs[0].name} configuration: ${defs[0].file()}`)
    assertSetup(results[1], defs[1], 'added', `Wrote Codex MCP configuration: ${defs[1].file()}`)
  })
  test('retry captures locale before session dispatch and reads changed settings on the next call', () => {
    useLocale('en-US', 'en-GB')
    const { tracker, session, record } = downloadFixture()
    tracker.setUrlGuard(() => true)
    session.downloadURL = () => { store.set({ locale: 'zh-CN' }); throw rawError }
    assert.deepEqual(tracker.retry(record.id), { ok: false, reason: `Failed to restart the download: ${rawError}` })
    assert.equal(localeReads, 1)
    session.downloadURL = () => { throw rawError }
    assert.deepEqual(retry(tracker, record.id), { ok: false, reason: `重新发起下载失败：${rawError}` })
  })
  test('non-Error client exceptions retain their raw text', () => {
    useLocale('en-US', 'zh-TW')
    for (const id of ['cursor', 'codex']) {
      const def = fixture(id)
      fsFault = (method, args) => { if (method === 'renameSync' && args[1] === def.file()) throw rawError }
      assertSetup(setup([def])[0], def, 'error', id === 'codex'
        ? `Failed to write Codex configuration: ${rawError}` : `Failed to write ${def.name} configuration: ${rawError}`)
    }
  })
  for (const id of ['cline', 'vscode', 'opencode', 'workbuddy']) {
    const english = { cline: 'Cline (VS Code extension)', vscode: 'VS Code (native MCP)', opencode: 'OpenCode (open source)', workbuddy: 'WorkBuddy' }[id]
    test(`messages for ${id} use the English display name while the name field keeps its stored value`, () => {
      useLocale('en-US', 'zh-TW')
      const def = fixture(id)
      const [added] = setup([def])
      assert.equal(added.name, def.name)
      assert.ok(added.message.startsWith(`Wrote ${english} configuration: `))
      const outdated = JSON.parse(fs.readFileSync(def.file(), 'utf8'))
      const container = def.container.split('.').reduce((value, key) => value[key], outdated)
      container['aa-browser'] = { command: 'outdated' }
      fs.writeFileSync(def.file(), JSON.stringify(outdated))
      const [updated] = setup([def])
      assert.equal(updated.status, 'updated')
      assert.equal(updated.name, def.name)
      assert.ok(updated.message.startsWith(`Updated ${english} configuration: `), updated.message)
      const failing = fixture(id)
      fsFault = (method, args) => { if (method === 'renameSync' && args[1] === failing.file()) throw rawError }
      const [failed] = setup([failing])
      assert.equal(failed.status, 'error')
      assert.equal(failed.name, failing.name)
      assert.ok(failed.message.startsWith(`Failed to write ${english} configuration: ${rawError}`))
      useLocale('zh-CN', 'en-GB')
      const zhDef = fixture(id)
      const [zhAdded] = setup([zhDef])
      assert.equal(zhAdded.name, zhDef.name)
      assert.ok(zhAdded.message.startsWith(`已写入 ${zhDef.name} 配置：`), zhAdded.message)
    })
  }
  test('unknown client ids keep their stored name in every message locale', () => {
    // Keep the generic JSON branch explicit so this exercises the id-based name, not Codex's fixed label.
    const custom = () => ({ ...fixture('cursor'), id: 'custom-Ω', name: '自定义 Ω 客户端', toml: false })
    useLocale('en-US', 'zh-TW')
    const [added] = setup([custom()])
    assert.equal(added.id, 'custom-Ω')
    assert.equal(added.name, '自定义 Ω 客户端')
    assert.equal(added.status, 'added')
    assert.ok(added.message.startsWith('Wrote 自定义 Ω 客户端 configuration: '), added.message)
    useLocale('zh-CN', 'en-GB')
    const [zhAdded] = setup([custom()])
    assert.equal(zhAdded.status, 'added')
    assert.equal(zhAdded.name, '自定义 Ω 客户端')
    assert.ok(zhAdded.message.startsWith('已写入 自定义 Ω 客户端 配置：'), zhAdded.message)
  })
  test('client scanning, nested containers, candidate preference and OpenCode schema remain unchanged', () => {
    useLocale('en-US', 'zh-TW')
    const nested = fixture('zcode', '{"mcp":{"other":"keep","servers":{"other":{"command":"keep"}}}}')
    const openCode = fixture('opencode')
    const preferred = path.join(path.dirname(openCode.file()), '现有配置 e\u0301.json')
    fs.writeFileSync(preferred, '{"model":"keep","mcp":{"other":{"type":"local","command":["keep"]}}}')
    openCode.fileCandidates = () => [openCode.file(), preferred]
    const defs = [nested, openCode]
    const before = withDefs(defs, () => clients.detectClients())
    assert.deepEqual(before.map(({ id, installed, configured, outdated, file }) => ({ id, installed, configured, outdated, file })), [
      { id: nested.id, installed: true, configured: false, outdated: false, file: nested.file() },
      { id: openCode.id, installed: true, configured: false, outdated: false, file: preferred }
    ])
    assert.equal(localeReads, 0, 'Scanning does not gain a locale dependency')
    setup(defs)
    const nestedConfig = JSON.parse(fs.readFileSync(nested.file(), 'utf8'))
    assert.equal(nestedConfig.mcp.other, 'keep')
    assert.deepEqual(nestedConfig.mcp.servers.other, { command: 'keep' })
    assert.deepEqual(nestedConfig.mcp.servers['aa-browser'], clients.entryFor(nested))
    const config = JSON.parse(fs.readFileSync(preferred, 'utf8'))
    assert.equal(config.model, 'keep')
    assert.deepEqual(config.mcp.other, { type: 'local', command: ['keep'] })
    assert.deepEqual(config.mcp['aa-browser'], clients.entryFor(openCode))
    assert.equal(fs.existsSync(openCode.file()), false)
    const bridge = clients.bridgeEntry().args[0]
    fs.mkdirSync(path.dirname(bridge), { recursive: true })
    fs.writeFileSync(bridge, '// isolated bridge fixture')
    const after = withDefs(defs, () => clients.detectClients())
    assert.ok(after.every((entry) => entry.installed && entry.configured && !entry.outdated))
  })
  test('unknown selections remain empty and do not write client files', () => {
    useLocale('en-US', 'zh-TW')
    assert.deepEqual(setup([fixture('cursor')], ['unknown']), [])
    assert.deepEqual(operations, [])
  })
  assert.deepEqual(violations, [])
  console.log(`${checks - failures}/${checks} main diagnostic checks passed (Node only; isolated filesystem; no Electron process)`)
  process.exitCode = failures ? 1 : 0
} finally {
  Module._load = originalLoad
  Object.defineProperty(process, 'platform', savedPlatform)
  if (savedResourcesPath) Object.defineProperty(process, 'resourcesPath', savedResourcesPath)
  else delete process.resourcesPath
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key]
  Object.assign(process.env, savedEnvironment)
  fs.rmSync(runDir, { recursive: true, force: true })
}
