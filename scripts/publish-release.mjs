import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { releaseFileNames } from './release-assets.mjs'

export async function publishRelease(repos, repo, tag, sha, log = console.log) {
  const names = releaseFileNames(tag)
  const body = await readFile(`docs/releases/bodies/${tag}.md`, 'utf8')
  let release
  try {
    release = (await repos.getReleaseByTag({ ...repo, tag })).data
  } catch (error) {
    if (error.status !== 404) throw error
    // GitHub's tag endpoint can hide draft releases. Look only for this exact tag.
    const { data } = await repos.listReleases({ ...repo, per_page: 100 })
    release = data.find((item) => item.tag_name === tag)
    release ??= (await repos.createRelease({
      ...repo, tag_name: tag, target_commitish: sha, name: `Aa Browser ${tag}`, body, draft: true, prerelease: false
    })).data
  }

  assert.equal(release.tag_name, tag, 'Release tag changed before the upload')
  const endpoint = { ...repo, release_id: release.id }
  let { data: assets } = await repos.listReleaseAssets({ ...endpoint, per_page: 100 })
  if (!release.draft) {
    assert.ok(release.immutable, `Published release ${tag} is mutable`)
    for (const name of names) {
      assert.ok(assets.some((asset) => asset.name === name && /^sha256:[a-f0-9]{64}$/.test(asset.digest)), `Published asset missing or invalid: ${name}`)
    }
    log(`${tag} is already published. Its immutable assets are present.`)
    return
  }

  const expected = new Map()
  for (const name of names) {
    const data = await readFile(`release/${name}`)
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    expected.set(name, digest)
    const existing = assets.find((asset) => asset.name === name)
    if (existing) {
      assert.equal(existing.digest, digest, `Draft asset differs from the tested build: ${name}`)
      continue
    }
    await repos.uploadReleaseAsset({
      ...endpoint, name, data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) },
      request: { timeout: 300000 }
    })
    log(`Uploaded ${name} (${data.length} bytes)`)
  }

  ;({ data: assets } = await repos.listReleaseAssets({ ...endpoint, per_page: 100 }))
  assert.equal(assets.length, names.length, 'Draft has an unexpected asset set')
  for (const asset of assets) {
    assert.equal(asset.digest, expected.get(asset.name), `GitHub asset digest differs: ${asset.name}`)
  }
  await repos.updateRelease({ ...endpoint, tag_name: tag, target_commitish: sha, draft: false, make_latest: 'true' })
  const { data: verified } = await repos.getReleaseByTag({ ...repo, tag })
  assert.equal(verified.id, release.id)
  assert.equal(verified.tag_name, tag)
  assert.equal(verified.draft, false)
  assert.equal(verified.immutable, true, 'GitHub immutable releases must be enabled')
  log(`Published immutable release ${tag}`)
}
