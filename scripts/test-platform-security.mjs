import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction, constants } from 'node:vm'
import test from 'node:test'
import { SECURITY_MODULES, securityFixture } from './security-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-platform-security-'))
const out = path.join(tmp, 'compiled')

try {
  const compiled = spawnSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['actions', ...SECURITY_MODULES].map((name) => path.join(root, `src/main/${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const deps = securityFixture(out)
  const files = deps['./file-policy']
  const { redactText, redactData } = deps['./redaction']
  const { validateToolArguments } = deps['./tool-validation']
  const { PermissionManager, authorizeProfileAccess, markProfileAccess, revokeClientProfileAccess, revokeProfileAccess } = deps['./permissions']
  const actionsFile = path.join(out, 'actions.js')
  const module = { exports: {} }
  compileFunction(fs.readFileSync(actionsFile, 'utf8'), ['require', 'module', 'exports'], { filename: actionsFile, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(
    (name) => deps[name] ?? (name.startsWith('node:') ? require(name) : ({
      electron: {}, '@snapshot/scripts': { storageScript: () => 'storage-fixture' }, '@snapshot/engine': { __aaSnapshot() {} },
      './progress': {}, './evidence': {}, './ref-context': {}
    })[name]), module, module.exports
  )
  const { doCookies, doStorage, resolveExportFile } = module.exports

  await test('audit redaction covers URL, JSON, Authorization, quoted passwords and nested objects', () => {
    const raw = 'https://alice:fixture-basic@example.test/?access_token=fixture-url#token=fixture-fragment Authorization: Bearer fixture-header "password": "fixture password with spaces"'
    const safe = redactText(raw)
    assert.doesNotMatch(safe, /fixture-basic|fixture-url|fixture-fragment|fixture-header|fixture password/)
    assert.doesNotMatch(JSON.stringify(redactData({ token: 'fixture-token', nested: { password: 'fixture-password' }, ordinary: 'safe' })), /fixture-token|fixture-password/)
  })

  await test('permission grants bind profile, client, task and exact operation; high risk is always one use', () => {
    const manager = new PermissionManager()
    const scope = { profileId: 'p1', clientId: 7, taskId: 'workflow-1' }
    assert.throws(() => manager.grant(scope, 'high-risk'), /exact operation/)
    assert.throws(() => manager.grant(scope, 'invalid'), /Invalid permission/)
    const grant = manager.grant(scope, 'high-risk', { once: false, action: 'submit' })
    assert.equal(manager.check({ ...scope, profileId: 'p2' }, 'high-risk', 'submit'), false)
    assert.equal(manager.check({ ...scope, clientId: 8 }, 'high-risk', 'submit'), false)
    assert.equal(manager.check({ ...scope, taskId: 'workflow-2' }, 'high-risk', 'submit'), false)
    assert.equal(manager.check(scope, 'high-risk', 'delete'), false)
    assert.equal(manager.check(scope, 'high-risk', 'submit'), true)
    assert.equal(manager.check(scope, 'high-risk', 'submit'), false)
    assert.equal(manager.list().some((item) => item.id === grant.id), false)
    const revoked = manager.grant(scope, 'files', { once: false })
    assert.equal(manager.revoke(revoked.id), true)
    assert.equal(manager.check(scope, 'files', 'read'), false)
    const oldNow = Date.now
    try {
      const clock = oldNow()
      Date.now = () => clock
      manager.grant(scope, 'network', { ttlMs: 1000 })
      Date.now = () => clock + 1001
      assert.equal(manager.check(scope, 'network', 'capture'), false)
    } finally { Date.now = oldNow }
  })

  await test('Profile identity approval is scoped, deduplicated, expires and cannot survive revocation', async () => {
    let approvals = 0
    const approve = async () => { approvals++; return true }
    await authorizeProfileAccess('default', 1, approve)
    assert.equal(approvals, 0, 'the existing default Profile remains compatible')
    await Promise.all(Array.from({ length: 8 }, () => authorizeProfileAccess('work', 1, approve)))
    assert.equal(approvals, 1, 'concurrent calls share one native identity decision')
    await authorizeProfileAccess('work', 1, approve)
    assert.equal(approvals, 1, 'approved identity is cached for this client')
    await authorizeProfileAccess('work', 2, approve)
    await authorizeProfileAccess('personal', 1, approve)
    assert.equal(approvals, 3, 'another client or Profile requires its own decision')
    await assert.rejects(authorizeProfileAccess('denied', 1, async () => false), /denied/)
    await assert.rejects(authorizeProfileAccess('denied', 1, async () => { throw new Error('closed dialog') }), /closed dialog/)
    await authorizeProfileAccess('denied', 1, approve)
    assert.equal(approvals, 4, 'a denial does not populate the cache or retain its pending promise')
    revokeClientProfileAccess(1)
    await authorizeProfileAccess('work', 1, approve)
    assert.equal(approvals, 5)
    await authorizeProfileAccess('work', 2, approve)
    assert.equal(approvals, 5, 'revoking one client does not revoke another')
    revokeProfileAccess('work')
    await authorizeProfileAccess('work', 2, approve)
    assert.equal(approvals, 6)
    const oldNow = Date.now
    try {
      const now = oldNow()
      Date.now = () => now
      markProfileAccess('expiring', 3)
      Date.now = () => now + 3_600_001
      await authorizeProfileAccess('expiring', 3, approve)
      assert.equal(approvals, 7)
    } finally { Date.now = oldNow }
    for (const revoke of [() => revokeClientProfileAccess(4), () => revokeProfileAccess('pending')]) {
      let finish
      const decision = new Promise((resolve) => { finish = resolve })
      const pending = authorizeProfileAccess('pending', 4, () => decision)
      await Promise.resolve()
      revoke()
      finish(true)
      await assert.rejects(pending, /revoked during approval/)
      await authorizeProfileAccess('pending', 4, approve)
      revokeClientProfileAccess(4)
    }
    assert.equal(approvals, 9, 'a late approval cannot restore a revoked identity')
    for (const clientId of [0, -1, 1.5, NaN, Infinity]) {
      await assert.rejects(authorizeProfileAccess('work', clientId, approve), /Invalid MCP client identity/)
    }
  })

  await test('published input schema rejects malformed values and preserves optional compatible context', () => {
    const schema = { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['get'] }, count: { type: 'integer', minimum: 1, maximum: 10 }, paths: { type: 'array', items: { type: 'string' } } } }
    validateToolArguments(schema, { action: 'get', count: 1, profileId: 'default', futureOption: true, __aaSignal: new AbortController().signal })
    for (const args of [{}, { action: 1 }, { action: 'delete' }, { action: 'get', count: 1.5 }, { action: 'get', count: NaN }, { action: 'get', paths: [42] }]) {
      assert.throws(() => validateToolArguments(schema, args), /INVALID_ARGUMENT/)
    }
    const deep = {}; let next = deep
    for (let i = 0; i < 20; i++) { next.child = {}; next = next.child }
    assert.throws(() => validateToolArguments({}, deep), /too complex/)
  })

  const browserRoot = path.join(tmp, 'browser')
  const owned = path.join(browserRoot, 'profiles', 'a', 'files')
  const sibling = path.join(browserRoot, 'profiles', 'b', 'files')
  const external = path.join(tmp, 'external')
  for (const dir of [owned, sibling, external]) fs.mkdirSync(dir, { recursive: true })
  const ownFile = path.join(owned, 'fixture.txt')
  const otherFile = path.join(sibling, 'private.txt')
  const outsideFile = path.join(external, 'approved.txt')
  for (const file of [ownFile, otherFile, outsideFile]) fs.writeFileSync(file, 'fixture bytes')
  files.configureFilePolicy((profileId) => ({ profileId: profileId ?? 'a', roots: [owned], blockedRoots: [browserRoot] }))

  await test('file access requires managed ownership or an explicit external approval and never crosses profiles', () => {
    assert.equal(files.validateReadFile(ownFile), ownFile)
    assert.throws(() => files.validateReadFile(outsideFile), /one-time approval/)
    assert.equal(files.validateReadFile(outsideFile, { approvedExternal: true }), outsideFile)
    assert.throws(() => files.validateReadFile(otherFile, { approvedExternal: true }), /Another profile/)
    assert.throws(() => files.validateReadFile('relative.txt', { approvedExternal: true }), /absolute/)
    assert.throws(() => files.validateReadFile(`${ownFile}\0`), /absolute/)
    assert.throws(() => files.resolveWriteFile(path.join(owned, '..', '..', 'b', 'files', 'escape.txt')), /Another profile/)
    assert.throws(() => files.resolveWriteFile(ownFile), /overwrite/)
    const output = path.join(owned, 'out.har')
    files.writeExportFile(output, 'first')
    assert.throws(() => files.writeExportFile(output, 'second'), /overwrite/)
    files.writeExportFile(output, 'approved replacement', { overwrite: true })
    assert.equal(fs.readFileSync(output, 'utf8'), 'approved replacement')
  })

  await test('directory junctions cannot bypass managed roots, including approved external reads and nested outputs', () => {
    const link = path.join(owned, 'junction')
    fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => files.validateReadFile(path.join(link, 'approved.txt'), { approvedExternal: true }), /Symbolic links/)
    assert.throws(() => files.resolveWriteFile(path.join(link, 'nested', 'out.pdf'), { approvedExternal: true }), /Symbolic links/)
  })

  await test('automatic export defaults pass the same policy as explicitly requested paths', async () => {
    await assert.rejects(resolveExportFile(undefined, '.har', path.join(external, 'automatic.har')), /PERMISSION_ERROR/)
    assert.equal((await resolveExportFile(undefined, '.har', path.join(owned, 'automatic.har'))).file, path.join(owned, 'automatic.har'))
  })

  await test('Cookie get defaults to the current website and sensitive values require explicit executor capability', async () => {
    const queries = []
    const tab = { view: { webContents: { getURL: () => 'https://account.example/page', session: { cookies: { get: async (query) => { queries.push(query); return [{ name: 'login', value: 'fixture-cookie-secret', domain: 'account.example', httpOnly: true }] } } } } } }
    assert.doesNotMatch((await doCookies(tab, { action: 'get' })).content, /fixture-cookie-secret/)
    assert.deepEqual(queries[0], { url: 'https://account.example/page' })
    assert.match((await doCookies(tab, { action: 'get', includeSensitive: true })).content, /fixture-cookie-secret/)
  })

  await test('Storage output hides values by default while preserving approved reads', async () => {
    const tab = { view: { webContents: { executeJavaScript: async () => ({ ok: true, count: 1, value: 'fixture-storage-secret', values: { session: 'fixture-storage-secret' } }) } } }
    assert.doesNotMatch((await doStorage(tab, { action: 'get', kind: 'local' })).content, /fixture-storage-secret/)
    assert.doesNotMatch((await doStorage(tab, { action: 'get', kind: 'local', key: 'session' })).content, /fixture-storage-secret/)
    assert.match((await doStorage(tab, { action: 'get', kind: 'local', includeSensitive: true })).content, /fixture-storage-secret/)
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
