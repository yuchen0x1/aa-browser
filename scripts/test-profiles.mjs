import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-profiles-'))
const out = path.join(fixture, 'compiled')
const dataRoot = path.join(fixture, 'data')
const sessionDataRoot = path.join(fixture, 'userData', 'Partitions')
process.env.AA_BROWSER_DATA_DIR = dataRoot
process.env.AA_BROWSER_PROFILES_FILE = path.join(dataRoot, 'profiles.json')
const app = new EventEmitter()
app.getPath = () => path.dirname(sessionDataRoot)
const sessions = new Map()
function sessionProvider(partition) {
  if (!sessions.has(partition)) sessions.set(partition, { partition, clearStorageData: async function () { this.cleared = true }, clearCache: async () => {}, closeAllConnections: async () => {}, flushStorageData() {} })
  return sessions.get(partition)
}
const compiled = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noCheck', '--noResolve', '--rootDir', 'src', '--outDir', out, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop', ...['profiles', 'atomic-json', 'tabs', 'history', 'session-store', 'downloads', 'extensions', 'redaction'].map((name) => `src/main/${name}.ts`)], { cwd: root, encoding: 'utf8' })
assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`)
function load(name, dependencies) {
  const filename = path.join(out, 'main', `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })((id) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected ${name} dependency ${id}`)
    return dependencies[id]
  }, module, module.exports)
  return module.exports
}
const atomic = load('atomic-json', { 'node:fs': fs, 'node:path': path, 'node:crypto': crypto })
const profiles = load('profiles', { 'node:fs': fs, 'node:path': path, 'node:os': os, 'node:async_hooks': { AsyncLocalStorage }, 'node:crypto': crypto, electron: { app, session: { fromPartition: sessionProvider } }, './atomic-json': atomic })
const manager = profiles.getProfileManager()
let one, two
try {
  await test('legacy default keeps its original partition and profile metadata persists independently', () => {
    assert.equal(manager.partitionFor('default'), 'persist:aa-main')
    one = manager.create({ name: 'Work', description: 'Work account', color: '#36b5a0' })
    two = manager.create({ name: 'Personal', icon: 'briefcase' })
    assert.notEqual(manager.partitionFor(one.id), manager.partitionFor(two.id))
    manager.update(one.id, { name: 'Work renamed' })
    const reopened = new profiles.ProfileManager({ dataRoot, sessionDataRoot, sessionProvider })
    assert.equal(reopened.get(one.id).name, 'Work renamed')
    assert.throws(() => manager.create({ name: '../bad', color: 'javascript:bad' }), /INVALID_METADATA/)
    assert.throws(() => manager.get('../bad'), /INVALID_ID/)
  })
  await test('profile context and client bindings remain separate across concurrent asynchronous calls', async () => {
    manager.bindClient(1, one.id); manager.bindClient(2, two.id)
    assert.equal(manager.clientProfile(1), one.id)
    const values = await Promise.all([one.id, two.id].map((id) => manager.runWithProfile(id, async () => {
      await Promise.resolve(); return manager.currentProfileId()
    })))
    assert.deepEqual(values, [one.id, two.id])
    assert.equal(manager.currentProfileId(), 'default')
    assert.notEqual(manager.directory(one.id, 'downloads'), manager.directory(two.id, 'downloads'))
    assert.notEqual(manager.sessionFor(one.id), manager.sessionFor(two.id))
    assert.equal(manager.profileForSession(manager.sessionFor(one.id)), one.id)
  })
  await test('concurrent starts initialize once and a workflow lease rejects unrelated MCP calls', async () => {
    let initialized = 0
    manager.onSession = async () => { initialized++; await Promise.resolve() }
    await Promise.all([manager.start(one.id), manager.start(one.id)])
    assert.equal(initialized, 1)
    const release = manager.acquireLease(one.id, 'workflow-one')
    assert.throws(() => manager.acquireLease(one.id, 'workflow-two'), /PROFILE_BUSY/)
    assert.throws(() => manager.assertLeaseAccess(one.id), /PROFILE_BUSY/)
    manager.runWithLease(one.id, 'workflow-one', () => manager.assertLeaseAccess(one.id))
    await assert.rejects(() => manager.stop(one.id), /PROFILE_BUSY/)
    release(); manager.assertLeaseAccess(one.id)
    await manager.stop(one.id)
    assert.equal(manager.list().find((item) => item.id === one.id).running, false)
  })
  await test('in-flight tools block workflow takeover and lifecycle changes until every operation finishes', async () => {
    let completeFirst, completeSecond
    const first = manager.withUse(one.id, () => new Promise((resolve) => { completeFirst = resolve }))
    const second = manager.withUse(one.id, () => new Promise((resolve) => { completeSecond = resolve }))
    assert.throws(() => manager.acquireLease(one.id, 'blocked-workflow'), /PROFILE_BUSY/)
    await assert.rejects(() => manager.stop(one.id), /PROFILE_BUSY/)
    await assert.rejects(() => manager.remove(one.id), /PROFILE_BUSY/)
    completeFirst(); await first
    assert.throws(() => manager.acquireLease(one.id, 'still-blocked-workflow'), /PROFILE_BUSY/)
    completeSecond(); await second
    await assert.rejects(() => manager.withUse(one.id, () => { throw new Error('fixture failure') }), /fixture failure/)
    const releaseFirst = manager.acquireLease(one.id, 'trusted-workflow')
    const releaseSecond = manager.acquireLease(one.id, 'trusted-workflow')
    await assert.rejects(() => manager.withUse(one.id, () => 'untrusted'), /PROFILE_BUSY/)
    assert.equal(await manager.runWithLease(one.id, 'trusted-workflow', () => manager.withUse(one.id, async () => 'owned')), 'owned')
    releaseFirst(); releaseFirst()
    assert.throws(() => manager.assertLeaseAccess(one.id), /PROFILE_BUSY/)
    releaseSecond(); manager.assertLeaseAccess(one.id)
    const staleRelease = manager.acquireLease(one.id, 'trusted-workflow')
    manager.releaseLease(one.id, 'trusted-workflow')
    const releaseReplacement = manager.acquireLease(one.id, 'trusted-workflow')
    staleRelease()
    assert.throws(() => manager.assertLeaseAccess(one.id), /PROFILE_BUSY/)
    releaseReplacement(); manager.assertLeaseAccess(one.id)
  })
  await test('stopping and deleting reject new operations throughout their asynchronous cleanup', async () => {
    let finishStop, announceStop, stopped = 0
    const enteredStop = new Promise((resolve) => { announceStop = resolve })
    manager.onStop = async () => { stopped++; announceStop(); await new Promise((resolve) => { finishStop = resolve }) }
    const stopping = manager.stop(one.id)
    await enteredStop
    const duplicateStop = manager.stop(one.id)
    assert.throws(() => manager.acquireLease(one.id, 'stop-race'), /PROFILE_BUSY/)
    await assert.rejects(() => manager.start(one.id), /PROFILE_BUSY/)
    await assert.rejects(() => manager.withUse(one.id, () => undefined), /PROFILE_BUSY/)
    finishStop(); await Promise.all([stopping, duplicateStop])
    assert.equal(stopped, 1)
    manager.onStop = null
    const removalManager = new profiles.ProfileManager({ filePath: path.join(fixture, 'removal.json'), dataRoot: path.join(fixture, 'removal-data'), sessionDataRoot, sessionProvider })
    const removed = removalManager.create({ name: 'Removal race fixture' })
    let finishRemoval, announceRemoval
    const enteredRemoval = new Promise((resolve) => { announceRemoval = resolve })
    removalManager.onStop = async () => { announceRemoval(); await new Promise((resolve) => { finishRemoval = resolve }) }
    const removing = removalManager.remove(removed.id)
    await enteredRemoval
    assert.throws(() => removalManager.acquireLease(removed.id, 'remove-race'), /PROFILE_BUSY/)
    await assert.rejects(() => removalManager.start(removed.id), /PROFILE_BUSY/)
    await assert.rejects(() => removalManager.withUse(removed.id, () => undefined), /PROFILE_BUSY/)
    finishRemoval(); await removing
    assert.throws(() => removalManager.get(removed.id), /PROFILE_NOT_FOUND/)
  })
  await test('stopping a never-started Profile does not allocate a Session or prevent its offline backup', async () => {
    const offline = manager.create({ name: 'Never-started identity' })
    let stopCalls = 0
    manager.onStop = (id) => {
      stopCalls++
      assert.equal(manager.existingSession(id), undefined, 'cleanup must inspect existing Sessions without allocating one')
    }
    try {
      assert.equal(manager.existingSession(offline.id), undefined)
      assert.equal(sessions.has(manager.partitionFor(offline.id)), false)
      await manager.stop(offline.id)
      assert.equal(stopCalls, 1)
      assert.equal(manager.existingSession(offline.id), undefined)
      assert.equal(sessions.has(manager.partitionFor(offline.id)), false)
      assert.ok(await manager.exportProfile(offline.id, 'offline fixture backup password'))
      assert.equal(manager.existingSession(offline.id), undefined)
      assert.equal(manager.existingSession(one.id), manager.sessionFor(one.id))
    } finally { manager.onStop = null }
  })
  await test('deletion clears only the selected Session and schedules physical removal for a fresh startup', async () => {
    await assert.rejects(() => manager.remove('default'), /PROFILE_PROTECTED/)
    const deletedDir = path.join(sessionDataRoot, `aa-profile-${two.id}`)
    fs.mkdirSync(deletedDir, { recursive: true }); fs.writeFileSync(path.join(deletedDir, 'Cookies'), 'secret')
    const untouchedDir = path.join(sessionDataRoot, `aa-profile-${one.id}`)
    fs.mkdirSync(untouchedDir, { recursive: true }); fs.writeFileSync(path.join(untouchedDir, 'Cookies'), 'work')
    await manager.remove(two.id)
    assert.equal(sessions.get(`persist:aa-profile-${two.id}`).cleared, true)
    assert.equal(sessions.get(`persist:aa-profile-${one.id}`).cleared, undefined)
    assert.equal(await manager.sweepDeleted(), 0, 'a Session initialized this process must retain its locked directory')
    const reboot = new profiles.ProfileManager({ dataRoot, sessionDataRoot, sessionProvider })
    assert.equal(await reboot.sweepDeleted(), 1)
    assert.equal(fs.existsSync(deletedDir), false)
    assert.equal(fs.readFileSync(path.join(untouchedDir, 'Cookies'), 'utf8'), 'work')
  })
  await test('offline encrypted backups round-trip Cookies, IndexedDB, and managed data; wrong passwords and live copies fail', async () => {
    const source = manager.create({ name: 'Offline backup' })
    const sourceSession = path.join(sessionDataRoot, `aa-profile-${source.id}`)
    fs.mkdirSync(path.join(sourceSession, 'IndexedDB', 'fixture.leveldb'), { recursive: true })
    fs.writeFileSync(path.join(sourceSession, 'Cookies'), 'fixture-cookie-database')
    fs.writeFileSync(path.join(sourceSession, 'IndexedDB', 'fixture.leveldb', '0001.ldb'), Buffer.from([0, 255, 12, 8]))
    fs.mkdirSync(manager.directory(source.id, 'history'), { recursive: true })
    fs.writeFileSync(path.join(manager.directory(source.id, 'history'), 'history.json'), '["account history"]')
    const password = 'a long private fixture password'
    const encrypted = await manager.exportProfile(source.id, password)
    assert.equal(encrypted.includes('fixture-cookie'), false)
    await assert.rejects(() => manager.importProfile(encrypted, 'wrong password long enough'), /BACKUP_INVALID/)
    const restored = await manager.importProfile(encrypted, password, 'Restored')
    const restoredSession = path.join(sessionDataRoot, `aa-profile-${restored.id}`)
    assert.equal(fs.readFileSync(path.join(restoredSession, 'Cookies'), 'utf8'), 'fixture-cookie-database')
    assert.deepEqual(fs.readFileSync(path.join(restoredSession, 'IndexedDB/fixture.leveldb/0001.ldb')), Buffer.from([0, 255, 12, 8]))
    assert.equal(fs.readFileSync(path.join(manager.directory(restored.id, 'history'), 'history.json'), 'utf8'), '["account history"]')
    const clone = await manager.clone(source.id, 'Cloned')
    assert.notEqual(clone.id, source.id)
    manager.sessionFor(source.id)
    await assert.rejects(() => manager.exportProfile(source.id, password), /OFFLINE_REQUIRED/)
    await assert.rejects(() => manager.exportProfile('default', password), /LEGACY_BACKUP/)
    const tampered = JSON.parse(encrypted); tampered.tag = Buffer.alloc(16).toString('base64')
    await assert.rejects(() => manager.importProfile(JSON.stringify(tampered), password), /BACKUP_INVALID/)
  })
  await test('corrupt and future registries fail closed without overwriting the original bytes', () => {
    const invalidFile = path.join(fixture, 'invalid.json')
    fs.writeFileSync(invalidFile, '{broken')
    assert.throws(() => new profiles.ProfileManager({ filePath: invalidFile, dataRoot }), /REGISTRY_CORRUPT/)
    assert.equal(fs.readFileSync(invalidFile, 'utf8'), '{broken')
    fs.writeFileSync(invalidFile, '{"version":99}')
    assert.throws(() => new profiles.ProfileManager({ filePath: invalidFile, dataRoot }), /REGISTRY_CORRUPT/)
  })
  await test('authenticated archives still reject traversal, Windows aliases and linked Profile data', async () => {
    const passphrase = 'a long fixture archive password'
    const seal = (files) => {
      const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
      const key = crypto.scryptSync(passphrase, salt, 32), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(JSON.stringify({ version: 1, profile: one, files }), 'utf8'), cipher.final()])
      key.fill(0)
      return JSON.stringify({ version: 1, cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
    }
    const before = manager.list().length
    for (const name of ['../outside', 'nested/../../outside', '/absolute', 'CON', 'path/file.', 'path/file:stream', 'path\\file']) {
      await assert.rejects(() => manager.importProfile(seal([{ area: 'data', name, data: 'eA==' }]), passphrase), /BACKUP_INVALID_PATH/)
    }
    await assert.rejects(() => manager.importProfile(seal([{ area: 'data', name: 'Files/a.txt', data: 'eA==' }, { area: 'data', name: 'files/A.txt', data: 'eA==' }]), passphrase), /BACKUP_INVALID_PATH/)
    assert.equal(manager.list().length, before, 'invalid archives must not register any partially restored Profile')
    const source = manager.create({ name: 'Linked backup fixture' })
    const files = manager.directory(source.id, 'files'), outside = path.join(fixture, 'outside-data')
    fs.mkdirSync(files, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret'), 'outside data must never be read')
    fs.symlinkSync(outside, path.join(files, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => manager.exportProfile(source.id, passphrase), /PROFILE_UNSAFE_PATH/)
    fs.mkdirSync(sessionDataRoot, { recursive: true })
    fs.symlinkSync(outside, path.join(sessionDataRoot, `aa-profile-${source.id}`), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => manager.sessionFor(source.id), /PROFILE_UNSAFE_PATH/)
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'outside data must never be read')
  })
  await test('extensions, history and downloads are scoped by actual profile ownership', async () => {
    const history = load('history', { 'node:fs': fs, 'node:path': path, 'node:os': os, './atomic-json': atomic })
    history.configureHistoryProfiles(() => manager.currentProfileId(), (id) => manager.directory(id, 'history'))
    manager.runWithProfile(one.id, () => history.getHistoryStore().add('https://work.test/', 'Work'))
    assert.equal(history.getHistoryStore('default').list().length, 0)
    assert.equal(history.getHistoryStore(one.id).list()[0].title, 'Work')
    const downloads = load('downloads', { 'node:fs': fs, 'node:os': os, 'node:path': path, 'node:crypto': crypto, electron: { shell: {} }, '../shared/diagnostics': { diagnosticMessage: (_locale, key) => key }, './locale': { getMainLocale: () => 'en-US' }, './profiles': profiles, './redaction': load('redaction', {}) })
    const tracker = new downloads.DownloadTracker()
    const a = new EventEmitter(), b = new EventEmitter()
    tracker.attach(a, one.id); tracker.attach(b, 'default')
    const item = () => Object.assign(new EventEmitter(), { getURL: () => 'https://fixture.test/file', getFilename: () => 'file.txt', getTotalBytes: () => 12, setSavePath(value) { this.saved = value }, cancel() { this.cancelled = true } })
    const first = item(); first.getURL = () => 'https://fixture.test/file?token=private-token'; a.emit('will-download', {}, first)
    const second = item(); b.emit('will-download', {}, second)
    assert.notEqual(path.dirname(first.saved), path.dirname(second.saved))
    const defaultId = manager.runWithProfile('default', () => tracker.list()[0].id)
    manager.runWithProfile(one.id, () => {
      assert.equal(tracker.list().length, 1)
      assert.equal(tracker.list()[0].url.includes('private-token'), false)
      assert.equal(tracker.cancel(defaultId), false)
      assert.equal(second.cancelled, undefined)
    })
    const denied = await manager.runWithProfile(one.id, () => tracker.retry(defaultId))
    assert.equal(denied.ok, false)
    assert.equal(tracker.cancelProfile(one.id), 1)
    assert.equal(first.cancelled, true)
    assert.equal(second.cancelled, undefined)
    manager.runWithProfile(one.id, () => history.getHistoryStore().add('https://username:password@work.test/account?token=private-token&search=kept#access_token=hidden', 'Account'))
    const safeUrl = history.getHistoryStore(one.id).list()[0].url
    assert.equal(safeUrl, 'https://work.test/account?search=kept')
  })
  await test('desktop workflow context selects only its Profile and popups inherit client and identity', async () => {
    class Contents extends EventEmitter {
      constructor(partition) { super(); this.session = sessionProvider(partition); this.url = ''; this.loads = []; this.destroyed = false; this.navigationHistory = { getActiveIndex: () => 0, canGoBack: () => false, canGoForward: () => false } }
      isDestroyed() { return this.destroyed }
      getURL() { return this.url }
      getTitle() { return 'Fixture' }
      async loadURL(url) { this.loads.push(url); this.url = url }
      setWindowOpenHandler(handler) { this.popup = handler }
      setBackgroundThrottling() {}
      close() { this.closeRequested = true; if (!this.deferDestruction) this.destroyed = true }
    }
    class View { constructor(options) { this.webContents = new Contents(options.webPreferences.partition) } }
    let ensureNetwork = async () => {}
    const redaction = load('redaction', {})
    const { TabManager } = load('tabs', {
      electron: { app, session: { fromPartition: sessionProvider }, WebContentsView: View },
      'node:async_hooks': { AsyncLocalStorage }, './profiles': profiles, './redaction': redaction,
      './network': { NetworkCapture: class { async ensure() { await ensureNetwork() } releaseDebugger() {} } },
      './dialogs': { async installDialogGuard() {} }, './closed-shadow': { async installClosedShadowCapture() {} },
      './ref-context': { noteNavigation() {}, noteRendererRestart() {} }
    })
    const tabs = new TabManager('https://newtab.test/', 'https://search.test/?q=')
    const work = tabs.createTab('https://fixture.test/work', true, false, false, undefined, one.id)
    const legacy = tabs.createTab('https://fixture.test/default', true, false, false, undefined, 'default')
    await Promise.all([work.initialNavigation, legacy.initialNavigation])
    assert.equal(tabs.active().id, legacy.id)
    assert.equal(manager.runWithProfile(one.id, () => tabs.active().id), work.id)
    assert.equal(manager.runWithProfile(one.id, () => tabs.infos().length), 1)
    manager.bindClient(40, one.id)
    await tabs.runAsAgent(40, async () => { assert.equal(tabs.get(work.id).id, work.id); assert.equal(tabs.get(legacy.id), null) })
    work.view.webContents.popup({ url: 'https://fixture.test/popup' })
    const popup = tabs.tabs.find((tab) => tab.url.endsWith('/popup'))
    assert.equal(popup.profileId, one.id)
    assert.equal(popup.agentClientId, 40)
    assert.equal(popup.partition, work.partition)
    await popup.initialNavigation
    tabs.closeProfile(one.id)
    assert.equal(tabs.tabs.some((tab) => tab.profileId === one.id), false)
    assert.equal(tabs.activeForUi().id, legacy.id)
    tabs.closeAll()
    const lastWork = tabs.createTab('https://fixture.test/last-work', true, false, false, undefined, one.id)
    await lastWork.initialNavigation
    tabs.closeTab(lastWork.id)
    assert.equal(tabs.tabs.length, 1)
    assert.equal(tabs.activeForUi().profileId, one.id, 'closing the last tab must retain its Profile')
    assert.equal(tabs.activeForUi().partition, work.partition)
    tabs.closeProfile(one.id)
    assert.equal(tabs.tabs.length, 0, 'closing a Profile must not reopen its last tab')
    const releaseLease = manager.acquireLease(one.id, 'tab-creation-workflow')
    try {
      assert.throws(() => tabs.createTab(undefined, true, false, false, undefined, one.id), /PROFILE_BUSY/)
      assert.equal(tabs.tabs.length, 0, 'a rejected tab must not allocate a view or enter the tab list')
      const leasedTab = manager.runWithLease(one.id, 'tab-creation-workflow', () => tabs.createTab(undefined, true, false, false, undefined, one.id))
      await leasedTab.initialNavigation
      assert.equal(leasedTab.profileId, one.id, 'a workflow may create tabs inside its own lease')
      tabs.closeProfile(one.id)
    } finally { releaseLease() }
    let finishCleanup, announceCleanup
    const cleanupEntered = new Promise((resolve) => { announceCleanup = resolve })
    manager.onStop = async () => { announceCleanup(); await new Promise((resolve) => { finishCleanup = resolve }) }
    const stopping = manager.stop(one.id)
    try {
      await cleanupEntered
      assert.throws(() => tabs.createTab(undefined, true, false, false, undefined, one.id), /PROFILE_BUSY/)
      assert.equal(tabs.tabs.length, 0, 'stopping a Profile must synchronously reject replacement tabs')
    } finally { finishCleanup(); await stopping; manager.onStop = null }
    for (const destroyedOnClose of [true, false]) {
      for (const rejected of [false, true]) {
        let finishNetwork, announceNetwork
        const networkEntered = new Promise((resolve) => { announceNetwork = resolve })
        ensureNetwork = () => new Promise((resolve, reject) => { finishNetwork = rejected ? () => reject(new Error('Target closed')) : resolve; announceNetwork() })
        const target = 'https://fixture.test/must-not-load-after-close'
        const closing = tabs.createTab(target, true, false, false, undefined, one.id)
        const readyRejected = assert.rejects(closing.ready, /页面已关闭/)
        const navigationRejected = assert.rejects(closing.initialNavigation, /页面已关闭/)
        const contents = closing.view.webContents
        contents.deferDestruction = !destroyedOnClose
        await networkEntered
        assert.equal(contents.getURL(), 'about:blank')
        contents.emit('did-navigate', {}, 'about:blank')
        assert.equal(closing.url, target, 'the temporary context navigation must not overwrite the requested URL')
        contents.emit('did-stop-loading')
        assert.equal(closing.url, target, 'the temporary context completion must not overwrite the requested URL')
        assert.deepEqual(tabs.sessionTabs().tabs, [{ url: target, title: closing.title, id: closing.id, profileId: one.id }], 'a pending initial navigation must retain its requested URL in the session snapshot')
        tabs.closeTab(closing.id, false)
        assert.equal(contents.closeRequested, true)
        assert.equal(contents.isDestroyed(), destroyedOnClose, 'close and native destruction may complete at different times')
        finishNetwork()
        await Promise.all([readyRejected, navigationRejected])
        assert.deepEqual(contents.loads, ['about:blank'], 'a removed tab must never start its target navigation after initialization settles')
        if (destroyedOnClose) assert.equal(contents.listenerCount('devtools-closed'), 0, 'late Network.enable must not register events on a destroyed page')
        assert.equal(tabs.tabs.length, 0)
      }
    }
    ensureNetwork = async () => {}
  })
  await test('a custom default restores its extensions only into its own partition, preserving the legacy default', async () => {
    const customRoot = path.join(fixture, 'custom-default')
    const installed = new Map()
    const provider = (partition) => {
      if (!installed.has(partition)) installed.set(partition, [])
      return { partition, extensions: { async loadExtension(directory) { installed.get(partition).push(directory); return { id: 'fixture-extension' } }, removeExtension() {} } }
    }
    const custom = new profiles.ProfileManager({ dataRoot: customRoot, filePath: path.join(customRoot, 'profiles.json'), sessionDataRoot: path.join(customRoot, 'Partitions'), sessionProvider: provider })
    const identity = custom.create({ name: 'Custom default identity' })
    const extension = load('extensions', { 'node:fs': fs, 'node:os': os, 'node:path': path, './atomic-json': atomic })
    const registryFor = (id) => id === 'default' ? path.join(customRoot, 'extensions.json') : path.join(custom.directory(id, 'extensions'), 'registry.json')
    extension.configureExtensionProfiles(() => custom.currentProfileId(), registryFor)
    const extensionRoot = path.join(customRoot, 'fixture-extension')
    fs.mkdirSync(extensionRoot, { recursive: true })
    fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify({ name: 'Custom default fixture', version: '1.0.0', manifest_version: 3 }))
    fs.mkdirSync(path.dirname(registryFor(identity.id)), { recursive: true })
    fs.writeFileSync(registryFor(identity.id), JSON.stringify([extensionRoot]))
    custom.onSession = (ses, id) => extension.getExtensionManager(id).restore(ses)
    custom.setDefault(identity.id)
    await custom.start()
    assert.deepEqual(installed.get(custom.partitionFor(identity.id)), [extensionRoot])
    assert.equal(installed.has('persist:aa-main'), false, 'starting a custom default must not initialize the legacy Session')
    await custom.start('default')
    assert.deepEqual(installed.get('persist:aa-main'), [])
    assert.equal(extension.getExtensionManager('default').list().length, 0)
    assert.equal(extension.getExtensionManager(identity.id).list().length, 1)
  })
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
