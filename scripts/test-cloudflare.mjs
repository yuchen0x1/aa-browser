#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileFunction } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TOOL_DEFS } from '../src/shared/tool-defs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cloudflare-'))
const compiledFile = path.join(temp, 'cloudflare.js')
let activeFrames = []
let frameResults = new Map()

try {
  const compiled = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(root, 'src', 'main', 'cloudflare.ts'),
    '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', temp,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop'
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Cloudflare module compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)

  const framesModule = {
    listFrames: () => activeFrames,
    frameEvaluate: async (_wc, frameId) => frameResults.get(frameId) ?? null
  }
  const module = { exports: {} }
  compileFunction(fs.readFileSync(compiledFile, 'utf8'), ['require', 'module', 'exports'], { filename: compiledFile })(
    (name) => {
      assert.equal(name, './frames', `unexpected production dependency: ${name}`)
      return framesModule
    },
    module,
    module.exports
  )
  const cloudflare = module.exports

  const main = {
    url: 'https://site.test/check?__cf_chl_tk=secret-main-token&view=1',
    title: 'Example page',
    challenge: false,
    hasChallengeText: false,
    hasChallengeToken: false,
    hasChallengeElement: false
  }
  const ordinary = {
    id: 'f-ordinary',
    url: 'https://widgets.example.test/checkbox',
    depth: 1,
    crossOrigin: true
  }
  const challenge = {
    id: 'f-challenge',
    url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b?cf_chl_jschl_tk=secret-frame-token',
    depth: 1,
    crossOrigin: true
  }
  const challengeResult = {
    challenge: true,
    bodyText: 'Verify you are human',
    controls: [{ index: 0, kind: 'checkbox', label: 'Verify you are human', checked: false, rect: { x: 5, y: 5, width: 20, height: 20 } }]
  }

  function makeTab(owners) {
    const commands = []
    const webContents = {
      isDestroyed: () => false,
      getURL: () => main.url,
      executeJavaScript: async (source) => {
        if (source.includes('const title =')) return main
        if (source.includes('const out = []')) return owners
        throw new Error(`unexpected page script: ${source.slice(0, 60)}`)
      },
      debugger: {
        isAttached: () => true,
        sendCommand: async (...args) => { commands.push(args); return {} }
      }
    }
    return { tab: { view: { webContents } }, commands }
  }

  activeFrames = [ordinary]
  frameResults = new Map([[ordinary.id, { challenge: true, bodyText: 'Verify you are human', controls: challengeResult.controls }]])
  const ordinaryOnly = makeTab([{ src: ordinary.url, x: 100, y: 100, width: 300, height: 100 }])
  const ordinaryStatus = await cloudflare.inspectCloudflare(ordinaryOnly.tab)
  assert.equal(ordinaryStatus.detected, false, 'ordinary cross-origin iframe must not be treated as Cloudflare')
  await assert.rejects(() => cloudflare.clickCloudflareControl(ordinaryOnly.tab, {}), /没有找到可点击的 Cloudflare/)
  assert.equal(ordinaryOnly.commands.length, 0, 'ordinary iframe must never receive a pointer event')

  activeFrames = [ordinary, challenge]
  frameResults = new Map([[challenge.id, challengeResult]])
  const target = makeTab([
    { src: ordinary.url, x: 10, y: 10, width: 300, height: 100 },
    { src: challenge.url, x: 100, y: 200, width: 300, height: 100 }
  ])
  const status = await cloudflare.inspectCloudflare(target.tab)
  assert.equal(status.detected, true)
  assert.equal(status.requiresUserAction, true)
  assert.deepEqual(status.frames.map((frame) => frame.frameId), [challenge.id], 'only challenges.cloudflare.com frames are exposed')
  assert.equal(status.frames[0].visible, true)

  const clicked = await cloudflare.clickCloudflareControl(target.tab, {})
  assert.equal(clicked.frameId, challenge.id)
  assert.deepEqual(clicked.point, { x: 115, y: 215 }, 'iframe owner offset must be included in the real click point')
  assert.equal(target.commands.length, 3, 'click sends one move/press/release gesture')
  assert.equal(target.commands[1][0], 'Input.dispatchMouseEvent')
  assert.equal(target.commands[1][1].type, 'mousePressed')
  assert.equal(target.commands[1][1].button, 'left')

  const formatted = cloudflare.formatCloudflareStatus({
    ...status,
    url: main.url,
    frames: status.frames,
    checkedAt: Date.now()
  })
  assert.doesNotMatch(formatted, /secret-main-token|secret-frame-token/, 'challenge token values must not cross the MCP output boundary')
  assert.match(formatted, /%5Bredacted%5D/)

  const definition = TOOL_DEFS.find((item) => item.name === 'browser_cloudflare')
  assert.ok(definition, 'browser_cloudflare schema must exist')
  assert.equal(definition.inputSchema.properties.confirm.type, 'boolean')
  const toolsSource = fs.readFileSync(path.join(root, 'src', 'main', 'tools.ts'), 'utf8')
  assert.match(toolsSource, /args\['confirm'\] !== true/, 'browser_cloudflare click must require confirm:true')
  console.log('PASS: Cloudflare helper only targets visible challenge frames, sends one confirmed real click, and redacts challenge tokens')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
