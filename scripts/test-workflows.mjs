import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-workflows-'))
const out = path.join(temp, 'compiled')
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const compiled = spawnSync(process.execPath, [tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
  '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
  ...['workflows', 'atomic-json', 'redaction'].map((name) => path.join(root, `src/main/${name}.ts`))], { cwd: root, encoding: 'utf8' })
assert.equal(compiled.status, 0, `Compilation failed: ${compiled.stdout}\n${compiled.stderr}`)
const { WorkflowEngine } = require(path.join(out, 'workflows.js'))
const key = randomBytes(32)
const protect = (text) => {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
}
const unprotect = (text) => {
  const data = Buffer.from(text, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}
let sequence = 0
const result = { content: [{ type: 'text', text: 'token=never-persist-result' }] }
const options = (overrides = {}) => ({
  file: path.join(temp, `workflows-${++sequence}.json`), execute: async () => result,
  isReadOnly: (tool) => ['browser_extract', 'browser_snapshot', 'browser_page_state', 'browser_assert'].includes(tool),
  approve: async () => true, verify: async () => ({ ok: true, url: 'https://fixture.test/' }), protect, unprotect, ...overrides
})
const step = (id, overrides = {}) => ({ id, name: id, tool: 'browser_extract', args: {}, ...overrides })
const definition = (steps, more = {}) => ({ name: 'fixture', profileId: 'profile-a', steps, ...more })

try {
  const calls = []
  const leases = []
  const verification = []
  const config = options({
    execute: async (tool, args, context) => { calls.push({ tool, args, context }); return result },
    verify: async (request) => { verification.push(request); return { ok: true } },
    withProfile: async (profile, owner, id, operation) => { leases.push({ profile, owner, id }); return operation() }
  })
  const engine = new WorkflowEngine(config)
  engine.load()
  const record = engine.create(definition([step('later', { dependsOn: ['first'] }), step('first')]), 'owner-a')
  assert.equal(engine.list('owner-b').length, 0)
  assert.equal(engine.get(record.id, 'owner-b'), null)
  assert.throws(() => engine.run(record.id, 'owner-b'), /not found/)
  const completed = await engine.run(record.id, 'owner-a')
  assert.equal(completed.status, 'completed')
  assert.deepEqual(calls.map((call) => call.context.stepId), ['first', 'later'])
  assert.equal(calls[0].context.profileId, 'profile-a')
  assert.equal(verification.length, 4)
  assert.equal(leases.length, 1)
  assert.ok(completed.steps.every((item) => item.checkpointAt && item.finishedAt >= item.startedAt))
  assert.ok(!fs.readFileSync(config.file, 'utf8').includes('never-persist-result'))
  assert.throws(() => engine.create(definition([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]), 'owner-a'), /cycle/)
  assert.throws(() => engine.create(definition([step('a', { args: { __aaClientId: 9 } })]), 'owner-a'), /Reserved/)
  assert.throws(() => engine.create(definition([step('a', { tool: 'browser_tasks' })]), 'owner-a'), /not permitted/)
  console.log('PASS: dependency ordering, real profile lease/context, ownership, checkpoints and output minimization')

  let enteredIdentity
  const identityEntered = new Promise((resolve) => { enteredIdentity = resolve })
  let dispatchedAfterCancel = false
  const identityWait = new WorkflowEngine(options({
    execute: async () => { dispatchedAfterCancel = true; return result },
    withProfile: async (_profile, _owner, _id, _operation, signal) => {
      enteredIdentity()
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('identity approval cancelled')), { once: true })
      })
      throw new Error('An unapproved identity must never be entered')
    }
  }))
  const identityWorkflow = identityWait.create(definition([step('read')]), 'owner-a')
  const identityRun = identityWait.run(identityWorkflow.id, 'owner-a')
  await identityEntered
  identityWait.cancel(identityWorkflow.id, 'owner-a')
  assert.equal((await identityRun).status, 'cancelled')
  assert.equal(dispatchedAfterCancel, false)
  console.log('PASS: cancellation reaches pending Profile authorization before a browser tool can dispatch')

  let attempts = 0
  const retries = new WorkflowEngine(options({ execute: async () => { if (++attempts === 1) throw new Error('network timeout'); return result } }))
  const retried = retries.create(definition([step('read')]), 'owner-a')
  assert.equal((await retries.run(retried.id, 'owner-a')).status, 'completed')
  assert.equal(attempts, 2)
  console.log('PASS: read-only network failure retries within the configured bound')

  let mutations = 0
  let approvals = 0
  let allow = true
  const mutationConfig = options({ execute: async () => { mutations += 1; throw new Error('access_token=secret-write-error') }, approve: async () => { approvals += 1; return allow } })
  const mutating = new WorkflowEngine(mutationConfig)
  const mutation = mutating.create(definition([step('write', { tool: 'browser_click', args: { ref: 'e1' }, maxRetries: 5 })]), 'owner-a')
  const failed = await mutating.run(mutation.id, 'owner-a')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.steps[0].sideEffect, 'uncertain')
  assert.equal(mutations, 1, 'writes must not use automatic retries')
  assert.equal(approvals, 1)
  const reloaded = new WorkflowEngine(mutationConfig)
  reloaded.load()
  assert.equal((await reloaded.resume(mutation.id, 'owner-a')).status, 'waiting')
  assert.equal(mutations, 1, 'resume must not replay a failed mutation')
  allow = false
  assert.equal((await reloaded.retry(mutation.id, 'write', 'owner-a')).status, 'waiting')
  assert.equal(mutations, 1, 'explicit retry cannot bypass trusted approval')
  assert.equal(approvals, 2)
  assert.ok(!fs.readFileSync(mutationConfig.file, 'utf8').includes('secret-write-error'))
  console.log('PASS: uncertain writes are never auto-replayed and explicit retries require native approval')

  let release
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const crashConfig = options({ execute: async (tool) => {
    if (tool === 'browser_extract') return result
    started()
    return new Promise((resolve) => { release = resolve })
  } })
  const crashed = new WorkflowEngine(crashConfig)
  const crashRecord = crashed.create(definition([step('done'), step('submit', { tool: 'browser_click', dependsOn: ['done'] })]), 'owner-a')
  const firstRun = crashed.run(crashRecord.id, 'owner-a')
  await startedPromise
  // The restored engine sees the real on-disk dispatch intent, as a replacement process would.
  const restored = new WorkflowEngine(crashConfig)
  restored.load()
  assert.equal(restored.get(crashRecord.id).status, 'interrupted')
  assert.equal(restored.get(crashRecord.id).steps[1].sideEffect, 'uncertain')
  assert.equal((await restored.resume(crashRecord.id, 'owner-a')).status, 'waiting')
  assert.equal(restored.get(crashRecord.id).steps[0].status, 'completed')
  crashed.pause(crashRecord.id, 'owner-a')
  release(result)
  await firstRun
  console.log('PASS: crash recovery preserves completed checkpoints and stops before an uncertain side effect')

  const protectedConfig = options()
  const protectedEngine = new WorkflowEngine(protectedConfig)
  const secret = protectedEngine.create(definition([step('input', { tool: 'browser_type', args: { ref: 'e1', text: 'unlabelled-password-value' } })]), 'owner-a')
  assert.ok(!fs.readFileSync(protectedConfig.file, 'utf8').includes('unlabelled-password-value'))
  const protectedRestore = new WorkflowEngine(protectedConfig)
  protectedRestore.load()
  assert.equal((await protectedRestore.run(secret.id, 'owner-a')).status, 'completed')
  const noCrypto = options({ protect: undefined, unprotect: undefined })
  const ephemeral = new WorkflowEngine(noCrypto)
  const ephemeralRecord = ephemeral.create(definition([step('input', { args: { text: 'plaintext-secret' } })]), 'owner-a')
  assert.ok(!fs.readFileSync(noCrypto.file, 'utf8').includes('plaintext-secret'))
  const ephemeralRestore = new WorkflowEngine(noCrypto)
  ephemeralRestore.load()
  assert.equal((await ephemeralRestore.run(ephemeralRecord.id, 'owner-a')).status, 'waiting')
  ephemeralRestore.setStepInput(ephemeralRecord.id, 'input', {}, 'owner-a')
  assert.equal((await ephemeralRestore.resume(ephemeralRecord.id, 'owner-a')).status, 'completed')
  console.log('PASS: encrypted arguments restore; without OS protection inputs are withheld and require re-entry')

  let reached = 0
  const check = new WorkflowEngine(options({ execute: async () => { reached += 1; return result }, verify: async () => ({ ok: false, detail: 'page changed' }) }))
  const checkRecord = check.create(definition([step('guarded', { tool: 'browser_click' })]), 'owner-a')
  assert.equal((await check.run(checkRecord.id, 'owner-a')).status, 'waiting')
  assert.equal(reached, 0)
  let pageChanged = false
  const approvalRace = new WorkflowEngine(options({
    execute: async () => { reached += 1; return result },
    verify: async () => ({ ok: !pageChanged }),
    approve: async () => { pageChanged = true; return true }
  }))
  const approvalRecord = approvalRace.create(definition([step('guarded', { tool: 'browser_click' })]), 'owner-a')
  assert.equal((await approvalRace.run(approvalRecord.id, 'owner-a')).status, 'waiting')
  assert.equal(reached, 0, 'page changes during human approval must prevent executor dispatch')
  const corruptConfig = options()
  fs.writeFileSync(corruptConfig.file, '{broken')
  const corrupt = new WorkflowEngine(corruptConfig)
  corrupt.load()
  assert.equal(corrupt.ready, false)
  assert.throws(() => corrupt.create(definition([step('a')]), 'owner-a'), /unavailable/)
  assert.ok(fs.existsSync(corruptConfig.file))
  console.log('PASS: changed pages and corrupt checkpoint storage fail closed')

  const templateEngine = new WorkflowEngine(options())
  assert.equal(templateEngine.templates().length, 8)
  const scheduleAt = Date.now() + 60_000
  const scheduled = templateEngine.createFromTemplate('scheduled', { url: 'https://fixture.test', profileId: 'profile-a', scheduleAt }, 'owner-a')
  assert.equal(templateEngine.runDue().length, 0)
  const due = templateEngine.runDue(scheduleAt + 1)
  assert.equal(due.length, 1)
  await Promise.all(due)
  assert.equal(templateEngine.get(scheduled.id).status, 'completed')
  assert.equal(templateEngine.runDue(scheduleAt + 2).length, 0)
  console.log('PASS: eight templates reuse existing tools; scheduled one-shot execution runs only once')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
