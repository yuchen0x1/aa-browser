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
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf-8'))
const output = path.join(ROOT, 'release', 'sbom.cdx.json')

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
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!key.startsWith('node_modules/') || !entry || typeof entry !== 'object') continue
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const version = typeof entry.version === 'string' ? entry.version : ''
  if (!name || !version) continue
  const id = `${name}@${version}`
  if (components.has(id)) continue
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

// Electron 运行时随安装包分发，不属于开发工具。
const electronVersion = String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '')
if (electronVersion) {
  components.set(`electron@${electronVersion}`, {
    type: 'framework',
    name: 'electron',
    version: electronVersion,
    purl: purlOf('electron', electronVersion),
    scope: 'required'
  })
}

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
