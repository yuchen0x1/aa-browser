#!/usr/bin/env node
/** Safe path-resolution regressions for MCP cold launch; never starts an app. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import hostPath, { posix as path } from 'node:path'
import { Script, createContext } from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const ROOT = hostPath.resolve(hostPath.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = hostPath.join(ROOT, 'cli', 'mcp.mjs')
const source = fs.readFileSync(BRIDGE, 'utf8').replace(/\r\n/g, '\n')
const helpersStart = source.indexOf('function isRegularFile(file) {')
const helperEnd = source.indexOf('\nfunction connectionReady()', helpersStart)
assert.ok(helpersStart >= 0 && helperEnd > helpersStart, 'Could not isolate bridge launch path helpers')
const helpers = source.slice(helpersStart, helperEnd)
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(BRIDGE).href))

function createResolver({ platform = 'linux', env = {}, files = [] } = {}) {
  const regularFiles = new Set(files.map((file) => path.resolve(file)))
  const checkedPaths = []
  const fixtureFs = {
    statSync(file) {
      const resolved = path.resolve(file)
      checkedPaths.push(resolved)
      if (regularFiles.has(resolved)) return { isFile: () => true }
      throw new Error('fixture file does not exist')
    },
    existsSync() { return false },
    readFileSync() { throw new Error('fixture package file does not exist') }
  }
  const context = createContext({
    fs: fixtureFs,
    os: { homedir: () => '/fixture/home' },
    path,
    process: { env, platform },
    fileURLToPath
  })
  new Script(`${helpers}\nglobalThis.resolveBrowserLaunchSpec = browserLaunchSpec`, { filename: BRIDGE })
    .runInContext(context, { timeout: 1000 })
  return { resolve: () => structuredClone(context.resolveBrowserLaunchSpec()), checkedPaths }
}

test('finds the exact Linux installer-default AppImage path', () => {
  const appImage = path.join('/fixture/home', 'Applications', 'AaBrowser.AppImage')
  const { resolve, checkedPaths } = createResolver({ files: [appImage] })
  assert.deepEqual(resolve(), { command: appImage, args: [], cwd: path.dirname(appImage) })
  assert.ok(checkedPaths.includes(appImage), 'resolver must check the installer-default path')
})

test('does not auto-launch similarly named AppImages or copies outside the default directory', () => {
  const { resolve, checkedPaths } = createResolver({ files: [
    path.join('/fixture/home', 'Applications', 'AaBrowser-preview.AppImage'),
    path.join('/tmp', 'AaBrowser.AppImage')
  ] })
  assert.equal(resolve(), null)
  assert.ok(!checkedPaths.includes(path.join('/fixture/home', 'Applications', 'AaBrowser-preview.AppImage')))
  assert.ok(!checkedPaths.includes(path.join('/tmp', 'AaBrowser.AppImage')))
})

test('retains only existing validated explicit Linux executable names', () => {
  const appImage = '/fixture/custom/AaBrowser.AppImage'
  const supported = createResolver({ env: { AA_BROWSER_APP_PATH: appImage }, files: [appImage] })
  assert.deepEqual(supported.resolve(), { command: appImage, args: [], cwd: path.dirname(appImage) })

  const spacedAppImage = '/fixture/custom/Aa Browser.AppImage'
  const spacedSupported = createResolver({ env: { AA_BROWSER_APP_PATH: spacedAppImage }, files: [spacedAppImage] })
  assert.deepEqual(spacedSupported.resolve(), { command: spacedAppImage, args: [], cwd: path.dirname(spacedAppImage) })

  const unsupported = '/fixture/custom/other-browser.AppImage'
  const rejected = createResolver({ env: { AA_BROWSER_APP_PATH: unsupported }, files: [unsupported] })
  assert.throws(rejected.resolve, /AA_BROWSER_APP_PATH 不是受支持的 Aa Browser 可执行文件/)
})
