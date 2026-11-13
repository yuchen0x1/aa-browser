/** Exercise the actual GitHub Actions publish script with a simulated GitHub API. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'

const workflow = yaml.load(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
const script = workflow.jobs.release.steps.find((step) => step.uses === 'actions/github-script@v7').with.script
const files = new Map(['aa-browser-setup-0.0.3.exe', 'aa-browser-setup-0.0.3.exe.blockmap', 'latest.yml', 'SHA256SUMS.txt'].map((name) => [name, Buffer.from(name)]))
async function publish({ existing = false, draft = false, ignoreExplicitTag = false } = {}) {
  let release = existing ? { id: 1, tag_name: 'v0.0.3', draft, prerelease: false } : null
  const assets = []
  const updates = []
  const repos = {
    getReleaseByTag: async ({ tag }) => {
      if (release?.tag_name === tag) return { data: { ...release } }
      throw Object.assign(new Error('Not found'), { status: 404 })
    },
    listReleases: async () => ({ data: release ? [{ ...release }] : [] }),
    createRelease: async (args) => { release = { ...args, id: 1 }; return { data: { ...release } } },
    updateRelease: async (args) => {
      updates.push(args)
      // Model the observed provider behavior: omitting tag_name loses the tag.
      release = { ...release, ...args, tag_name: ignoreExplicitTag ? 'untagged-provider-error' : args.tag_name ?? 'untagged-provider-default' }
      return { data: { ...release } }
    },
    listReleaseAssets: async () => ({ data: assets.map((asset) => ({ ...asset })) }),
    uploadReleaseAsset: async ({ name, data }) => { assets.push({ id: assets.length + 1, name, digest: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}` }); return { data: assets.at(-1) } },
    deleteReleaseAsset: async () => { throw new Error('Unexpected deletion in fixture') }
  }
  const mockedFs = {
    readdirSync: () => [...files.keys()],
    readFileSync: (file, encoding) => encoding ? '# Fixture release notes' : files.get(path.basename(file))
  }
  const require = (name) => {
    if (name === 'node:crypto') return crypto
    if (name === 'node:path') return path
    if (name === 'node:fs') return mockedFs
    throw new Error(`Unexpected module: ${name}`)
  }
  await new vm.Script(`(async () => { ${script}\n })()`).runInNewContext({ require, github: { rest: { repos } }, context: { repo: { owner: 'fixture', repo: 'fixture' }, ref: 'refs/tags/v0.0.3', sha: 'a'.repeat(40) }, core: { info() {} } }, { timeout: 2000 })
  return { release, assets, updates }
}
let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`) }
  catch (error) { failures++; console.error(`FAIL: ${name}: ${error.message}`) }
}
await test('new release preserves its version tag through every metadata update', async () => {
  const result = await publish()
  assert.equal(result.release.tag_name, 'v0.0.3')
  assert.equal(result.release.draft, false)
  assert.equal(result.assets.length, 4)
  assert.ok(result.updates.every((update) => update.tag_name === 'v0.0.3'))
})
await test('existing draft publishes after its full asset set is ready', async () => {
  const result = await publish({ existing: true, draft: true })
  assert.equal(result.release.draft, false)
  assert.equal(result.release.tag_name, 'v0.0.3')
})
await test('existing published release keeps its metadata during asset repair', async () => {
  const result = await publish({ existing: true })
  assert.equal(result.updates.length, 0)
  assert.equal(result.assets.length, 4)
})
await test('provider tag mismatch fails the publish step instead of reporting success', async () => {
  await assert.rejects(() => publish({ ignoreExplicitTag: true }))
})
console.log(`${4 - failures}/4 release checks passed (simulated API)`)
process.exitCode = failures ? 1 : 0
