import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function releaseAssets(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  const version = tag.slice(1)
  const installer = `aa-browser-setup-${version}.exe`
  return {
    'windows-x64': [installer, `${installer}.blockmap`, 'latest.yml'],
    'linux-x64': [`aa-browser-${version}-linux-x86_64.AppImage`, 'latest-linux.yml']
  }
}

export async function digestFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest(encoding)
}

async function prepare(platform, tag, folder) {
  const names = releaseAssets(tag)[platform]
  assert.ok(names, `Unknown platform: ${platform}`)
  const metadata = names.at(-1)
  const [primary] = names
  const yaml = await import('js-yaml')
  const info = yaml.load(readFileSync(path.join(folder, metadata), 'utf8'))
  assert.equal(info.version, tag.slice(1), `${metadata} version`)
  const artifact = path.join(folder, primary)
  assert.equal(info.files.length, 1, `${metadata} must reference exactly one artifact`)
  const [entry] = info.files
  assert.equal(entry.url, primary, `${metadata} file URL`)
  assert.equal(entry.size, statSync(artifact).size, `${metadata} artifact size`)
  assert.equal(entry.sha512, await digestFile(artifact, 'sha512', 'base64'), `${metadata} artifact digest`)
  assert.equal(info.path, primary, `${metadata} legacy path`)
  assert.equal(info.sha512, entry.sha512, `${metadata} legacy digest`)

  const validated = path.join(folder, 'validated')
  await mkdir(validated, { recursive: true })
  for (const name of names) await copyFile(path.join(folder, name), path.join(validated, name))
  console.log(`Verified ${platform} update metadata and staged ${names.join(', ')}`)
}

async function writeManifest(tag, folder) {
  const names = Object.values(releaseAssets(tag)).flat().sort()
  const lines = await Promise.all(names.map(async (name) => `${await digestFile(path.join(folder, name))}  ${name}`))
  await writeFile(path.join(folder, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, platform] = process.argv.slice(2)
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const folder = path.resolve('release')
  if (mode === 'prepare') await prepare(platform, `v${version}`, folder)
  else if (mode === 'manifest') await writeManifest(`v${version}`, folder)
  else throw new Error('Expected prepare <platform> or manifest')
}
