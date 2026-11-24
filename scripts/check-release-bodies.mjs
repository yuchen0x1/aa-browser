#!/usr/bin/env node
/**
 * Check archived GitHub Release bodies against the local index and (optionally) GitHub.
 *
 * Local-only by default so it is safe to run in offline CI. With --remote, fetch the
 * public release list and compare every archived body byte-for-byte after normalizing
 * CRLF/LF and one or more trailing newlines. GH_TOKEN/GITHUB_TOKEN is used when set;
 * otherwise an existing `gh auth token` is used when available.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BODY_DIR = path.join(ROOT, 'docs', 'releases', 'bodies')
const INDEX_FILE = path.join(ROOT, 'docs', 'releases', 'release-notes.md')
const TEMPLATE_FILE = path.join(ROOT, 'docs', 'releases', 'release-notes-template.md')
const REPOSITORY = process.env.GITHUB_REPOSITORY || 'yuchen0x1/aa-browser'
const REMOTE = process.argv.includes('--remote')
const EXPECTED_TAGS = [
  'v0.0.1', 'v0.0.2', 'v0.0.3', 'v0.0.4', 'v0.0.5', 'v0.0.6',
  'v0.0.7', 'v0.0.8', 'v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.6.4', 'v0.6.5', 'v0.6.6', 'v0.6.7', 'v0.6.8', 'v0.6.10', 'v0.6.11', 'v0.6.12', 'v0.7.0', 'v0.8.0', 'v0.9.0', 'v0.9.1', 'v0.10.0', 'v0.11.0', 'v0.12.0', 'v0.12.1', 'v0.13.0', 'v0.14.0', 'v0.15.0', 'v0.16.0',
]

const errors = []
const fail = (message) => errors.push(message)
const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '')

for (const file of [INDEX_FILE, TEMPLATE_FILE]) {
  if (!fs.existsSync(file)) fail(`Missing required file: ${path.relative(ROOT, file)}`)
}

const index = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, 'utf8') : ''
const template = fs.existsSync(TEMPLATE_FILE) ? fs.readFileSync(TEMPLATE_FILE, 'utf8') : ''
if (!template.includes('## 二、Release Notes 正文')) {
  fail('Template is missing the Release Notes body section')
}
if (!template.includes('## 四、发布前核对')) {
  fail('Template is missing the pre-publication checklist')
}

const archivedTags = fs.existsSync(BODY_DIR)
  ? fs.readdirSync(BODY_DIR).filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name)).map((name) => name.slice(0, -3))
  : []
for (const tag of EXPECTED_TAGS) {
  if (!archivedTags.includes(tag)) fail(`Missing archived body: docs/releases/bodies/${tag}.md`)
  if (!index.includes(`./bodies/${tag}.md`)) fail(`Release index has no body link for ${tag}`)
}
for (const tag of archivedTags) {
  if (!EXPECTED_TAGS.includes(tag)) fail(`Unexpected archived release body: ${tag}`)
}

const bodies = new Map()
for (const tag of EXPECTED_TAGS) {
  const file = path.join(BODY_DIR, `${tag}.md`)
  if (!fs.existsSync(file)) continue
  const body = fs.readFileSync(file, 'utf8')
  bodies.set(tag, body)
  if (!body.startsWith('## 📢 版本概述')) fail(`${tag}: body must start with ## 📢 版本概述`)
  if (/^#\s/m.test(body)) fail(`${tag}: body must not contain a level-1 heading`)
  if (!body.includes(`https://github.com/${REPOSITORY}/releases/tag/${tag}`)) {
    fail(`${tag}: body footer does not point to its own Release page`)
  }
  if (body.includes(`[项目名称]`) || body.includes('[版本号]') || body.includes('[GitHub 仓库地址]')) {
    fail(`${tag}: body still contains template placeholders`)
  }
}

if (REMOTE) {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      // Public API fallback below; credentials are optional.
    }
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aa-browser-release-body-check',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(response.ok, `GitHub API returned HTTP ${response.status}; use GH_TOKEN to avoid rate limits`)
  const releases = await response.json()
  const byTag = new Map(releases.map((release) => [release.tag_name, release]))
  for (const tag of EXPECTED_TAGS) {
    const release = byTag.get(tag)
    if (!release) {
      fail(`${tag}: no published GitHub Release found`)
      continue
    }
    const body = bodies.get(tag)
    if (body && normalize(body) !== normalize(release.body || '')) {
      fail(`${tag}: archived body differs from GitHub Release body`)
      continue
    }
    if (body) {
      const missingAssets = release.assets.map((asset) => asset.name).filter((name) => !body.includes(name))
      if (missingAssets.length) fail(`${tag}: body omits uploaded assets: ${missingAssets.join(', ')}`)
      console.log(`PASS remote ${tag} (${release.assets.length} assets)`)
    }
  }
}

if (errors.length) {
  console.error(`❌ Release body check failed (${errors.length}):`)
  for (const error of errors) console.error(`   - ${error}`)
  process.exit(1)
}

console.log(
  `✅ Release body archive consistent (${EXPECTED_TAGS.length} versions, template and index)` +
    (REMOTE ? ' and matches GitHub' : ''),
)
