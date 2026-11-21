#!/usr/bin/env node
/** Real production-code measurements; writes only a fresh ignored .local-verification directory. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(script), '..')
const require = createRequire(import.meta.url)
const buttonCounts = [100, 1000, 3000]
const pageSizes = [100, 200]
const snapshotRepeats = 3
const snapshotWarmups = 2
const historyWarmups = 5
const historyAdds = 100
const capacity = 1000
const byteLength = (value) => Buffer.byteLength(value, 'utf8')
const jsonBytes = (value) => byteLength(JSON.stringify(value))
const sum = (values) => values.reduce((total, value) => total + value, 0)

function stats(values) {
  assert.ok(values.length)
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
  return { n: values.length, total_ms: sum(values), min_ms: sorted[0], mean_ms: sum(values) / values.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: sorted.at(-1) }
}

function contained(directory, candidate) {
  const relative = path.relative(directory, path.resolve(candidate))
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Path escapes measurement directory: ${candidate}`)
  return path.resolve(candidate)
}

const sources = ['src/snapshot/engine.js', 'src/snapshot/scripts.ts', 'src/main/history.ts', 'src/main/atomic-json.ts']
function sourceHashes() {
  return Object.fromEntries(sources.map((name) => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]))
}

function compileProduction(runDir) {
  const compiled = path.join(runDir, 'compiled')
  const config = path.join(runDir, 'tsconfig.json')
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true,
      skipLibCheck: true, noEmitOnError: true, incremental: false, types: ['node'],
      typeRoots: [path.join(root, 'node_modules/@types')], rootDir: path.join(root, 'src'), outDir: compiled
    },
    files: ['src/main/history.ts', 'src/snapshot/scripts.ts'].map((name) => path.join(root, name))
  }, null, 2))
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '--project', config], { cwd: runDir, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, `Production module compilation failed: ${result.error?.message || ''}\n${result.stdout || ''}${result.stderr || ''}`)
  return compiled
}

function measureHistory(runDir, compiled) {
  const historyDir = path.join(runDir, 'history')
  fs.mkdirSync(historyDir)
  const file = path.join(historyDir, 'history.json')
  const entry = (i) => ({ url: `https://history-bench.invalid/item/${String(i).padStart(4, '0')}`, title: `History item ${String(i).padStart(4, '0')}`, ts: Date.now(), count: 1 })
  fs.writeFileSync(file, JSON.stringify(Array.from({ length: capacity }, (_, i) => entry(i)), null, 2))
  const seededBytes = fs.statSync(file).size
  const previousHistoryDir = process.env.AA_BROWSER_HISTORY_DIR
  process.env.AA_BROWSER_HISTORY_DIR = historyDir
  let phase = 'load'
  const phases = {}
  const counters = () => phases[phase] ||= { attempts: {}, successes: {}, written_bytes: 0, atomic_commits: 0, fsync_ms: [] }
  const descriptors = new Set()
  const pathArg = (value) => contained(historyDir, value)
  const descriptorArg = (value) => assert.ok(descriptors.has(value), `Unexpected production descriptor: ${value}`)
  const calls = {
    readFileSync: ([name]) => pathArg(name), mkdirSync: ([name]) => pathArg(name),
    existsSync: ([name]) => pathArg(name), unlinkSync: ([name]) => pathArg(name),
    openSync: ([name, flags]) => { pathArg(name); assert.equal(flags, 'wx') },
    writeFileSync: ([fd]) => descriptorArg(fd), fsyncSync: ([fd]) => descriptorArg(fd),
    closeSync: ([fd]) => descriptorArg(fd),
    renameSync: ([from, to]) => { pathArg(from); assert.equal(pathArg(to), file) },
    copyFileSync: ([from, to]) => { pathArg(from); pathArg(to) }
  }
  const measuredFs = new Proxy({}, { get(_target, method) {
    if (method === '__esModule') return undefined
    if (method === 'constants') return fs.constants
    if (!(method in calls)) throw new Error(`Unexpected production fs API: ${String(method)}`)
    return (...args) => {
      calls[method](args)
      const c = counters()
      c.attempts[method] = (c.attempts[method] || 0) + 1
      const start = method === 'fsyncSync' ? performance.now() : 0
      let value
      try { value = fs[method](...args) }
      finally { if (method === 'fsyncSync') c.fsync_ms.push(performance.now() - start) }
      c.successes[method] = (c.successes[method] || 0) + 1
      if (method === 'openSync') descriptors.add(value)
      if (method === 'closeSync') descriptors.delete(args[0])
      if (method === 'writeFileSync') c.written_bytes += typeof args[1] === 'string' ? byteLength(args[1]) : args[1].byteLength
      if (method === 'renameSync') c.atomic_commits++
      return value
    }
  } })
  const originalLoad = Module._load
  const historyModule = path.join(compiled, 'main/history.js')
  const atomicModule = path.join(compiled, 'main/atomic-json.js')
  let HistoryStore
  try {
    Module._load = function (name, parent, ...rest) {
      if ([historyModule, atomicModule].includes(parent?.filename)) {
        if (name === 'node:fs') return measuredFs
        if (name === 'node:os') return { homedir() { throw new Error('Real user profile access is forbidden') } }
      }
      return originalLoad.call(this, name, parent, ...rest)
    }
    ;({ HistoryStore } = require(historyModule))
  } finally { Module._load = originalLoad }
  try {
    const store = new HistoryStore()
    assert.equal(store.dir, historyDir)
    assert.equal(store.list(capacity).length, capacity)
    phase = 'warmup'
    for (let i = 0; i < historyWarmups; i++) {
      const e = entry(capacity + i)
      store.add(e.url, e.title)
    }
    assert.equal(counters().atomic_commits, historyWarmups)
    phase = 'measured'
    const samples = []
    const loopStart = performance.now()
    for (let i = 0; i < historyAdds; i++) {
      const e = entry(capacity + historyWarmups + i)
      const start = performance.now()
      store.add(e.url, e.title)
      samples.push(performance.now() - start)
    }
    const loopMs = performance.now() - loopStart
    const measured = counters()
    assert.equal(measured.atomic_commits, historyAdds)
    for (const method of ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']) assert.equal(measured.successes[method], historyAdds, method)
    assert.equal(descriptors.size, 0)
    phase = 'verification'
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(onDisk.length, capacity)
    assert.equal(onDisk[0].url, entry(historyWarmups + historyAdds).url)
    for (let i = 0; i < historyAdds; i++) assert.ok(onDisk.some((e) => e.url === entry(capacity + historyWarmups + i).url))
    assert.deepEqual(new HistoryStore().list(capacity), store.list(capacity))
    assert.deepEqual(fs.readdirSync(historyDir), ['history.json'])
    return {
      status: 'PASS', runtime: process.version, capacity, warmup_adds: historyWarmups, measured_adds: historyAdds,
      workload: 'Seed 1000 valid entries; 5 warmup + 100 distinct new URLs, keeping 1000 entries by eviction; initial load excluded.',
      instrumentation: 'Compiled production HistoryStore and atomic-json use an injected node:fs proxy delegating every operation to real synchronous disk I/O. Counts and clocks add measurement overhead.',
      add_sync_ms: stats(samples), measured_loop_wall_ms: loopMs, fsync_sync_ms: stats(measured.fsync_ms),
      atomic_writes: measured.atomic_commits, fs_attempts: measured.attempts, fs_successes: measured.successes,
      written_bytes: measured.written_bytes, seeded_file_bytes: seededBytes, final_file_bytes: fs.statSync(file).size,
      persisted_entries: onDisk.length, all_measured_entries_persisted: true, reload_roundtrip: true, leftover_temp_files: 0,
      warmup_atomic_writes: phases.warmup.atomic_commits, raw_add_ms: samples, raw_fsync_ms: measured.fsync_ms,
      history_file: file, caveat: 'Windows-machine local-disk observations only; not portable to other disks, operating systems, loads, antivirus policies, cold caches, or user history sizes. No performance optimization was applied.'
    }
  } finally {
    if (previousHistoryDir === undefined) delete process.env.AA_BROWSER_HISTORY_DIR
    else process.env.AA_BROWSER_HISTORY_DIR = previousHistoryDir
  }
}

function fixtureHtml(count) {
  const buttons = Array.from({ length: count }, (_, i) => `<div class="cell"><button id="button-${String(i + 1).padStart(4, '0')}" type="button">Action ${String(i + 1).padStart(4, '0')}</button></div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Snapshot measurement ${count}</title><style>body{margin:8px;font:14px Arial}#controls{display:grid;grid-template-columns:repeat(10,120px);gap:4px}.cell,button{width:120px;height:28px}button{font:14px Arial}</style></head><body><div id="controls">${buttons}</div><script>window.__measurementClicks=[];document.getElementById('controls').addEventListener('click',event=>{if(event.target.tagName==='BUTTON')window.__measurementClicks.push(event.target.id)})</script></body></html>`
}

async function measureSnapshots(runDir) {
  const { app, BrowserWindow } = require('electron')
  const directories = { appData: 'app-data', userData: 'profile', sessionData: 'session', temp: 'tmp', crashDumps: 'crash-dumps' }
  for (const [name, relative] of Object.entries(directories)) {
    const directory = path.join(runDir, relative)
    fs.mkdirSync(directory, { recursive: true })
    app.setPath(name, directory)
  }
  app.setAppLogsPath(path.join(runDir, 'logs'))
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  await app.whenReady()
  let win
  const results = []
  const output = path.join(runDir, 'snapshot-result.json')
  try {
    const source = fs.readFileSync(path.join(root, 'src/snapshot/engine.js'), 'utf8')
    const { __aaSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    const { tagNameScript, clickScript, jsLiteral } = require(path.join(runDir, 'compiled/snapshot/scripts.js'))
    const engine = __aaSnapshot.toString()
    win = new BrowserWindow({
      width: 1280, height: 800, useContentSize: true, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: `maintenance-${path.basename(runDir)}` }
    })
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') }))
    const wc = win.webContents
    const execute = (code) => wc.executeJavaScript(code, true)
    const capture = async (opts) => {
      const start = performance.now()
      const result = await execute(`(() => { const start=performance.now(); const snapshot=(${engine})(${jsLiteral(opts)}); return {snapshot,renderer_ms:performance.now()-start} })()`)
      return { ...result, roundtrip_ms: performance.now() - start }
    }
    for (const count of buttonCounts) {
      const html = path.join(runDir, `buttons-${count}.html`)
      fs.writeFileSync(html, fixtureHtml(count))
      for (const maxNodes of pageSizes) {
        await win.loadFile(html)
        const dom = await execute(`(() => {document.body.getBoundingClientRect();return {buttons:document.querySelectorAll('button').length,dom_elements:document.querySelectorAll('*').length,width:innerWidth,height:innerHeight,user_agent:navigator.userAgent}})()`)
        assert.equal(dom.buttons, count)
        for (let i = 0; i < snapshotWarmups; i++) await capture({ maxNodes, cursor: 0, mode: i === 0 ? 'full' : 'auto' })
        const passes = []
        for (let repeat = 0; repeat < snapshotRepeats; repeat++) {
          await execute('delete window.__aaRefs; delete window.__aaSnapState; delete window.__maintenanceRefSignature')
          const pages = []
          let cursor = 0
          const seen = new Set()
          const treeRefs = new Set()
          const passStart = performance.now()
          do {
            assert.ok(!seen.has(cursor), 'Pagination cursor loop')
            seen.add(cursor)
            const { snapshot, renderer_ms, roundtrip_ms } = await capture({ maxNodes, cursor, mode: 'auto' })
            assert.equal(snapshot.mode, 'page', snapshot.error)
            assert.equal(snapshot.truncated, false)
            assert.equal(snapshot.elements.length, count)
            assert.equal(snapshot.totalLines, 2 * count)
            assert.equal(snapshot.cursor, cursor)
            for (const match of snapshot.tree.matchAll(/\[ref=(e\d+)\]/g)) treeRefs.add(match[1])
            const refs = await execute(`(() => {
              const refs=window.__aaRefs, elements=window.__aaSnapState.elements;
              const entries=Object.entries(refs), buttons=Array.from(document.querySelectorAll('button'));
              const nodes=new Set(entries.map(([,el])=>el));
              const signature=entries.map(([ref,el])=>ref+':'+el.id).join('|');
              if(window.__maintenanceRefSignature===undefined)window.__maintenanceRefSignature=signature;
              return {count:entries.length,connected:entries.every(([,el])=>el.isConnected),all_buttons:buttons.every(el=>nodes.has(el)),all_elements:elements.every(info=>refs[info.ref]&&refs[info.ref].id==='button-'+info.name.split(' ')[1]),stable:signature===window.__maintenanceRefSignature,last_ref:entries.at(-1)[0]};
            })()`)
            assert.equal(refs.count, count)
            for (const key of ['connected', 'all_buttons', 'all_elements', 'stable']) assert.equal(refs[key], true, key)
            if (pages.length === 0) assert.equal(await execute(tagNameScript(refs.last_ref)), 'button', 'Last ref must resolve before its tree page is visited')
            pages.push({ cursor, next_cursor: snapshot.nextCursor, has_more: snapshot.hasMore, tree_bytes: byteLength(snapshot.tree), elements_json_bytes: jsonBytes(snapshot.elements), return_json_bytes: jsonBytes(snapshot), elements: snapshot.elements.length, renderer_ms, roundtrip_ms, refs })
            if (!snapshot.hasMore) { assert.equal(snapshot.nextCursor, null); break }
            assert.ok(snapshot.nextCursor > cursor)
            cursor = snapshot.nextCursor
          } while (pages.length < 1000)
          assert.equal(pages.at(-1).has_more, false)
          assert.equal(treeRefs.size, count, 'Complete pagination must expose every ref in tree output')
          passes.push({ repeat, page_count: pages.length, wall_including_verification_ms: performance.now() - passStart, capture_roundtrip_total_ms: sum(pages.map((p) => p.roundtrip_ms)), renderer_total_ms: sum(pages.map((p) => p.renderer_ms)), tree_bytes: sum(pages.map((p) => p.tree_bytes)), elements_json_bytes: sum(pages.map((p) => p.elements_json_bytes)), return_json_bytes: sum(pages.map((p) => p.return_json_bytes)), tree_refs_seen: treeRefs.size, pages })
        }
        assert.equal(await execute(clickScript(`e${count}`)), true)
        assert.deepEqual(await execute('window.__measurementClicks'), [`button-${String(count).padStart(4, '0')}`])
        for (const pass of passes) {
          for (const name of ['page_count', 'tree_bytes', 'elements_json_bytes', 'return_json_bytes']) assert.equal(pass[name], passes[0][name], `Repeated payload differs: ${name}`)
        }
        const first = passes[0].pages[0]
        const row = {
          buttons: count, max_nodes: maxNodes, dom, page_count: passes[0].page_count, total_lines: 2 * count,
          first_page: { tree_bytes: first.tree_bytes, elements_json_bytes: first.elements_json_bytes, return_json_bytes: first.return_json_bytes, elements: first.elements, roundtrip_ms: stats(passes.map((p) => p.pages[0].roundtrip_ms)), renderer_ms: stats(passes.map((p) => p.pages[0].renderer_ms)) },
          all_pages: { tree_bytes: passes[0].tree_bytes, elements_json_bytes: passes[0].elements_json_bytes, return_json_bytes: passes[0].return_json_bytes, roundtrip_total_ms: stats(passes.map((p) => p.capture_roundtrip_total_ms)), renderer_total_ms: stats(passes.map((p) => p.renderer_total_ms)) },
          page_roundtrip_ms: stats(passes.flatMap((p) => p.pages.map((page) => page.roundtrip_ms))),
          page_renderer_ms: stats(passes.flatMap((p) => p.pages.map((page) => page.renderer_ms))),
          full_refs_resolve_on_every_page: true, stable_refs_within_each_pass: true, last_ref_resolves_from_first_page: true, last_ref_production_click: true, passes
        }
        results.push(row)
        fs.writeFileSync(output, JSON.stringify({ status: 'IN_PROGRESS', cases: results }, null, 2))
        console.log(`snapshot buttons=${count} maxNodes=${maxNodes} pages=${row.page_count} first_bytes=${first.tree_bytes}/${first.elements_json_bytes}/${first.return_json_bytes} all_return_bytes=${row.all_pages.return_json_bytes} capture_total_p50_ms=${row.all_pages.roundtrip_total_ms.p50_ms.toFixed(3)} refs=PASS`)
      }
    }
    const result = {
      status: 'PASS', runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
      engine_sha256: createHash('sha256').update(source).digest('hex'), warmup_snapshots_per_case: snapshotWarmups, repeats_per_case: snapshotRepeats,
      fixture: 'Real sandboxed Electron renderer; hidden 1280x800 viewport, local file DOM; 10-column grid of visible-size native buttons with nested divs and click handler. Off-viewport buttons are retained. Each button emits one interactive line plus its text line.',
      definitions: { tree_bytes: 'UTF-8 bytes of returned tree string, including production headers and local file URL.', elements_json_bytes: 'UTF-8 bytes of JSON.stringify(snapshot.elements).', return_json_bytes: 'UTF-8 bytes of JSON.stringify(the complete engine return); not an MCP/WebSocket envelope, compressed size, or heap size.', roundtrip_ms: 'Main-process performance.now around executeJavaScript: engine source evaluation + traversal + Electron return/IPC; excludes payload byte counting and separate ref verification.', renderer_ms: 'Renderer performance.now directly around production engine invocation; excludes IPC.', all_pages: 'Measured cursor traversal until hasMore=false; byte totals sum every page, including repeated full elements arrays.', percentiles: 'Nearest-rank percentiles; 3 complete passes/case, first-page n=3 only (not a robust tail estimate).' },
      isolated_paths: Object.fromEntries(Object.keys(directories).map((name) => [name, app.getPath(name)])), cases: results,
      caveat: 'Single Windows machine, local deterministic DOM, warm runtime, no external pages/network or production-app startup. No performance optimization was applied.'
    }
    fs.writeFileSync(output, JSON.stringify(result, null, 2))
    win.destroy()
    app.exit(0)
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ status: 'FAIL', error: error.stack || String(error), cases: results }, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    console.error(error)
    app.exit(1)
  }
}

async function launchElectron(runDir) {
  const env = { ...process.env, AA_MAINTENANCE_RUN_DIR: runDir, AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history') }
  const paths = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'app-data', LOCALAPPDATA: 'local-app-data', TEMP: 'tmp', TMP: 'tmp', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache' }
  for (const [name, relative] of Object.entries(paths)) {
    env[name] = path.join(runDir, relative)
    fs.mkdirSync(env[name], { recursive: true })
  }
  delete env.ELECTRON_RUN_AS_NODE
  const profile = path.join(runDir, 'profile')
  const args = [`--user-data-dir=${profile}`, `--disk-cache-dir=${path.join(runDir, 'cache')}`, '--no-first-run', script]
  await new Promise((resolve, reject) => {
    const log = fs.createWriteStream(path.join(runDir, 'electron.log'))
    const child = spawn(require('electron'), args, { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 240_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { log.write(data); process.stdout.write(data) })
    child.once('error', (error) => { clearTimeout(timer); log.end(); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); log.end(); code === 0 && !timedOut ? resolve() : reject(new Error(`Electron measurement ${timedOut ? 'timed out' : `exited ${code}`}`)) })
  })
}

async function main() {
  const verification = path.join(root, '.local-verification')
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '.local-verification/maintenance-costs-probe'], { encoding: 'utf8' })
  assert.equal(ignored.status, 0, '.local-verification must already be ignored; do not modify .gitignore')
  fs.mkdirSync(verification, { recursive: true })
  contained(fs.realpathSync(root), fs.realpathSync(verification))
  const runDir = fs.mkdtempSync(path.join(verification, 'maintenance-costs-'))
  console.log(`Measurement directory: ${runDir}`)
  const before = sourceHashes()
  const result = {
    status: 'IN_PROGRESS', started_at: new Date().toISOString(), run_directory: runDir,
    environment: { platform: process.platform, release: os.release(), architecture: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, memory_bytes: os.totalmem(), disk_root: path.parse(runDir).root },
    source_sha256: before,
    scope: 'Only this script and a new ignored .local-verification subdirectory; no production edits, optimization, profile access, commits, or publication.'
  }
  const output = path.join(runDir, 'result.json')
  try {
    const compiled = compileProduction(runDir)
    result.history = measureHistory(runDir, compiled)
    fs.writeFileSync(output, JSON.stringify(result, null, 2))
    console.log(`history adds=${historyAdds} atomic_writes=${result.history.atomic_writes} total_ms=${result.history.add_sync_ms.total_ms.toFixed(3)} p50_ms=${result.history.add_sync_ms.p50_ms.toFixed(3)} p95_ms=${result.history.add_sync_ms.p95_ms.toFixed(3)} max_ms=${result.history.add_sync_ms.max_ms.toFixed(3)} file_bytes=${result.history.final_file_bytes}`)
    await launchElectron(runDir)
    result.snapshot = JSON.parse(fs.readFileSync(path.join(runDir, 'snapshot-result.json'), 'utf8'))
    assert.equal(result.snapshot.status, 'PASS')
    assert.deepEqual(sourceHashes(), before, 'Measured production sources changed during the run')
    result.production_sources_unchanged = true
    result.status = 'PASS'
  } catch (error) {
    result.status = 'FAIL'
    result.error = error.stack || String(error)
    process.exitCode = 1
  } finally {
    result.finished_at = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${output}`)
    if (result.error) console.error(result.error)
  }
}

if (process.versions.electron) {
  const runDir = process.env.AA_MAINTENANCE_RUN_DIR
  assert.ok(runDir, 'Electron fixture must be launched by the isolated Node parent')
  contained(path.join(root, '.local-verification'), runDir)
  void measureSnapshots(runDir).catch((error) => { console.error(error); require('electron').app.exit(1) })
} else {
  await main()
}
