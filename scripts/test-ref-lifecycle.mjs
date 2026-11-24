#!/usr/bin/env node
/**
 * Ref 代际失效回归：导航、渲染进程重启、URL 漂移与快照过期必须返回
 * 明确原因，且错误信息引导 Agent 重新调用 browser_snapshot。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ref-lifecycle-'))
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const compiled = spawnSync(process.execPath, [
  tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', outDir,
  '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  path.join(root, 'src/main/ref-context.ts')
], { encoding: 'utf8' })
if (compiled.status !== 0) throw new Error(`Compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)

const { noteNavigation, noteRendererRestart, noteSnapshot, checkRefContext } = await import(
  pathToFileURL(path.join(outDir, 'ref-context.js')).href
)

try {
  let url = 'https://example.test/page'
  const wc = { getURL: () => url }

  assert.equal(checkRefContext(wc), null, '首次操作不应强制要求先 snapshot')

  noteSnapshot(wc, url)
  assert.equal(checkRefContext(wc), null, '刚获取的快照必须可用')

  noteNavigation(wc)
  let failure = checkRefContext(wc)
  assert.equal(failure?.code, 'NAVIGATION_ERROR')
  assert.match(failure.message, /browser_snapshot/)
  assert.match(failure.message, /导航|路由/)

  noteSnapshot(wc, url)
  url = 'https://example.test/page#/next'
  failure = checkRefContext(wc)
  assert.equal(failure?.code, 'NAVIGATION_ERROR', '漏掉导航事件时 URL 漂移也必须失效')

  noteSnapshot(wc, url)
  noteRendererRestart(wc)
  failure = checkRefContext(wc)
  assert.equal(failure?.code, 'RENDERER_CRASH')
  assert.match(failure.message, /渲染进程已重启/)
  assert.match(failure.message, /browser_snapshot/)

  noteSnapshot(wc, url)
  assert.equal(checkRefContext(wc), null, '重启后重新快照必须恢复控制')
  await delay(20)
  failure = checkRefContext(wc, 10)
  assert.equal(failure?.code, 'STALE_REF')
  assert.match(failure.message, /过期/)
  assert.match(failure.message, /browser_snapshot/)

  console.log('PASS: ref epochs reject navigation, renderer restart, URL drift and expired snapshots with actionable messages')
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}
