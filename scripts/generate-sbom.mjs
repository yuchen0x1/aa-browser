#!/usr/bin/env node
/**
 * 生成 CycloneDX 1.5 SBOM（软件物料清单）。
 *
 * 数据来源只有仓库内的 package.json / package-lock.json，不访问网络：
 *   - 以 package-lock 的 packages 表还原完整依赖树（含传递依赖）；
 *   - 生产依赖 scope=required，开发依赖 scope=optional；
 *   - Electron 虽然登记在 devDependencies，但会随安装包分发，单独标为 framework/required。
 *
 * 输出：release/sbom.cdx.json（随正式 Release 一起上传，并纳入 SHA256SUMS.txt）。
 * 用法：npm run sbom
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, filename), 'utf-8'))
  } catch (error) {
    throw new Error(`Unable to read ${filename}: ${error.message}`)
  }
}

const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const output = path.join(ROOT, 'release', 'sbom.cdx.json')
const packages = lock?.packages
if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
  throw new Error('Invalid package-lock.json: expected a packages object')
}

const electronEntry = packages['node_modules/electron']
if (!electronEntry || typeof electronEntry !== 'object' || Array.isArray(electronEntry)) {
  throw new Error('Invalid package-lock.json: missing runtime entry packages["node_modules/electron"]')
}
const electronVersion = electronEntry.version
const numericVersion = '(?:0|[1-9]\\d*)'
const prereleaseIdentifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const exactVersion = new RegExp(
  `^${numericVersion}\\.${numericVersion}\\.${numericVersion}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
)
if (typeof electronVersion !== 'string' || electronVersion.trim() !== electronVersion || !exactVersion.test(electronVersion)) {
  throw new Error('Invalid package-lock.json: packages["node_modules/electron"].version must be an exact semantic version')
}

function purlOf(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name
  return `pkg:npm/${encoded}@${version}`
}

function licenseOf(entry) {
  const license = entry?.license
  if (typeof license !== 'string' || !license.trim()) return undefined
  return [{ license: { name: license.trim() } }]
}

const components = new Map()
for (const [key, entry] of Object.entries(packages)) {
  if (!key.startsWith('node_modules/') || !entry || typeof entry !== 'object') continue
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const version = typeof entry.version === 'string' ? entry.version : ''
  if (!name || !version) continue
  const id = `${name}@${version}`
  const existing = components.get(id)
  if (existing) {
    // 同名同版本可能同时从生产和开发路径引入，生产 scope 优先。
    if (entry.dev !== true) existing.scope = 'required'
    continue
  }
  const component = {
    type: 'library',
    name,
    version,
    purl: purlOf(name, version),
    scope: entry.dev === true ? 'optional' : 'required'
  }
  const licenses = licenseOf(entry)
  if (licenses) component.licenses = licenses
  components.set(id, component)
}

// Electron 运行时随安装包分发，只提升 lock 中精确版本的现有组件，保留许可证等元数据。
const runtime = components.get(`electron@${electronVersion}`)
runtime.type = 'framework'
runtime.scope = 'required'

const timestamp = process.env['SOURCE_DATE_EPOCH']
  ? new Date(Number(process.env['SOURCE_DATE_EPOCH']) * 1000).toISOString()
  : new Date().toISOString()

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp,
    tools: [{ vendor: 'Aa Browser contributors', name: 'generate-sbom', version: pkg.version }],
    component: {
      type: 'application',
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      purl: purlOf(pkg.name, pkg.version),
      licenses: [{ license: { id: 'MIT' } }]
    }
  },
  components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`, 'utf-8')
const required = bom.components.filter((component) => component.scope === 'required').length
const optional = bom.components.length - required
console.log(`✅ SBOM 已生成: ${path.relative(ROOT, output)} (CycloneDX ${bom.specVersion}, ${bom.components.length} 个组件: ${required} required / ${optional} optional)`)
