import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const report = readFileSync(new URL('../docs/RESEARCH.md', import.meta.url), 'utf8')
const slugs = [...report.matchAll(/^\| \[([\w.-]+\/[\w.-]+)\]\(https:\/\/github\.com\/[^)]+\) \|/gm)].map((match) => match[1])
if (slugs.length === 0) throw new Error('No research repositories found')
const query = `query { ${slugs.map((slug, index) => {
  const [owner, name] = slug.split('/')
  return `r${index}: repository(owner: "${owner}", name: "${name}") {
    pushedAt isArchived stargazerCount forkCount latestRelease { tagName url publishedAt }
  }`
}).join('\n')} }`
const result = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', timeout: 90_000 }))
console.log(`# Aa Browser 同类项目月度快照 — ${new Date().toISOString().slice(0, 10)}\n`)
console.log('| 项目 | Star / Fork | 最近推送 UTC | 最新 GitHub Release | 状态 |')
console.log('| --- | ---: | --- | --- | --- |')
for (const [index, slug] of slugs.entries()) {
  const repo = result.data[`r${index}`]
  if (!repo) throw new Error(`No metadata for ${slug}. Review the reference in docs/RESEARCH.md.`)
  const release = repo.latestRelease
  const latest = release ? `[${release.tagName.replaceAll("|", "&#124;")}](${release.url}) ${release.publishedAt?.slice(0, 10) ?? ""}` : "无 GitHub Release"
  console.log(`| [${slug}](https://github.com/${slug}) | ${repo.stargazerCount} / ${repo.forkCount} | ${repo.pushedAt ?? '未知'} | ${latest} | ${repo.isArchived ? '已归档' : '可查询'} |`)
}
