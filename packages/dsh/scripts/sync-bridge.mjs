#!/usr/bin/env node
/**
 * Copy the repository's built MCP bridge into this package.
 *
 * The bundle ships a single-file, dependency-free copy of the Aa Browser MCP
 * bridge so `dsh plugin add` / `npm publish` deliver it without installing the
 * whole browser. Source of truth: `out/bridge/mcp.cjs`, built by the repository
 * root with `npm run build` (`scripts/build-bridge.mjs`).
 *
 * Usage: node scripts/sync-bridge.mjs   (also runs from this package's `prepack`)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..')
const SOURCE = path.join(REPO_ROOT, 'out', 'bridge', 'mcp.cjs')
const TARGET = path.join(PACKAGE_ROOT, 'bridge.cjs')

if (!fs.existsSync(SOURCE)) {
  console.error(`sync-bridge: missing ${SOURCE}`)
  console.error('sync-bridge: run "npm run build" in the repository root first, then retry.')
  process.exit(1)
}

const text = fs.readFileSync(SOURCE, 'utf8')
const injected = text.match(/globalThis\.__AA_BRIDGE_VERSION__\s*=\s*"([^"]+)"/)
if (!injected) {
  console.error(`sync-bridge: ${SOURCE} has no injected bridge version; rebuild it with "npm run build".`)
  process.exit(1)
}
const version = injected[1]

fs.mkdirSync(path.dirname(TARGET), { recursive: true })
const temp = `${TARGET}.${process.pid}.tmp`
fs.writeFileSync(temp, text)
fs.renameSync(temp, TARGET)

const bytes = fs.statSync(TARGET).size
console.log(
  `sync-bridge: ${path.relative(PACKAGE_ROOT, TARGET)} <- ${path.relative(REPO_ROOT, SOURCE)} ` +
    `(${Math.round(bytes / 1024)} KB, bridge v${version})`,
)
