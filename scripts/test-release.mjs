import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { publishRelease } from './publish-release.mjs'
import { releaseFileNames } from './release-assets.mjs'

const tag = 'v0.2.0'
const windowsOnlyTag = 'v0.15.0'
const dualPlatformTag = 'v0.16.0'
const nextDualPlatformTag = 'v0.17.0'
const platformUpgradeTag = 'v0.18.0'
const approvalFixTag = 'v0.18.2'
const names = releaseFileNames(tag)
assert.ok(names.includes('sbom.cdx.json'), 'v0.2.0 releases must include the SBOM')
const windowsOnlyNames = releaseFileNames(windowsOnlyTag)
assert.deepEqual(windowsOnlyNames, [
  'SHA256SUMS.txt',
  'aa-browser-setup-0.15.0.exe',
  'aa-browser-setup-0.15.0.exe.blockmap',
  'latest.yml',
  'sbom.cdx.json'
].sort(), 'v0.15.0 must contain exactly the historical Windows release set')
const dualPlatformNames = releaseFileNames(dualPlatformTag)
assert.deepEqual(dualPlatformNames, [
  'SHA256SUMS.txt',
  'aa-browser-0.16.0-linux-x86_64.AppImage',
  'aa-browser-setup-0.16.0.exe',
  'aa-browser-setup-0.16.0.exe.blockmap',
  'latest-linux.yml',
  'latest.yml',
  'sbom.cdx.json'
].sort(), 'v0.16.0 must contain exactly the dual-platform release set')
const nextDualPlatformNames = releaseFileNames(nextDualPlatformTag)
assert.deepEqual(nextDualPlatformNames, [
  'SHA256SUMS.txt',
  'aa-browser-0.17.0-linux-x86_64.AppImage',
  'aa-browser-setup-0.17.0.exe',
  'aa-browser-setup-0.17.0.exe.blockmap',
  'latest-linux.yml',
  'latest.yml',
  'sbom.cdx.json'
].sort(), 'v0.17.0 must contain exactly the dual-platform release set')
assert.deepEqual(releaseFileNames(platformUpgradeTag), [
  'SHA256SUMS.txt',
  'aa-browser-0.18.0-linux-x86_64.AppImage',
  'aa-browser-setup-0.18.0.exe',
  'aa-browser-setup-0.18.0.exe.blockmap',
  'latest-linux.yml',
  'latest.yml',
  'sbom.cdx.json'
].sort(), 'v0.18.0 must preserve the Windows and Linux update feeds for installed clients')
assert.deepEqual(releaseFileNames(approvalFixTag), [
  'SHA256SUMS.txt',
  'aa-browser-0.18.2-linux-x86_64.AppImage',
  'aa-browser-setup-0.18.2.exe',
  'aa-browser-setup-0.18.2.exe.blockmap',
  'latest-linux.yml',
  'latest.yml',
  'sbom.cdx.json'
].sort(), 'v0.18.2 must keep both installed-client update feeds')
const repo = { owner: 'fixture', repo: 'fixture' }
const sha = 'a'.repeat(40)
const digest = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')
const root = process.cwd()
const fixture = await mkdtemp(path.join(tmpdir(), 'aa-release-'))

async function publish({ existing, originalAssets = [], ignoreTag = false, corruptUpload = false } = {}) {
  let release = existing && { id: 1, tag_name: tag, ...existing }
  const assets = [...originalAssets]
  const updates = []
  const repos = {
    getReleaseByTag: async ({ tag }) => {
      if (release?.tag_name === tag && !release.draft) return { data: { ...release } }
      throw Object.assign(new Error('Not found'), { status: 404 })
    },
    listReleases: async () => ({ data: release ? [release] : [] }),
    createRelease: async (args) => { release = { id: 1, ...args }; return { data: { ...release } } },
    listReleaseAssets: async () => ({ data: [...assets] }),
    uploadReleaseAsset: async ({ name, data }) => {
      assert.equal(release.draft, true)
      assets.push({ name, digest: digest(corruptUpload ? 'bad payload' : data) })
    },
    updateRelease: async (args) => {
      updates.push(args)
      release = { ...release, ...args, tag_name: ignoreTag ? 'untagged-provider' : args.tag_name, immutable: true }
    }
  }
  await publishRelease(repos, repo, tag, sha, () => {})
  return { release, assets, updates }
}

await mkdir(path.join(fixture, 'release'))
await mkdir(path.join(fixture, 'docs/releases/bodies'), { recursive: true })
await writeFile(path.join(fixture, 'docs/releases/bodies', `${tag}.md`), '# Fixture')
for (const name of names) await writeFile(path.join(fixture, 'release', name), name)
process.chdir(fixture)
try {
  await test('new release preserves its tag, publishes only after validating both platforms', async () => {
    const result = await publish()
    assert.equal(result.release.tag_name, tag)
    assert.equal(result.release.body, '# Fixture')
    assert.equal(result.release.draft, false)
    assert.equal(result.release.immutable, true)
    assert.equal(result.assets.length, names.length)
    assert.deepEqual(result.updates.map((update) => update.tag_name), [tag])
    assert.equal(result.updates[0].make_latest, 'true', 'installed clients must discover the newly published stable release')
  })
  await test('a matching existing draft asset is reused', async () => {
    const result = await publish({ existing: { draft: true }, originalAssets: [{ name: names[0], digest: digest(names[0]) }] })
    assert.equal(result.assets.length, names.length)
  })
  await test('a mismatched draft asset blocks publication', async () => {
    await assert.rejects(publish({ existing: { draft: true }, originalAssets: [{ name: names[0], digest: digest('obsolete') }] }), /Draft asset differs/)
  })
  await test('a published release is read only', async () => {
    const result = await publish({ existing: { draft: false, immutable: true }, originalAssets: names.map((name) => ({ name, digest: digest(name) })) })
    assert.equal(result.updates.length, 0)
    await assert.rejects(publish({ existing: { draft: false, immutable: true } }), /Published asset missing/)
  })
  await test('wrong GitHub digest and tag fail verification', async () => {
    await assert.rejects(publish({ corruptUpload: true }), /GitHub asset digest differs/)
    await assert.rejects(publish({ ignoreTag: true }), /Not found/)
  })
} finally {
  process.chdir(root)
  await rm(fixture, { recursive: true, force: true })
}
