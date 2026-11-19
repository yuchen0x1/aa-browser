import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { releaseAssets, supportsSbom, SBOM_FILE } from './release-assets.mjs'

const repository = process.argv[2]
assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/)
const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/latest`], { encoding: 'utf8' }))
const tag = release.tag_name
const platforms = releaseAssets(tag)
const expected = [...platforms['windows-x64'], ...(supportsSbom(tag) ? [SBOM_FILE] : []), 'SHA256SUMS.txt']
if (tag !== 'v0.0.8') {
  assert.equal(release.immutable, true, 'New releases must be immutable')
  execFileSync('gh', ['release', 'verify', tag, '--repo', repository], { stdio: 'inherit' })
  expected.push(...platforms['linux-x64'])
}
const metadata = new Map()
for (const name of expected) {
  const asset = release.assets.find((item) => item.name === name && item.state === 'uploaded')
  assert.ok(asset, `Missing published asset: ${name}`)
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/)
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`
  const small = name.endsWith('.yml') || name === 'SHA256SUMS.txt' || name === SBOM_FILE
  const response = await fetch(url, { method: small ? 'GET' : 'HEAD', signal: AbortSignal.timeout(30_000) })
  assert.ok(response.ok, `Download failed: ${name} HTTP ${response.status}`)
  if (small) {
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), asset.digest, name)
    metadata.set(name, bytes.toString('utf8'))
  }
  console.log(`PASS ${name} (${asset.size} bytes)`)
}
if (supportsSbom(tag)) {
  const bom = JSON.parse(metadata.get(SBOM_FILE))
  assert.equal(bom.bomFormat, 'CycloneDX', 'SBOM must be CycloneDX JSON')
  assert.ok(Array.isArray(bom.components) && bom.components.length > 0, 'SBOM must list components')
  assert.equal(bom.metadata?.component?.version, tag.slice(1), 'SBOM must describe the released version')
}
const sums = metadata.get('SHA256SUMS.txt').split(/\r?\n/).filter(Boolean)
assert.equal(sums.length, expected.length - 1)
for (const name of expected.filter((entry) => entry !== 'SHA256SUMS.txt')) {
  const digest = release.assets.find((asset) => asset.name === name).digest.slice('sha256:'.length)
  assert.ok(sums.includes(`${digest}  ${name}`), `SHA256SUMS.txt mismatch: ${name}`)
}
for (const name of expected.filter((entry) => entry.endsWith('.yml'))) {
  assert.ok(metadata.get(name).split(/\r?\n/).includes(`version: ${tag.slice(1)}`), `Update version mismatch: ${name}`)
}
console.log(`PASS ${tag} public release and update feed`)
