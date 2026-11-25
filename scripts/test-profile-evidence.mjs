#!/usr/bin/env node
/** Production evidence/baseline/viewport isolation and malicious-file regressions. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { compileFunction } from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-profile-evidence-'))
const compiled = path.join(temporary, 'compiled')
const firstId = 'p' + 'a'.repeat(24)
const secondId = 'p' + 'b'.repeat(24)
let current = firstId
let passed = 0
const oldEnvironment = Object.fromEntries(['AA_BROWSER_EVIDENCE_FILE', 'AA_BROWSER_BASELINE_DIR', 'AA_BROWSER_SCREENSHOT_DIR'].map((key) => [key, process.env[key]]))

function load(name, dependencies = {}) {
  const filename = path.join(compiled, `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (specifier) => {
      if (specifier.startsWith('node:')) return require(specifier)
      if (specifier === './atomic-json') return load('atomic-json')
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency ${specifier}`)
      return dependencies[specifier]
    }, module, module.exports
  )
  return module.exports
}

async function check(name, run) {
  await run()
  console.log(`PASS: ${name}`)
  passed++
}

function png(width, height, raw = Buffer.alloc(height * (width * 4 + 1), 0)) {
  function chunk(type, body) {
    const kind = Buffer.from(type)
    let crc = 0xffffffff
    for (const byte of Buffer.concat([kind, body])) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, kind, body, checksum])
  }
  const dimensions = Buffer.alloc(13)
  dimensions.writeUInt32BE(width)
  dimensions.writeUInt32BE(height, 4)
  dimensions[8] = 8
  dimensions[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', dimensions), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

try {
  const compilation = spawnSync(process.execPath, [
    path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', compiled,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['evidence', 'visual', 'viewport', 'monitor', 'atomic-json'].map((name) => path.join(root, 'src/main', `${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr)
  const evidence = load('evidence')
  const actions = {
    ActionError: class ActionError extends Error {},
    throwIfAborted(signal) { if (signal?.aborted) throw new Error('aborted') },
    async raceAbort(work, signal) { if (signal?.aborted) throw new Error('aborted'); return work }
  }
  const dependencies = { './actions': actions, './evidence': evidence, './progress': { reportProgress() {} } }
  const visual = load('visual', dependencies)
  const viewport = load('viewport', dependencies)
  const nativeImage = { createFromBuffer(bytes) { return { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toPNG: () => bytes } } }
  const { BrowserMonitor, configureMonitorProfiles } = load('monitor', { './visual': visual, './evidence': evidence, electron: { nativeImage } })
  const directory = (id, kind) => path.join(temporary, id, kind)
  const registry = (id) => path.join(temporary, id, 'evidence.json')
  evidence.configureEvidenceProfiles(() => current, registry)
  visual.configureVisualProfiles(() => current, (id) => directory(id, 'baselines'))
  viewport.configureViewportProfiles(() => current, (id) => directory(id, 'screenshots'))
  configureMonitorProfiles(() => current, (id) => directory(id, 'monitor'))
  const first = evidence.getEvidenceManager(firstId)
  const second = evidence.getEvidenceManager(secondId)
  const image = png(2, 1)
  function tab(id) {
    const commands = []
    const dbg = {
      attached: false,
      isAttached() { return this.attached }, attach() { this.attached = true }, detach() { this.attached = false },
      async sendCommand(method, params) {
        commands.push([method, params])
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { width: 2, height: 1 } }
        if (method === 'Page.captureScreenshot') return { data: image.toString('base64') }
        return {}
      }
    }
    return { profileId: id, id: `tab-${id}`, url: 'https://user:password@fixture.test/view?token=secret#credential',
      canUseWindowInput: () => true, commands, keepRendering: () => () => {},
      view: { webContents: { debugger: dbg, isDestroyed: () => false, getURL: () => 'https://fixture.test/view?token=secret#credential', getTitle: () => 'Fixture', executeJavaScript: async () => ({ width: 800, height: 600, deviceScaleFactor: 1, innerWidth: 800, innerHeight: 600, scrollWidth: 800 }) } } }
  }
  const firstTab = tab(firstId)
  const secondTab = tab(secondId)
  await check('Profile evidence registries cannot list, hash or forget another Profile exports', async () => {
    const firstFile = path.join(temporary, 'first.png')
    const secondFile = path.join(temporary, 'second.png')
    fs.writeFileSync(firstFile, image)
    fs.writeFileSync(secondFile, image)
    first.record(firstFile, 'baseline')
    second.record(secondFile, 'baseline')
    assert.deepEqual(first.list().map((entry) => entry.file), [firstFile])
    assert.deepEqual(second.list().map((entry) => entry.file), [secondFile])
    assert.throws(() => first.hash(secondFile), /EVIDENCE_ACCESS_DENIED/)
    assert.equal(first.forget(secondFile), false)
    assert.equal(second.hash(secondFile), first.hash(firstFile))
    const copy = first.list()[0]
    copy.identity.ino = '0'
    assert.notEqual(first.list()[0].identity.ino, '0')
  })
  await check('same baseline names are independently saved and evidence follows tab Profile', async () => {
    current = secondId
    const a = await visual.visualSave(firstTab, 'same-name')
    const b = await visual.visualSave(secondTab, 'same-name')
    assert.notEqual(a.file, b.file)
    assert.equal(path.dirname(a.file), directory(firstId, 'baselines'))
    assert.equal(path.dirname(b.file), directory(secondId, 'baselines'))
    assert.ok(first.list().some((entry) => entry.file === a.file))
    assert.ok(second.list().some((entry) => entry.file === b.file))
    assert.equal(a.url, 'https://fixture.test/view')
    current = firstId
    assert.deepEqual(visual.visualList().map((entry) => entry.file), [a.file])
    assert.equal((await visual.visualCompare(firstTab, 'same-name')).ok, true)
    assert.equal(visual.visualDelete('same-name'), true)
    assert.equal(fs.existsSync(b.file), true)
    assert.equal((await visual.visualCompare(secondTab, 'same-name')).ok, true)
  })
  await check('baseline metadata cannot redirect image reads or delete across Profiles', async () => {
    const victim = (await visual.visualSave(secondTab, 'victim')).file
    const metadata = await visual.visualSave(firstTab, 'poisoned')
    const metaFile = path.join(path.dirname(metadata.file), 'poisoned.json')
    fs.writeFileSync(metaFile, JSON.stringify({ ...metadata, file: victim }))
    await assert.rejects(visual.visualCompare(firstTab, 'poisoned'), /元数据已损坏/)
    assert.equal(visual.visualList(firstId).some((entry) => entry.name === 'poisoned'), false)
    assert.equal(visual.visualDelete('poisoned', firstId), true)
    assert.equal(fs.existsSync(victim), true)
  })
  await check('metadata names and decoded image dimensions must match the requested baseline', async () => {
    const metadata = await visual.visualSave(firstTab, 'metadata')
    const file = path.join(path.dirname(metadata.file), 'metadata.json')
    fs.writeFileSync(file, JSON.stringify({ ...metadata, name: 'other' }))
    await assert.rejects(visual.visualCompare(firstTab, 'metadata'), /元数据已损坏/)
    fs.writeFileSync(file, JSON.stringify({ ...metadata, width: 3 }))
    await assert.rejects(visual.visualCompare(firstTab, 'metadata'), /尺寸不符/)
  })
  await check('PNG dimensions and deflate expansion are bounded before pixel allocation', async () => {
    const metadata = await visual.visualSave(firstTab, 'oversized')
    const huge = Buffer.from(image)
    huge.writeUInt32BE(100_000, 16)
    huge.writeUInt32BE(100_000, 20)
    fs.writeFileSync(metadata.file, huge)
    await assert.rejects(visual.visualCompare(firstTab, 'oversized'), /IMAGE_TOO_LARGE/)
    fs.writeFileSync(metadata.file, png(2, 1, Buffer.alloc(10_000)))
    await assert.rejects(visual.visualCompare(firstTab, 'oversized'), /压缩数据损坏或超出预期/)
  })
  await check('viewport outputs and ownership use tab Profile with collision resistant names', async () => {
    current = secondId
    const spec = [{ name: 'desktop', width: 800, height: 600 }]
    const a = await viewport.captureViewportMatrix(firstTab, spec)
    const again = await viewport.captureViewportMatrix(firstTab, spec)
    const b = await viewport.captureViewportMatrix(secondTab, spec)
    assert.equal(path.dirname(a[0].file), directory(firstId, 'screenshots'))
    assert.equal(path.dirname(b[0].file), directory(secondId, 'screenshots'))
    assert.notEqual(a[0].file, again[0].file)
    assert.ok(first.list().some((entry) => entry.file === a[0].file))
    assert.equal(second.list().some((entry) => entry.file === a[0].file), false)
    assert.equal(firstTab.view.webContents.debugger.isAttached(), false)
  })
  await check('oversized viewports and unbounded filenames are rejected before CDP mutation', async () => {
    const before = firstTab.commands.length
    await assert.rejects(viewport.captureViewportMatrix(firstTab, [{ width: 5000, height: 5000, deviceScaleFactor: 4 }]), /IMAGE_TOO_LARGE/)
    await assert.rejects(viewport.captureViewportMatrix(firstTab, [{ width: 800, height: 600, name: 'a'.repeat(81) }]), /视口名称/)
    assert.equal(firstTab.commands.length, before)
  })
  await check('default Profile preserves legacy baseline/screenshot/evidence environment paths', async () => {
    process.env.AA_BROWSER_BASELINE_DIR = path.join(temporary, 'legacy', 'baselines')
    process.env.AA_BROWSER_SCREENSHOT_DIR = path.join(temporary, 'legacy', 'screenshots')
    process.env.AA_BROWSER_EVIDENCE_FILE = path.join(temporary, 'legacy', 'evidence.json')
    const metadata = await visual.visualSave(tab('default'), 'legacy')
    assert.equal(path.dirname(metadata.file), process.env.AA_BROWSER_BASELINE_DIR)
    const output = await viewport.captureViewportMatrix(tab('default'), [{ width: 800, height: 600 }])
    assert.equal(path.dirname(output[0].file), process.env.AA_BROWSER_SCREENSHOT_DIR)
    assert.equal(fs.existsSync(process.env.AA_BROWSER_EVIDENCE_FILE), true)
    assert.equal(visual.visualBaselinesDir(firstId), directory(firstId, 'baselines'))
  })
  await check('monitor history and evidence remain Profile scoped across context and tab switches', async () => {
    const emitted = []
    const tabs = new Map([[firstTab.id, firstTab], [secondTab.id, secondTab]])
    const monitor = new BrowserMonitor({ getTab: (id) => tabs.get(id) ?? null, emitState() {}, emitFrame: (frame) => emitted.push(frame) })
    const settle = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!monitor.captureRunning) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.fail('monitor capture did not settle')
    }
    try {
      current = firstId
      monitor.setPreviewRequested(true)
      monitor.setWindowVisible(true)
      monitor.start(firstTab.id)
      current = secondId
      await settle()
      assert.deepEqual(monitor.getState().history, [], 'a different MCP Profile cannot read the selected Profile history')
      current = firstId
      const a = monitor.getState().history[0]
      assert.equal(path.dirname(a.file), directory(firstId, 'monitor'))
      assert.ok(first.list().some((entry) => entry.file === a.file))
      assert.equal(a.url, 'https://fixture.test/view')
      assert.equal(monitor.historyFrame(a.capturedAt).profileId, firstId)
      assert.throws(() => monitor.start(secondTab.id), /PROFILE_ACCESS_DENIED/)
      current = secondId
      const framesBeforeSwitch = emitted.length
      monitor.start(secondTab.id)
      monitor.setWindowVisible(true)
      assert.equal(emitted.length, framesBeforeSwitch, 'switching cannot reemit the previous Profile bitmap')
      await settle()
      const b = monitor.getState().history[0]
      assert.equal(path.dirname(b.file), directory(secondId, 'monitor'))
      assert.ok(second.list().some((entry) => entry.file === b.file))
      assert.equal(monitor.getState().history.some((entry) => entry.file === a.file), false)
      current = firstId
      assert.equal(monitor.getState().tabId, undefined)
      assert.equal(monitor.getUiState().tabId, secondTab.id, 'desktop state must not inherit the caller Profile filter')
      assert.deepEqual(monitor.getState().history.map((entry) => entry.file), [a.file])
      assert.equal(monitor.historyFrame(a.capturedAt).profileId, firstId)
      fs.renameSync(a.file, `${a.file}.original`)
      fs.writeFileSync(a.file, image)
      monitor.retireFrame(a.file, firstId)
      assert.equal(fs.existsSync(a.file), true, 'monitor cleanup must preserve a same-content user replacement')
      monitor.retireFrame(b.file, secondId)
      assert.equal(fs.existsSync(b.file), false, 'monitor can remove its unchanged own frame')
      assert.equal(second.list().some((entry) => entry.file === b.file), false)
    } finally { current = undefined; monitor.stop() }
  })
  await check('linked baseline/screenshot ancestors and linked registries fail closed', async () => {
    const linkedId = 'p' + 'c'.repeat(24)
    const destination = path.join(temporary, 'outside')
    fs.mkdirSync(destination)
    const link = path.join(temporary, linkedId)
    fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(visual.visualSave(tab(linkedId), 'escape'), /FILE_LINK_DENIED/)
    await assert.rejects(viewport.captureViewportMatrix(tab(linkedId), [{ width: 800, height: 600 }]), /FILE_LINK_DENIED/)
    assert.throws(() => visual.visualDelete('escape', linkedId), /FILE_LINK_DENIED/)
    const manager = new evidence.EvidenceManager(path.join(link, 'registry.json'))
    assert.deepEqual(manager.list(), [])
    const foreign = path.join(destination, 'do-not-read.png')
    fs.writeFileSync(foreign, image)
    assert.equal(manager.record(path.join(link, 'do-not-read.png'), 'screenshot'), null)
    assert.equal(fs.existsSync(path.join(destination, 'registry.json')), false)
    assert.deepEqual(fs.readdirSync(destination), ['do-not-read.png'])
  })
  console.log(`PASS: ${passed} Profile evidence isolation groups`)
} finally {
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const absolute = path.resolve(temporary)
  assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(absolute, { recursive: true, force: true })
}
