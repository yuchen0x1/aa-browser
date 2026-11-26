#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DIR = '.local-verification'

function isInside(parent, target) {
  const relative = path.relative(parent, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) files.push(...markdownFiles(file))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file)
  }
  return files
}

function documentationContents(root) {
  return markdownFiles(path.join(root, 'docs')).map((file) => fs.readFileSync(file, 'utf8'))
}

function referencedFixtureDirectories(contents) {
  const keep = new Set(['old-v017'])
  const reference = /\.local-verification\/([^/\\\s`"'<>]+)/g
  for (const document of contents) {
    for (const match of document.matchAll(reference)) {
      const name = match[1].split(/[\\/]/, 1)[0]
      if (name) keep.add(name)
    }
  }
  return keep
}

function isSuccessfulLiveUpdateEvidence(directory) {
  const resultFile = path.join(directory, 'result.json')
  if (!fs.existsSync(resultFile)) return false
  try {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    return result.mode === 'live' && result.status === 'passed'
  } catch {
    return false
  }
}

function assertSafeDirectory(root, parent, target) {
  const rootPath = fs.realpathSync(root)
  const parentPath = fs.realpathSync(parent)
  const targetPath = path.resolve(target)
  if ((parentPath !== rootPath && !isInside(rootPath, parentPath)) || !isInside(parentPath, targetPath)) {
    throw new Error(`Refusing to remove a path outside the project cleanup roots: ${targetPath}`)
  }
  const stat = fs.lstatSync(targetPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory or linked path: ${targetPath}`)
  }
  const realTarget = fs.realpathSync(targetPath)
  if (!isInside(parentPath, realTarget)) {
    throw new Error(`Refusing to remove a directory that resolves outside its parent: ${targetPath}`)
  }
  return realTarget
}

export function planLocalArtifactCleanup(root = PROJECT_ROOT) {
  const rootPath = fs.realpathSync(root)
  const plan = []
  const output = path.join(rootPath, 'out')
  if (fs.existsSync(output)) {
    assertSafeDirectory(rootPath, rootPath, output)
    plan.push('out')
  }

  const fixtures = path.join(rootPath, FIXTURE_DIR)
  if (!fs.existsSync(fixtures)) return plan
  const fixtureStat = fs.lstatSync(fixtures)
  if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink()) {
    throw new Error(`Refusing to inspect a non-directory or linked verification path: ${fixtures}`)
  }
  const fixtureRoot = fs.realpathSync(fixtures)
  if (!isInside(rootPath, fixtureRoot)) {
    throw new Error(`Refusing to inspect a verification directory outside the project: ${fixtures}`)
  }
  const documents = documentationContents(rootPath)
  const keep = referencedFixtureDirectories(documents)
  for (const entry of fs.readdirSync(fixtureRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || keep.has(entry.name)) continue
    if (documents.some((document) => document.includes(entry.name))) continue
    const relative = path.join(FIXTURE_DIR, entry.name)
    const directory = path.join(fixtureRoot, entry.name)
    assertSafeDirectory(rootPath, fixtureRoot, directory)
    if (isSuccessfulLiveUpdateEvidence(directory)) continue
    plan.push(relative)
  }
  return plan.sort((left, right) => left.localeCompare(right))
}

export function cleanLocalArtifacts({ root = PROJECT_ROOT, apply = false } = {}) {
  const rootPath = fs.realpathSync(root)
  const plan = planLocalArtifactCleanup(rootPath)
  if (!apply) return { plan, removed: [] }

  const removed = []
  for (const relative of plan) {
    const target = path.resolve(rootPath, relative)
    const parent = path.dirname(target)
    const safeTarget = assertSafeDirectory(rootPath, parent, target)
    fs.rmSync(safeTarget, { recursive: true })
    removed.push(relative)
  }
  return { plan, removed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  if ([...args].some((arg) => arg !== '--apply')) {
    console.error('Usage: node scripts/clean-local-artifacts.mjs [--apply]')
    process.exit(2)
  }
  const apply = args.has('--apply')
  const result = cleanLocalArtifacts({ apply })
  if (!result.plan.length) console.log('No generated local artifacts to clean.')
  for (const item of result.plan) console.log(`${apply ? 'Removed' : 'Would remove'} ${item}`)
  if (!apply && result.plan.length) console.log('Preview only. Re-run with --apply to remove these generated directories.')
}
