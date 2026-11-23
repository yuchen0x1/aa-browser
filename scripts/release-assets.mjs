import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 与安装包一起发布的软件物料清单（CycloneDX）。 */
export const SBOM_FILE = 'sbom.cdx.json'
/** v0.15.0 因 Linux 回归未通过而暂缓 Linux 包；历史标签资产集保持不变。 */
const WINDOWS_ONLY_TAGS = new Set(['v0.15.0'])

export function releaseAssets(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  const version = tag.slice(1)
  const installer = `aa-browser-setup-${version}.exe`
  const assets = {
    'windows-x64': [installer, `${installer}.blockmap`, 'latest.yml'],
    'linux-x64': [`aa-browser-${version}-linux-x86_64.AppImage`, 'latest-linux.yml']
  }
  return WINDOWS_ONLY_TAGS.has(tag) ? { 'windows-x64': assets['windows-x64'] } : assets
}

/** v0.2.0 起正式发行包含 SBOM；更早的标签保持原资产集合，供历史校验。 */
export function supportsSbom(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 0 || (major === 0 && minor >= 2)
}

/** 一个正式发布应包含的全部资产（含 SHA256SUMS.txt），按名称排序。 */
export function releaseFileNames(tag) {
  const names = Object.values(releaseAssets(tag)).flat()
  if (supportsSbom(tag)) names.push(SBOM_FILE)
  names.push('SHA256SUMS.txt')
  return names.sort()
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
  const names = releaseFileNames(tag).filter((name) => name !== 'SHA256SUMS.txt')
  if (supportsSbom(tag) && !existsSync(path.join(folder, SBOM_FILE))) {
    throw new Error(`Missing ${SBOM_FILE}: run npm run sbom before generating the release manifest`)
  }
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
