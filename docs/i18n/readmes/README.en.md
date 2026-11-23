# Aa Browser

**The agent-native desktop browser — open source, MIT licensed.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <b>English</b> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> A browser you use like a human, driven by an agent like an engineer.

<p align="center">
  <img src="../../../docs/media/aa-browser-demo.webp" alt="Aa Browser — a browser built for agents" width="720" />
</p>

This is a **condensed translation**. The complete, authoritative documentation is written in Chinese: [README.md](../../../README.md) and [`docs/`](../../).

## What it is

Conventional browsers are designed for human eyes looking at pixels; an AI agent needs **structured page data**. Aa Browser is a complete Chromium desktop browser (Electron) that anyone can use normally — tabs, omnibox, history, downloads, page find, persistent logins — and it exposes the page to any [MCP](https://modelcontextprotocol.io) agent through a local stdio bridge: read a **structured accessibility snapshot**, then click, type, select, drag, scroll, extract and capture traffic. No screenshots, no guessed coordinates.

Snapshots are **incremental** by default: an unchanged page costs one line, small changes return only the diff, and `ref` ids stay stable across snapshots. The bridge listens on `127.0.0.1` with a per-launch token stored in `~/.aabrowser/connection.json`.

## Highlights

- 🖥️ **A real browser**: Electron/Chromium shell with tabs, omnibox, back/forward, page find, download panel and persistent logins.
- 🧠 **Structured snapshots**: the page becomes a YAML-style accessibility tree where every interactive element carries a `ref` id (`- button "Sign in" [ref=e5]`), aligned with the Playwright MCP format.
- 💸 **Incremental snapshots save tokens**: no change → one line; small change → only the changed blocks; navigation or large changes fall back to a full snapshot. Long tasks typically save 60%+ of context.
- 🎯 **Real input path**: clicks use trusted input events (`isTrusted=true`), typing uses the `insertText` pipeline with a fallback for React-controlled inputs, and synthetic events cover the rare case where a real event is dropped.
- 🤖 **MCP native**: a standard stdio MCP bridge; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code and WorkBuddy can drive it.
- 📊 **Diagnostics**: `browser_performance` returns navigation timings, first paint, resource sizes and slow resources, JS heap and DOM size without opening DevTools.
- 🌐 **Bilingual UI**: follows the system or browser language, or pin Simplified Chinese / English in settings.
- 🔒 **Local-first security**: loopback-only WebSocket, random per-launch token, site allowlist, isolated tabs, redacted network data and in-browser approval for high-risk operations.
- 📦 **Verifiable releases**: Windows NSIS and Linux AppImage ship in the same version with `SHA256SUMS.txt`, GitHub immutable release attestations and a CycloneDX `sbom.cdx.json`.

## Snapshot example

Calling `browser_snapshot` on the Bing homepage returns (real output, kept verbatim):

```text
页面快照 url: https://www.bing.com/
title: 搜索 - Microsoft 必应
元素数: 19

- banner "登录 Rewards 手机版"
  - img "必应"
  - navigation
    - menuitem "图片" [ref=e1]
    - menuitem "视频" [ref=e3]
- search
  - combobox "搜索网页" [ref=e15]
  - button "语音搜索" [ref=e16]
```

The agent then acts on a `ref`:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

After an action you get an **incremental snapshot** — only the changed blocks, plus which `ref` ids were added or invalidated. `browser_snapshot { full: true }` forces the full tree.

## Install

### One prompt (recommended)

Send the prompt in [PROMPT.md](../../../PROMPT.md) to any AI that can run local commands. If Aa Browser is not installed yet, it downloads the official installer, verifies the SHA-256, installs, launches, writes the MCP config and actually calls `browser_tabs` to verify. If Aa Browser is already running, it only writes the config and verifies.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

The installer never prompts interactively. `--clients zcode,cursor` limits which clients are configured, `--dir <dir>` overrides the install directory, `--no-launch` skips launching, and `--sha256 <hex>` pins the expected installer hash. Any other MCP client can use the output of `--print-config`.

### Windows

Download `aa-browser-setup-<version>.exe` from [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) and run it. The installer is **not code-signed**: when SmartScreen appears, choose "More info → Run anyway". Each release also ships `SHA256SUMS.txt`, `sbom.cdx.json` and an immutable release attestation so you can verify the files yourself.

### Linux AppImage

Download `aa-browser-<version>-linux-x86_64.AppImage`, make it executable and start it from the current desktop session. GTK 3, NSS, GBM, audio libraries and a working Chromium sandbox are required; MCP access needs system Node.js 22.12 or newer.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

Without FUSE, start it with `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. See the [platform guide](../../../docs/PLATFORMS.md) for distribution-specific status and recovery steps.

### From source

Node.js 22.12 or newer is required.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

Development mode with a hot-reloading renderer is `npm run dev`; it uses a separate `aa-browser-dev` user-data directory, so it can run alongside the installed build.

## Connect your agent

Prerequisites: Aa Browser is running (it writes the port and token to `~/.aabrowser/connection.json`), the client supports stdio MCP, and both run as the same user on the same machine.

- **One click**: Settings → Connect AI client → tick the clients → write. Restart the client afterwards.
- **Manual**: run `node install.mjs --print-config` and paste the printed `command` / `args` / `env` into the client config. Existing configs are backed up to `<file>.aa-backup-<timestamp>`; only the `aa-browser` entry is modified, and writes are idempotent.

### Status and verification

| Toolbar state | Meaning |
| --- | --- |
| Waiting for AI connection | No MCP bridge has connected: config missing, client not restarted, or browser not running |
| Waiting for first AI call | The bridge is connected and authenticated but no tool call has succeeded yet |
| AI connected ×N | At least one `browser_tabs` list call succeeded; N is the number of verified bridges |

A written config is **not** a working connection. Verify with `node install.mjs --verify-only`, or let the agent actually call `browser_tabs`.

## MCP tools

**44 tools** in five groups: navigation & snapshot (5), interaction (9), read & state (20), network & Mock (6), diagnostics & tabs (4). Client tool names may carry a `mcp__aa-browser__` prefix.

| Group | Tools |
| --- | --- |
| Navigation & snapshot | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| Interaction | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| Read & state | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| Network & Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| Diagnostics & tabs | `browser_performance`, `browser_resize`, `browser_tabs` |

Shared behaviour: most tools return a snapshot with their result (`snapshot: false` skips it), every tool except `browser_resize` and `browser_downloads` accepts a `tabId`, a single call times out after 180 seconds, approval waits up to 120 seconds, and network details are redacted by default.

## Security

- The agent service only listens on `127.0.0.1`, uses a random token per launch and rejects non-local origins; the port and token live in `~/.aabrowser/connection.json` and are deleted on a clean exit.
- Page views run without a preload script; snapshots and action scripts are injected by the main process. Navigation only allows `http:` / `https:` — `file:`, `data:`, `devtools:` and similar protocols are rejected.
- Sensitive input fields must be filled by the user: agent-supplied text is never written, read or returned. With "confirm high-risk operations" enabled, form submits, Enter-after-typing and unredacted network access wait for approval in the browser (120 seconds, then treated as denied).
- Network details and HAR exports redact authentication headers and credential-like parameters by default.
- **Site allowlist**: applies to navigation only; leaving it empty disables it, and even when it is empty, `file:`, `data:`, `devtools:` and other non-web protocols stay blocked.
- **Connecting an agent touches one entry**: existing client configs are backed up first, only the `aa-browser` entry is modified, no token or password is ever written, and installer downloads verify the release SHA-256 digest and file header.
- Isolated tabs use a separate session partition: no shared cookies or logins, cleared on close, and excluded from global history, the recently-closed list and session restore.
- **Boundary**: an agent can see page content and traffic, including cookies, storage, headers and response bodies. These controls are mitigations, not a general DLP — do not point an untrusted agent at high-sensitivity sites.

Report vulnerabilities through [SECURITY.md](../../../SECURITY.md) private reporting, never in a public issue.

## Platforms and limits

| Platform | Official build | Notes |
| --- | --- | --- |
| Windows 11 x64 | NSIS installer | Actively maintained, covered by CI and local regressions |
| Windows 10 x64 | Same installer | Shares the Windows 11 build; real-device upgrade acceptance still pending |
| Linux x86_64 (Ubuntu desktop) | AppImage | Needs system Node.js 22.12+; other distributions need real-device verification |
| Windows ARM64 / macOS / Android / iOS | None | The installer refuses explicitly instead of pretending to install |

Known limitations:

- **No code signing** on Windows: SmartScreen warns and needs "More info → Run anyway".
- **Not a Chrome replacement**: no bookmarks, extensions or account/multi-device sync. The scope is "browser core + agent access".
- **Linux MCP access requires system Node.js 22.12+**; on Windows the bundled runtime is used when no system Node is found.
- **Session restore is scoped**: normal web tabs only, at most 20 entries, never isolated tabs, internal pages or non-HTTP(S) URLs.
- **One instance per user-data directory**; the dev build uses its own directory so both can run.
- **Installs and updates depend on GitHub Releases**; AppImage self-update needs a writable directory.

## Docs

The detailed documentation is currently in Chinese:

| Document | Content |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | Platform and client matrix, installer flags, manual steps, troubleshooting |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | Release matrix, Linux dependencies, uninstall and data recovery |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | Update check, download, restart-to-install, SHA-512 and rollback |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | DeepSeek Harness plugin install and verification |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | Release evidence, regression records and maintenance boundaries |
| [release notes](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | Change history per version |

## Contributing and license

Bug reports, feature discussions, documentation fixes and PRs are welcome — please read [CONTRIBUTING.md](../../../CONTRIBUTING.md) first. When adding an MCP tool, update `src/main/tools.ts`, `cli/mcp.mjs`, the tool table in this README and `src/shared/tool-defs.mjs` together; `npm run check` verifies the first three stay in sync.

MIT licensed — see [LICENSE](../../../LICENSE) © Aa Browser contributors.

This translation may lag behind the Chinese original. Translations of this README are maintained in [README.md](../../../README.md) (简体中文), plus `docs/i18n/readmes/README.<language>.md`; see `../readme-languages.json` for the full list.
