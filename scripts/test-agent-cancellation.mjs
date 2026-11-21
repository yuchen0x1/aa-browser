/** Isolated regressions against the production AgentServer and real loopback WebSockets. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-agent-cancellation-'))
const out = path.join(tmp, 'compiled')
// Transpile only the production modules under test; application typechecking is a separate check.
// Use the installed compiler CLI rather than the removed TypeScript 7 transpileModule API.
try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['agent-server', 'progress', 'atomic-json'].map((name) => path.join(root, `src/main/${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)
} catch (error) {
  fs.rmSync(tmp, { recursive: true, force: true })
  throw error
}
function loadMain(name, dependencies = {}) {
  const filename = path.join(out, `${name}.js`)
  const module = { exports: {} }
  const localRequire = (specifier) => Object.hasOwn(dependencies, specifier) ? dependencies[specifier] : require(specifier)
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(localRequire, module, module.exports)
  return module.exports
}
const progress = loadMain('progress')
const privateWrites = []
const atomic = loadMain('atomic-json', { 'node:fs': {
  ...fs,
  openSync(file, flags, mode) {
    const relative = path.relative(tmp, path.dirname(file))
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Discovery writes stay in the isolated directory')
    privateWrites.push({ flags, mode })
    return fs.openSync(file, flags, mode)
  }
} })
const { AgentServer } = loadMain('agent-server', { './progress': progress, './atomic-json': atomic })
const previousConnectionFile = process.env.AA_BROWSER_CONNECTION_FILE
process.env.AA_BROWSER_CONNECTION_FILE = path.join(tmp, 'connection.json')
const running = new Map()
const peers = []
const activityEvents = []
const server = new AgentServer([{
  name: 'test_wait',
  handler: ({ label, __aaSignal: signal }) => new Promise((resolve, reject) => {
    const call = { signal, finish: () => resolve({ label }) }
    running.set(label, call)
    signal.addEventListener('abort', () => reject(new Error(`cancelled ${label}`)), { once: true })
    progress.reportProgress(1, 10, label)
  })
}], () => {}, 'test', undefined, (state) => activityEvents.push(state))

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await delay(10)
  }
}
async function connect() {
  const { port, token } = server.info()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
  const peer = { socket, messages: [] }
  peers.push(peer)
  socket.on('message', (raw) => peer.messages.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return peer
}
function start(peer, id, label) {
  peer.socket.send(JSON.stringify({ id, tool: 'test_wait', args: { label } }))
}
function response(peer, id) {
  return peer.messages.find((message) => message.id === id && typeof message.ok === 'boolean')
}
function clientFor(label) {
  const call = server.activity().calls.find((entry) => entry.message === label)
  assert.ok(call, `Activity includes ${label}`)
  return call.client
}

try {
  const discoveryFile = process.env.AA_BROWSER_CONNECTION_FILE
  const freshFile = path.join(tmp, 'private', 'nested', 'connection.json')
  const fresh = new AgentServer([], () => {}, 'test')
  process.env.AA_BROWSER_CONNECTION_FILE = freshFile
  try {
    await fresh.start()
    assert.deepEqual(privateWrites, [{ flags: 'wx', mode: 0o600 }])
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(freshFile)).mode & 0o777, 0o700)
      assert.equal(fs.statSync(freshFile).mode & 0o777, 0o600)
    }
  } finally {
    fresh.stop()
    process.env.AA_BROWSER_CONNECTION_FILE = discoveryFile
    privateWrites.length = 0
  }
  fs.writeFileSync(discoveryFile, '{"token":"stale fixture"}', { mode: 0o644 })
  if (process.platform !== 'win32') {
    fs.chmodSync(discoveryFile, 0o644)
    assert.equal(fs.statSync(discoveryFile).mode & 0o777, 0o644)
  }
  await server.start()
  assert.deepEqual(privateWrites, [{ flags: 'wx', mode: 0o600 }], 'Token publication uses an exclusive private temporary file')
  if (process.platform !== 'win32') assert.equal(fs.statSync(discoveryFile).mode & 0o777, 0o600, 'Replace legacy permissive discovery permissions')
  const published = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'))
  assert.equal(published.token, server.info().token)
  assert.equal(published.port, server.info().port)
  assert.equal(fs.readdirSync(tmp).some((name) => name.endsWith('.tmp')), false)
  console.log('PASS: discovery publication is atomic and requests owner-only permissions, including legacy files (POSIX mode checked on POSIX only)')
  if (process.platform !== 'win32') {
    const managedHome = path.join(tmp, 'managed-home')
    const { AgentServer: ManagedAgentServer } = loadMain('agent-server', {
      './progress': progress, './atomic-json': atomic, 'node:os': { ...os, homedir: () => managedHome }
    })
    const legacyDir = path.join(managedHome, '.aabrowser')
    const legacyFile = path.join(legacyDir, 'connection.json')
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o777 })
    fs.writeFileSync(legacyFile, '{"token":"legacy"}', { mode: 0o644 })
    fs.chmodSync(legacyDir, 0o755)
    assert.equal(fs.statSync(legacyDir).mode & 0o777, 0o755)
    const legacy = new ManagedAgentServer([], () => {}, 'test')
    const previousFile = process.env.AA_BROWSER_CONNECTION_FILE
    process.env.AA_BROWSER_CONNECTION_FILE = legacyFile
    try {
      await legacy.start()
      assert.equal(fs.statSync(legacyDir).mode & 0o777, 0o700, 'Existing permissive discovery directory is tightened at startup')
      assert.equal(fs.statSync(legacyFile).mode & 0o777, 0o600, 'Legacy file stays protected')
    } finally {
      legacy.stop()
      process.env.AA_BROWSER_CONNECTION_FILE = previousFile
    }
    console.log('PASS: startup tightens the managed pre-existing 0755 discovery directory to 0700')
    const customDir = path.join(tmp, 'shared-custom')
    fs.mkdirSync(customDir)
    fs.chmodSync(customDir, 0o2770)
    const customMode = fs.statSync(customDir).mode & 0o7777
    const customFile = path.join(customDir, 'connection.json')
    const custom = new ManagedAgentServer([], () => {}, 'test')
    process.env.AA_BROWSER_CONNECTION_FILE = customFile
    try {
      await custom.start()
      assert.equal(fs.statSync(customDir).mode & 0o7777, customMode, 'Custom shared directory permissions are not ours to change')
      assert.equal(fs.statSync(customFile).mode & 0o777, 0o600, 'Custom discovery file remains private')
    } finally {
      custom.stop()
      process.env.AA_BROWSER_CONNECTION_FILE = previousFile
    }
    console.log('PASS: startup preserves permissions of an existing custom shared directory')
    const linkedHome = path.join(tmp, 'linked-home')
    fs.mkdirSync(linkedHome)
    fs.symlinkSync(customDir, path.join(linkedHome, '.aabrowser'), 'dir')
    const { AgentServer: LinkedAgentServer } = loadMain('agent-server', {
      './progress': progress, './atomic-json': atomic, 'node:os': { ...os, homedir: () => linkedHome }
    })
    for (const suffix of ['/connection.json', '/./connection.json', '//connection.json']) {
      const linked = new LinkedAgentServer([], () => {}, 'test')
      process.env.AA_BROWSER_CONNECTION_FILE = path.join(linkedHome, '.aabrowser') + suffix
      try {
        await linked.start()
        assert.equal(fs.statSync(customDir).mode & 0o7777, customMode, 'Managed-name symlink and its path aliases must not authorize chmod of a shared target')
        assert.equal(fs.statSync(customFile).mode & 0o777, 0o600)
      } finally {
        linked.stop()
        process.env.AA_BROWSER_CONNECTION_FILE = previousFile
      }
    }
    console.log('PASS: a symlink at the managed directory preserves its shared target permissions')
  }
  const first = await connect()
  const second = await connect()
  start(first, 1, 'first')
  await waitFor(() => running.has('first'), 'first client call starts')
  start(second, 1, 'second')
  start(second, 2, 'sibling')
  await waitFor(() => running.has('second') && running.has('sibling'), 'second client concurrent calls start')
  const firstClient = clientFor('first')
  const secondClient = clientFor('second')
  assert.notEqual(firstClient, secondClient)
  assert.equal(clientFor('sibling'), secondClient, 'client identifier is stable across calls')
  assert.equal(server.activity().calls.filter((call) => call.id === 1).length, 2)
  assert.equal(server.cancelCall(1), false, 'ambiguous legacy ID must fail closed')
  for (const client of [null, '2', NaN, Infinity, 0, -1, 1.5, {}, secondClient + 100]) {
    assert.equal(server.cancelCall(1, client), false, `invalid/unknown client ${String(client)} must not fall back`)
  }
  for (const id of [null, '1', NaN, Infinity, {}, 99]) {
    assert.equal(server.cancelCall(id, secondClient), false, `invalid/unknown ID ${String(id)}`)
  }
  assert.ok([...running.values()].every((call) => !call.signal.aborted), 'rejected targets abort nothing')
  const snapshot = server.activity()
  snapshot.calls[0].client = -1
  assert.ok(server.activity().calls.every((call) => call.client > 0), 'activity snapshots cannot corrupt routing')

  assert.equal(server.cancelCall(1, secondClient), true, 'composite target cancels second client')
  await waitFor(() => response(second, 1), 'second client receives cancellation response')
  assert.equal(response(second, 1).ok, false)
  assert.match(response(second, 1).error, /cancelled second/)
  assert.equal(running.get('second').signal.aborted, true)
  assert.equal(running.get('first').signal.aborted, false, 'first client with identical ID stays active')
  assert.equal(running.get('sibling').signal.aborted, false, 'same-client sibling stays active')
  assert.equal(response(first, 1), undefined, 'cancelled response is not sent to the wrong client')
  assert.equal(server.cancelCall(1, secondClient), false, 'completed composite target must not fall back to first client')
  assert.equal(server.activity().calls.length, 2)
  assert.equal(server.activity().paused, false)
  assert.ok(activityEvents.some((state) => state.calls?.some((call) => call.id === 1 && call.client === secondClient)))
  await waitFor(() => first.messages.some((message) => message.event === 'progress'), 'progress event arrives')
  assert.deepEqual(first.messages.find((message) => message.event === 'progress'), {
    id: 1, event: 'progress', progress: 1, total: 10, message: 'first'
  }, 'wire progress retains original client-local request ID and schema')
  console.log('PASS: colliding client IDs cancel only the explicit composite target; ambiguous/invalid/stale targets fail closed')

  assert.equal(server.cancelCall(1), true, 'unique legacy ID still works')
  await waitFor(() => response(first, 1), 'unique legacy cancellation completes')
  assert.equal(response(first, 1).ok, false)
  running.get('sibling').finish()
  await waitFor(() => response(second, 2), 'sibling completes normally')
  assert.deepEqual(response(second, 2), { id: 2, ok: true, result: { label: 'sibling' } })
  assert.equal(server.activity().active, false)
  console.log('PASS: unique legacy cancellation remains compatible and sibling completion keeps original wire ID')

  for (const outcome of ['complete', 'cancel']) {
    first.messages.length = 0
    const original = `duplicate-original-${outcome}`
    const duplicate = `duplicate-rejected-${outcome}`
    const barrier = `duplicate-barrier-${outcome}`
    start(first, 7, original)
    await waitFor(() => running.has(original), 'original request owns pending ID')
    start(first, 7, duplicate)
    first.socket.send(JSON.stringify({ id: 7, tool: 'unknown_tool' }))
    // A later request/progress frame is an ordered WS barrier, not a timing-based sleep.
    start(first, 8, barrier)
    await waitFor(() => first.messages.some((message) => message.id === 8 && message.event === 'progress'), 'duplicate requests have been processed')
    assert.equal(running.has(duplicate), false, 'same-socket duplicate must not execute a second handler')
    assert.equal(response(first, 7), undefined, 'no duplicate error may steal the original pending response ID')
    assert.equal(first.messages.filter((message) => message.id === 7 && message.event === 'progress').length, 1)
    const pending = server.activity().calls.filter((call) => call.client === firstClient && call.id === 7)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].message, original, 'duplicate must not replace original activity ownership')
    assert.equal(running.get(original).signal.aborted, false)
    running.get(barrier).finish()
    await waitFor(() => response(first, 8), 'independent request still completes')
    if (outcome === 'cancel') {
      assert.equal(server.cancelCall(7, firstClient), true, 'original controller remains cancellable after duplicates')
      assert.equal(running.get(original).signal.aborted, true)
    } else {
      running.get(original).finish()
    }
    await waitFor(() => response(first, 7), 'only original request produces terminal response')
    const expected = outcome === 'cancel'
      ? { id: 7, ok: false, error: `cancelled ${original}` }
      : { id: 7, ok: true, result: { label: original } }
    assert.deepEqual(first.messages.filter((message) => message.id === 7 && typeof message.ok === 'boolean'), [expected])
    assert.equal(server.activity().active, false, 'original request cleans up once; completed ID can be reused')
  }
  console.log('PASS: duplicate pending IDs execute nothing and emit no competing reply; original completion/cancellation and ID reuse remain intact')

  first.messages.length = 0
  second.messages.length = 0
  start(first, 1, 'wire-first')
  start(second, 1, 'wire-second')
  await waitFor(() => running.has('wire-first') && running.has('wire-second'), 'wire cancellation collision starts')
  assert.equal(clientFor('wire-first'), firstClient)
  assert.equal(clientFor('wire-second'), secondClient)
  second.socket.send(JSON.stringify({ id: 1, cancel: true }))
  await waitFor(() => response(second, 1), 'client-local wire cancellation completes')
  assert.equal(response(second, 1).ok, false)
  assert.equal(running.get('wire-first').signal.aborted, false, 'WS cancel remains scoped to its sending connection')
  running.get('wire-first').finish()
  await waitFor(() => response(first, 1), 'other WS client completes')
  assert.deepEqual(response(first, 1), { id: 1, ok: true, result: { label: 'wire-first' } })
  console.log('PASS: unchanged WS {id, cancel:true} cancellation remains connection-local with colliding IDs')

  second.socket.close()
  await waitFor(() => server.info().clientCount === 1, 'second client disconnects')
  const replacement = await connect()
  start(replacement, 1, 'replacement')
  await waitFor(() => running.has('replacement'), 'replacement client starts')
  const replacementClient = clientFor('replacement')
  assert.ok(replacementClient > secondClient, 'client identifiers are not reused after disconnect')
  assert.equal(server.cancelCall(1, secondClient), false, 'stale disconnected client must not cancel a new connection')
  assert.equal(running.get('replacement').signal.aborted, false)
  assert.equal(server.cancelCall(1, replacementClient), true)
  await waitFor(() => response(replacement, 1), 'replacement cancellation completes')
  assert.equal(server.activity().active, false)
  console.log('PASS: reconnect receives a fresh client identifier and stale UI targets cannot abort it')
} finally {
  for (const call of running.values()) call.finish()
  for (const peer of peers) peer.socket.terminate()
  server.stop()
  if (previousConnectionFile === undefined) delete process.env.AA_BROWSER_CONNECTION_FILE
  else process.env.AA_BROWSER_CONNECTION_FILE = previousConnectionFile
  fs.rmSync(tmp, { recursive: true, force: true })
}
