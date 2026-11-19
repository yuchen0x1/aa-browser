# Aa Browser

**为 AI Agent 而生的开源桌面浏览器。**

![License](https://img.shields.io/badge/license-MIT-blue) ![CI](https://github.com/yuchen0x1/aa-browser/actions/workflows/ci.yml/badge.svg) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple) [![M8ven Score](https://m8ven.ai/badge/mcp/yuchen0x1-aa-browser-135ffo?v=5eaaa577bc85b8b59b5e327efd51d38c)](https://m8ven.ai/mcp/yuchen0x1-aa-browser-135ffo?s=readme)

> 人像人一样浏览网页，Agent 像工程师一样驱动它。
> **The Agent-Native Browser** — snapshots, actions, and packet capture over MCP.

<p align="center">
  <b>简体中文</b> ·
  <a href="./README.en.md">English</a> ·
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

> 其他语言版本是精简导读，安装、接入、安全与工具的权威细节以本文件为准。语言清单见 [`docs/i18n/readme-languages.json`](./docs/i18n/readme-languages.json)。

<p align="center">
  <img src="./site/assets/og-image.png" alt="Aa Browser —— 为 Agent 而生的浏览器" width="720" />
</p>

## 最新更新

<!-- github-release:start -->

**[v0.3.0](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.3.0)** · 2026-11-19

本版改善日常使用的观感与安全边界：设置面板从窄单列改成 960px 宽的分区布局，控件、排版和窗口自适应一并调整；应用图标重做为透明满幅，桌面快捷方式、任务栏和 favicon 不再出现白边；Agent 注入脚本的数据字面量统一加固，特殊字符不会再截断脚本。功能面与 MCP 工具集（34 个）保持不变。

[全部发行记录](https://github.com/yuchen0x1/aa-browser/releases)

<!-- github-release:end -->

从旧版本升级：打开「设置 → 软件更新」检查、下载并重启安装；升级后新功能才会生效。完整版本历史见[发布说明](./docs/releases/release-notes.md)与 [CHANGELOG](./CHANGELOG.md)。

传统浏览器是为「人眼看像素」设计的；AI Agent 需要的是**结构化页面数据**。Aa Browser 是一个完整的 Chromium 桌面浏览器，任何人都可以正常使用它上网；同时它通过本地 MCP 桥把页面能力开放给任何支持 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）的 Agent：读取**结构化快照**（可访问性树 + 元素 ref 编号），并执行点击、输入、选择、滚动、提取、抓包等操作——不看截图、不猜坐标。

它适合把**真实登录态**交给 Agent 的场景：后台运营、数据采集、回归验证、抓包排障，以及把重复的网页操作交给模型。浏览器本体照常使用，Agent 只是多出来的一个「遥控器」。

一句话概括：**34 个 MCP 工具、增量快照、真实输入、本地 token 鉴权，而浏览器本体也照常上网。**

## 目录

- [特性](#特性)
- [演示](#演示)
- [快照示例](#快照示例)
- [架构](#架构)
- [快速开始](#快速开始)
  - [一键接入（推荐）](#一键接入推荐)
  - [Windows 安装包](#windows-安装包)
  - [Linux AppImage](#linux-appimage)
  - [源码运行](#源码运行)
  - [自动更新](#自动更新)
- [接入你的 Agent](#接入你的-agent)
  - [客户端配置位置](#客户端配置位置)
  - [连接状态与验证](#连接状态与验证)
- [MCP 工具](#mcp-工具)
- [界面与快捷键](#界面与快捷键)
- [安全说明](#安全说明)
- [本地数据与卸载](#本地数据与卸载)
- [平台支持](#平台支持)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [宣传站](#宣传站)
- [文档](#文档)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [许可](#许可)
- [致谢](#致谢)

## 特性

- 🖥️ **真浏览器**：基于 Electron（Chromium），标签页 / 地址栏 / 前进后退 / 页面查找 / 下载面板 / 登录态持久化，一应俱全
- 🧠 **结构化快照**：页面被转换成 YAML 风格的可访问性树，每个可交互元素带 `ref` 编号（`- button "登录" [ref=e5]`），格式对齐 Playwright MCP 生态，Agent 零学习成本
- 💸 **增量快照省 token**：页面没变 → 一行回复；小变化 → 只返回变更区块；ref 跨快照稳定复用（React 重渲染也能靠内容签名接上）；跳转 / 大变化自动回退完整快照。长任务通常能省 60%+ 上下文
- 🤖 **MCP 原生接入**：标准 stdio MCP 桥，Codex / ZCode / Claude Code / Cursor 等 MCP 客户端均可驱动
- 🎯 **真实输入路径**：点击走受信任的输入事件（`isTrusted=true`），输入走 `insertText` 管线并对 React 受控组件兜底；真实事件偶发丢失时自动补发合成事件，不会「调用成功但页面没动」
- 🔁 **动作后自动快照**：每次点击 / 输入 / 滚动后自动返回新快照，Agent 无需二次请求即可继续决策
- 📊 **性能诊断**：`browser_performance` 一次返回导航耗时、首绘、资源体积与慢资源、JS 堆和 DOM 规模，Agent 不开 DevTools 也能解释慢页面
- 🌐 **中英双语界面**：跟随系统 / 浏览器语言，也可在设置里固定简体中文或 English
- 🧭 **地址栏历史补全**：本地记录最近 1000 条访问，按域名 / URL 前缀 / 标题补全并加权排序；隔离标签不写入
- 🗂️ **标签与会话恢复**：`Ctrl+Shift+T` 恢复本次运行中最近关闭的标签（最多 20 个）；重启后按上次顺序恢复普通网页标签与活动标签，隔离标签、内部页和非 HTTP(S) 地址不恢复，地址中的账号密码会被剥离
- 🛡️ **Agent 可观测、可中断**：工具栏实时显示连接状态，活动日志保留最近 30 条 Agent 操作；敏感输入由用户亲自填写，高危操作走浏览器内审批，可随时中断后续操作并恢复
- 🔒 **本地安全**：WebSocket 仅监听 `127.0.0.1`，每次启动随机 token，拒绝非本机来源；另有站点白名单、隔离会话与网络数据脱敏
- 🔌 **一段接入**：把新标签页或 [PROMPT.md](./PROMPT.md) 里的通用提示词发给任意具备本机执行能力的 AI，自动完成下载、安装、MCP 配置和 `browser_tabs` 验证；配置指向稳定桥路径，随应用升级
- 📦 **可验证发行**：Windows NSIS 与 Linux AppImage 同版本发布，附 `SHA256SUMS.txt`、GitHub 不可变发行证明和 CycloneDX `sbom.cdx.json`

## 演示

<p align="center">
  <a href="./docs/media/aa-browser-demo.mp4">
    <img src="./docs/media/aa-browser-demo.webp" alt="Aa Browser 演示录屏（15 秒）" width="720" />
  </a>
</p>

15 秒录屏。点击画面或[观看原片（MP4，1280×720，约 1.9 MB）](./docs/media/aa-browser-demo.mp4)；GitHub 的 README 不支持内嵌视频播放，这里用一份等长动图预览代替。

## 快照示例

在必应首页调用 `browser_snapshot` 得到：

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

Agent 随后：

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

点击 / 输入后自动返回的是**增量快照**——只有变化的区块：

```text
页面快照（增量） url: https://www.bing.com/search?q=Aa+Browser
title: Aa Browser - 搜索
变化: +6 / -1（共 214 行，其余未变，仍以上次快照为准）

  - search
+ - link "agent-browser.dev" [ref=e37]
+ - text "Browser automation for AI agents …"
- - text "（旧的空白提示）"

新增 ref: e37 e38
失效 ref: e12
```

页面未变化时只回一行（≈50 token）；跳转到新页面或变化过大时自动回退完整快照。`browser_snapshot { full: true }` 可强制完整树。完整的工具清单见下文 [MCP 工具](#mcp-工具)。

## 架构

```text
┌─────────────────────────────────────────────────────┐
│                Aa Browser (Electron)                │
│  ┌───────────────────────────────────────────────┐  │
│  │  外壳 UI（标签栏 / 地址栏 / 设置）←→ 主进程 IPC │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  页面标签 WebContentsView × N                 │  │
│  │    └─ 注入快照引擎（DOM → YAML 树 + ref 表）  │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Agent 服务 ws://127.0.0.1:<随机端口>         │  │
│  │    ~/.aabrowser/connection.json（端口 + token）│  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────┘
                           │ 本地 WebSocket（token 鉴权）
┌──────────────────────────┴──────────────────────────┐
│  cli/mcp.mjs → out/bridge/mcp.cjs（stdio MCP 桥）   │
│    MCP 客户端：Codex / ZCode / Cursor / Claude Code │
└─────────────────────────────────────────────────────┘
```

端口与 token 由应用在启动时生成并写入 `~/.aabrowser/connection.json`（正常退出时删除）；MCP 桥通过它发现浏览器，所以升级应用一般不需要重写客户端配置。页面视图不挂 preload，快照与动作脚本由主进程注入。发布版使用 `out/bridge/mcp.cjs`——由 `cli/mcp.mjs` 构建出的单文件零依赖产物，安装后无需 `node_modules`。

## 快速开始

| 你的情况 | 建议路径 |
| --- | --- |
| 想最快接上 AI，且有一个能执行本机命令的 AI | [一键接入（推荐）](#一键接入推荐) |
| 想自己手动安装 | [Windows 安装包](#windows-安装包) / [Linux AppImage](#linux-appimage) |
| 想改代码或自行构建 | [源码运行](#源码运行) |

### 一键接入（推荐）

把 [PROMPT.md](./PROMPT.md) 中的提示词整段发给任意具备本机命令执行能力的 AI（WorkBuddy、ZCode、Codex/ChatGPT 桌面端、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、DeepSeek Harness 等）。

- **还没安装 Aa Browser**：AI 会下载官方安装器，自动选择平台、校验 SHA-256、安装并启动，再写入 MCP 配置。
- **已经下载并打开了 Aa Browser**：点新标签页的「复制接入提示词」，AI 会跳过安装，只写配置并实际调用 `browser_tabs` 列表验证。
- **网页版 ChatGPT 等没有本机执行能力的环境**：提示词要求 AI 明确说明无法自动安装并给出手动步骤，不会假装成功。

安装器写入前会备份客户端配置，只修改 `aa-browser` 一个条目；配置指向稳定桥路径，应用升级后一般无需重写。完整平台 / 客户端矩阵、参数和排查见[通用安装与接入](./docs/CONNECT.md)。

手动等效命令（AI 不可用时）：

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # 下载、校验、安装、接入并验证
node install.mjs --connect-only --verify --json                 # 已安装，只接入并验证
node install.mjs --verify-only                                  # 只验证浏览器侧连接，不写配置
node install.mjs --print-config                                 # 输出通用 MCP 配置片段（stdout 是纯 JSON）
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--repo yuchen0x1/aa-browser` | 从官方 GitHub Releases 安装最新版 |
| `--connect-only` | 跳过安装，只写配置（可配合 `--verify`） |
| `--verify` / `--verify-only` | 安装 / 接入后实际调用 `browser_tabs` 验证 / 只验证 |
| `--json` | 机器可读输出，日志走 stderr |
| `--clients zcode,cursor` | 只配置指定客户端 |
| `--dir <目录>` | Windows 安装目录 / Linux AppImage 存放目录 |
| `--no-launch` | 安装后不自动启动浏览器 |
| `--sha256 <hex>` | 显式校验安装包哈希 |
| `--print-config` | 只输出通用 MCP 配置片段 |

安装器从不交互提问；`--yes` 只是兼容提示词的无人值守开关。自动写入配置的客户端：ZCode、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、Codex、WorkBuddy。其他客户端可用 `--print-config` 获取通用配置。DeepSeek Harness 可直接安装插件市场的 Aa Browser 插件（见[插件市场接入](./docs/MARKETPLACE.md)）。

WorkBuddy 会写入用户级 `~/.workbuddy/mcp.json` 并生成本地 Connector；配置写入、Connector 导入 / 启用、bridge 鉴权、工具调用成功是不同状态，必须由 WorkBuddy 实际调用 `browser_tabs` 后才能报告已连接。不要改写 WorkBuddy 数据库、缓存或内部运行时文件。

### Windows 安装包

从 [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) 下载 `aa-browser-setup-<版本>.exe`，双击安装。安装包未做代码签名，Windows SmartScreen 提示时选「更多信息 → 仍要运行」。

同一 Release 还提供 `SHA256SUMS.txt`、`sbom.cdx.json` 和 GitHub 不可变发行证明，可自行核对文件来源与依赖清单。

首次打开后，新标签页会提供安装与连接提示词：具备本机终端和文件操作能力的 AI 可以按提示从官方仓库下载安装、写入客户端配置，并在重启 / 重新加载后实际调用 `browser_tabs` 验证。只有 AI 实际成功调用 `browser_tabs` 的列表操作，工具栏才显示「AI 已连接」；配置写入成功本身不代表接通。

需要在本地打出安装包时（维护者）：

```bash
npm run dist -- --publish never  # 产出 release/aa-browser-setup-<版本>.exe
```

### Linux AppImage

从 [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) 下载 `aa-browser-<版本>-linux-x86_64.AppImage`，赋予执行权限后从当前桌面会话启动。需要 GTK 3、NSS、GBM、音频库以及可用的 Chromium 沙箱；MCP 接入需要系统 Node.js 22.12 或更高版本。

```bash
mkdir -p ~/Applications
mv aa-browser-<版本>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

没有 FUSE 时可用 `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage` 启动。系统依赖、按发行版验证状态和恢复步骤见[平台指南](./docs/PLATFORMS.md)。

### 源码运行

开发和打包使用 Node.js 22.12 或更高版本。

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # 首次会下载 Electron，慢可设镜像：
                   # export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build      # 构建主进程 / 预加载 / 渲染层 / MCP 桥 / DeepSeek Harness 插件桥
npm start          # 启动 Aa Browser（预览构建产物）
```

开发模式（热更新渲染层）：

```bash
npm run dev
```

开发版使用独立的 `aa-browser-dev` 用户数据目录，不会和安装版抢单实例锁、登录态或 `connection.json`，两者可以同时运行。

### 自动更新

Windows NSIS 安装版与 Linux AppImage 从 GitHub Releases 检查更新。打开「设置 → 软件更新」可以检查、查看下载状态并确认重启安装；下载完成后只有用户确认才会交给安装器。默认稳定版通道，也可切换到 Beta；网络失败会按 1 / 5 / 15 分钟退避重试，也可手动重试。安装流程、SHA-512 校验与回滚方法见[自动更新](./docs/AUTO_UPDATE.md)。

## 接入你的 Agent

### 前提

- Aa Browser 正在运行（它会在 `~/.aabrowser/connection.json` 写入本地端口与 token，MCP 桥通过它发现浏览器）。
- 客户端支持 stdio MCP；浏览器与客户端在同一台机器、同一个用户账户下。

### 方式 A · 一键接入（推荐）

Aa Browser 工具栏「设置」→「连接 AI 客户端」→ 勾选 → 写入，然后重启 AI 客户端，并让它实际调用 `browser_tabs` 的列表操作。工具栏显示「AI 已连接」才算验证通过；MCP 桥连上但尚未成功调用工具时会显示「等待 AI 首次调用」。

命令行等效：`node cli/setup.mjs --yes`（`--list` 查看客户端，`--client zcode,cursor` 指定目标）。

### 方式 B · 手动写入通用配置

先运行 `node install.mjs --print-config`，它会输出当前安装可用的 `command` / `args` / `env`，直接粘贴到客户端即可。下面是配置的形态（Windows 示例，路径和 `env` 不要照抄）：

```jsonc
{
  "mcpServers": {
    "aa-browser": {
      "command": "node",
      // 路径以 node install.mjs --print-config 的输出为准
      "args": ["C:\\path\\to\\Aa Browser\\resources\\app.asar.unpacked\\out\\bridge\\mcp.cjs"]
    }
  }
}
```

打包版自带的 Node 运行时可能写成 `"command": "C:\\...\\Aa Browser.exe"` 并附带 `"env": { "ELECTRON_RUN_AS_NODE": "1" }`，同样以 `--print-config` 的输出为准。

### 客户端配置位置

| 客户端 | 自动写入 | 配置文件 / 接入方式 |
| --- | --- | --- |
| ZCode | 是 | `~/.zcode/cli/config.json`（`mcp.servers`） |
| Claude Code | 是 | `~/.claude.json`（`mcpServers`） |
| Cursor | 是 | `~/.cursor/mcp.json`（`mcpServers`） |
| Windsurf | 是 | `~/.codeium/windsurf/mcp_config.json`（`mcpServers`） |
| Cline（VS Code 扩展） | 是 | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`（JSONC） |
| VS Code（原生 MCP） | 是 | `%APPDATA%\Code\User\mcp.json`（`servers`，需要 `type`） |
| Gemini CLI | 是 | `~/.gemini/settings.json`（`mcpServers`） |
| Qwen Code | 是 | `~/.qwen/settings.json`（`mcpServers`） |
| Codex（桌面端 / CLI / IDE） | 是 | `~/.codex/config.toml`（`mcp_servers`，TOML） |
| WorkBuddy | 是 | `~/.workbuddy/mcp.json` + 本地 Connector |
| DeepSeek Harness | 插件市场 | 安装 `aa-browser-dsh` 插件，工具以 `mcp__aa-browser__*` 出现 |
| 其他 MCP 客户端 | 手动 | `node install.mjs --print-config` 后按客户端文档粘贴 |

写入前自动备份原配置为 `<文件>.aa-backup-<时间戳>`，只改 `aa-browser` 一个键，幂等可重复执行；配置文件存在但无法解析时会跳过自动写入并提示手动配置，不会硬写坏原文件。Linux 上 VS Code 配置位于 `~/.config/Code/User/`。

### 连接状态与验证

| 工具栏状态 | 含义 |
| --- | --- |
| 等待 AI 连接 | 还没有 MCP 桥连上：配置没写入、客户端没重启，或浏览器没运行 |
| 等待 AI 首次调用 | 桥已连上并完成鉴权，但还没有一次成功的工具调用 |
| AI 已连接 ×N | 至少一次 `browser_tabs` 列表调用成功；N 为已验证的桥连接数 |

「配置写入成功」不等于接通。命令行验证：`node install.mjs --verify-only`。DeepSeek Harness 场景先确认 `~/.aabrowser/dsh-bridge.cjs` 存在，再让 Agent 实际调用一次 `mcp__aa-browser__browser_tabs`；工具出现在列表里只证明桥启动成功，不能证明浏览器可达。

然后让 Agent 干活，例如：「用浏览器打开 GitHub trending，把前 10 个项目整理成表格」或「打开 xx 后台，把登录后的接口响应都抓给我看」。

## MCP 工具

共 **34 个**工具，按能力分为五类：导航与快照 4 个、交互 9 个、读取与状态 12 个、网络与 Mock 6 个、诊断与标签 3 个。工具名在客户端可能带 `mcp__aa-browser__` 前缀（如 `mcp__aa-browser__browser_tabs`），以客户端实际展示为准。

共享行为：

- 导航与多数动作工具默认在结果里附带一份快照；`snapshot: false` 可跳过，`browser_snapshot { full: true }` 强制完整树。
- 除 `browser_resize`（调整整个窗口视口）和 `browser_downloads`（全局下载列表）外，工具都接受 `tabId`，默认作用于活动标签。
- 浏览器未运行时，桥返回 `isError` 工具结果而不是挂起；桥每 5 秒重试连接，启动浏览器后无需重启客户端。
- 单次调用超时 180 秒；等待人工审批最长 120 秒，超时按拒绝处理。
- 网络详情与 HAR 默认脱敏；开启「高危操作人工确认」后，`includeSensitive: true` 需要用户在浏览器里批准。

**导航与快照**

| 工具 | 说明 |
| --- | --- |
| `browser_navigate` | 导航到 URL（非 URL 文本自动转搜索词；结果内嵌完整快照，`snapshot: false` 可跳过） |
| `browser_snapshot` | 结构化页面快照（默认增量省 token；`full: true` 强制完整树） |
| `browser_navigate_back` / `browser_navigate_forward` | 历史后退 / 前进（返回增量快照） |

**交互**

| 工具 | 说明 |
| --- | --- |
| `browser_click` | 按 ref 点击（支持左键 / 右键 / 双击，自动返回增量快照） |
| `browser_type` | 按 ref 输入文本（支持 `submit` 回车提交、`clear` 清空） |
| `browser_fill_form` | **批量填写**：一次调用填多个字段（文本 / 下拉 / 复选），末尾只回一次快照 |
| `browser_select_option` | 按 ref 选择下拉项（按 value 或可见文本匹配） |
| `browser_drag` | 按 ref 拖拽（拖到目标元素 `toRef` 或相对偏移 `dx, dy`，支持滑块与看板） |
| `browser_hover` | 按 ref 悬停（真实 mouseMove，触发悬停菜单 / 提示） |
| `browser_scroll` | 滚动页面（先主文档，后最大滚动区域；默认 700px，上限 3000px） |
| `browser_press_key` | 按键：Enter / Escape / Tab / 方向键 / PageUp / PageDown / F1-F12 / 单字符 |
| `browser_upload_file` | 向 `<input type=file>` 上传本机文件（触发 change 事件） |

**读取与状态**

| 工具 | 说明 |
| --- | --- |
| `browser_extract` | 提取整页或指定元素的纯文本 |
| `browser_evaluate` | 在页面执行 JS 表达式并返回 JSON（可按 ref 绑定 `element`） |
| `browser_dialogs` | 读取页面弹过的 `alert` / `confirm` / `prompt`（已被拦截，不会卡死） |
| `browser_wait` | 等待文本出现 / 消失 / 固定时长（`text` / `textGone` / `time`，250ms 轮询，上限 30s） |
| `browser_screenshot` | PNG 截图（支持 `ref` 元素级截图：滚动到位并按包围盒裁剪），存 `~/.aabrowser/screenshots/` |
| `browser_find` | 页面内查找文本（原生 Ctrl+F：高亮全部匹配并定位第一处） |
| `browser_get_selector` | 导出元素的 CSS 选择器（DOM 回验，可复用于脚本 / 测试） |
| `browser_cookies` | Cookie 读 / 写 / 清（登录态测试关键能力） |
| `browser_storage` | localStorage / sessionStorage 读写、删除与清空 |
| `browser_downloads` | 下载捕获列表（静默保存到 `~/.aabrowser/downloads/`，无弹窗） |
| `browser_pdf` | 页面渲染为 PDF 并保存（A4、打印背景） |
| `browser_console` | 读取页面控制台日志（可按级别过滤） |

**网络与 Mock**

| 工具 | 说明 |
| --- | --- |
| `browser_network_requests` | **抓包**：列出捕获的 HTTP 请求（方法 / 状态 / 类型 / 大小 / 耗时 / URL，支持过滤） |
| `browser_network_detail` | **抓包**：单个请求的完整请求 / 响应头 + 响应体（`body: true`） |
| `browser_har` | **抓包**：导出 HAR 1.2 文件（可导入 DevTools / Fiddler 人工分析） |
| `browser_mock_requests` | **拦截 Mock**：按 URL 子串 + 方法拦截请求，返回假状态 / 头 / 体（`action: continue` 只观察放行） |
| `browser_list_mocks` | **拦截 Mock**：列出当前 mock 规则（匹配器 / 状态 / 命中次数） |
| `browser_clear_mocks` | **拦截 Mock**：按 id 删除或清空全部 mock 规则 |

**诊断与标签**

| 工具 | 说明 |
| --- | --- |
| `browser_performance` | 页面性能摘要：TTFB / DOMContentLoaded / load、首绘、资源体积与慢资源、JS 堆、DOM 规模（只读诊断） |
| `browser_resize` | 调整视口尺寸 200–5000px（响应式测试） |
| `browser_tabs` | 列表 / 新建 / 切换 / 关闭标签页；`isolated: true` 新建隔离标签 |

完整的参数说明、返回示例与风险标注见[34 工具手册](./site/tools.html)（本地打开 `site/tools.html` 即可，无需部署）。

## 界面与快捷键

工具栏左侧依次是后退 / 前进 / 刷新和 AI 连接状态；右侧是恢复关闭的标签页、页面查找、Agent 活动日志、下载、设置和「中断 Agent」。地址栏支持输入网址、搜索词与历史补全（↑ / ↓ 选择，Enter 打开，Esc 取消）。Agent 每次点击时页面会闪出激光波纹，方便人观察它在点哪里。

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+T` | 新建标签页 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Shift+T` | 恢复本次运行中最近关闭的标签页（最多 20 个） |
| `Ctrl+L` | 聚焦地址栏 |
| `Ctrl+F` | 页面内查找（`Enter` / `Shift+Enter` 切换匹配，`Esc` 关闭） |
| `F5` / `Ctrl+R` | 重新加载页面 |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `Ctrl+Shift+I` | 打开 DevTools（与抓包互斥，打开前会释放调试通道） |
| `Esc` | 关闭面板 / 查找栏 / 搜索建议 |

常用设置：

| 设置项 | 说明 |
| --- | --- |
| 界面语言 | 自动跟随系统，或固定简体中文 / English |
| 默认搜索引擎 | 必应 / Google / 百度 / DuckDuckGo / GitHub，也可自定义基址 |
| 快照默认全量 | 打开后每次返回完整树（更费 token），默认关闭以使用增量快照 |
| 高危操作人工确认 | 提交表单 / 输入后回车、查看或导出未脱敏网络数据前，在浏览器内弹确认 |
| 新建标签使用隔离会话 | 默认新标签共享登录态；打开后新标签使用一次性分区，关闭即清理 |
| 重启后恢复标签页 | 默认开启；只恢复普通网页标签与活动标签 |
| 下载保存目录 | 留空则使用 `~/.aabrowser/downloads/` |
| 站点白名单 | 每行一个 `https://example.com` 或 `https://*.example.com`；填写后仅允许匹配的 HTTP/HTTPS 导航 |
| 自动更新 / 更新通道 | 稳定版或 Beta；下载完成后仍需用户确认重启安装 |
| 连接 AI 客户端 | 扫描已安装客户端，勾选后一键写入 MCP 配置 |
| Agent 本地服务 | 显示桥端口、发现文件位置、已连接客户端数 |

## 安全说明

- **连接面很小**：Agent 服务只监听 `127.0.0.1`，每次启动随机生成 token，并拒绝非本机来源的连接；端口与 token 写入用户目录 `~/.aabrowser/connection.json`（正常退出时删除）。
- **页面视图不挂 preload**：快照与动作脚本由主进程注入；导航只允许 `http:` / `https:`（内部新标签页除外），`file:`、`data:`、`devtools:` 等协议会被拒绝。
- **审批与中断**：敏感输入框一律要求用户亲自填写——Agent 提供的文本不会被写入、读取或回传；开启「高危操作人工确认」后，提交表单 / 输入后回车、查看或导出未脱敏网络数据也会等待批准，120 秒未确认按拒绝处理。工具栏可随时中断 Agent 的后续浏览器操作，恢复后再继续。
- **网络数据脱敏**：网络详情与 HAR 默认脱敏认证头和凭据类参数；开启「高危操作人工确认」后，`includeSensitive: true` 查看或导出未脱敏数据需要先批准。
- **站点白名单**：只作用于导航，留空表示关闭；即使白名单为空，`file:`、`data:`、`devtools:` 等非网页协议也不会被放行。
- **会话隔离**：隔离标签使用独立 session 分区，不共享 Cookie 与登录态，关闭后清理数据；隔离标签不进入全局历史、最近关闭列表与会话恢复记录。
- **接入写入**：安装器只改 `aa-browser` 一个条目，写入前自动备份，不写入任何 token / 密码；下载安装包时校验 Release 的 SHA-256 digest 与文件头。
- **边界提醒**：Agent 能看到页面内容与网络流量，包括可能含秘密的 Cookie、Storage、请求头和响应体。上述措施是缓解手段，不是通用 DLP；不要让不可信 Agent 访问高敏站点。

安全问题请按 [SECURITY.md](./SECURITY.md) 通过 GitHub 私密报告提交，不要在公开 issue 里附令牌、Cookie 或账号数据。

## 本地数据与卸载

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `~/.aabrowser/connection.json` | 本地桥端口、token、pid、版本、instanceId | 运行时存在，正常退出删除；可用 `AA_BROWSER_CONNECTION_FILE` 覆盖 |
| `~/.aabrowser/settings.json` | 全部设置 | 可用 `AA_BROWSER_SETTINGS_FILE` 覆盖 |
| `~/.aabrowser/history/history.json` | 最近 1000 条访问（标题 / URL / 次数） | 隔离标签不写入；可用 `AA_BROWSER_HISTORY_DIR` 覆盖 |
| `~/.aabrowser/session.json` | 上次标签快照（≤20 条，剥离 URL 账号密码） | 可用 `AA_BROWSER_SESSION_FILE` 覆盖 |
| `~/.aabrowser/downloads/` | 浏览器下载与 PDF | 可在设置中修改下载目录；可用 `AA_BROWSER_DOWNLOAD_DIR` 覆盖 |
| `~/.aabrowser/screenshots/` | MCP 截图 | 可用 `AA_BROWSER_SCREENSHOT_DIR` 覆盖 |
| `~/.aabrowser/har/` | `browser_har` 导出的 HAR 文件 | 默认路径 `aa-<时间戳>.har` |
| `~/.aabrowser/dsh-bridge.cjs` | DeepSeek Harness 插件放置的 MCP 桥副本 | 安装并启用 DeepSeek Harness 插件后出现 |
| Electron 用户数据目录 | Chromium profile（Cookie、登录态、缓存）、`error.log`、Linux 的 `mcp/bridge.cjs` 与 `previous-versions/` | Windows 为 `%APPDATA%\Aa Browser`，Linux 为 `~/.config/Aa Browser`；开发模式为 `aa-browser-dev`（可用 `AA_BROWSER_USER_DATA_DIR` 覆盖，此时 `connection.json` 也落在这里） |

**Windows 卸载**：系统「设置 → 应用 → 已安装的应用」中卸载 Aa Browser，快捷方式与卸载项由 NSIS 管理；用户数据默认保留，需要彻底清理时手动删除上面的目录。

**Linux 卸载**：退出应用，删除 AppImage 与自行添加的启动器；用户数据在 `~/.config/Aa Browser`，需要时一并删除。

移除 MCP 接入时，只从各客户端配置里删除 `aa-browser` 条目；DeepSeek Harness 场景卸载 `aa-browser-dsh` 插件即可。升级回滚见[自动更新](./docs/AUTO_UPDATE.md)与[平台指南](./docs/PLATFORMS.md)。

## 平台支持

| 平台 | 官方发行 | 说明 |
| --- | --- | --- |
| Windows 11 x64 | NSIS 安装包 | 直接维护，CI 与本机回归覆盖 |
| Windows 10 x64 | 同一安装包 | 与 Windows 11 共享安装包，仍需 Windows 10 实机升级验收 |
| Linux x86_64（Ubuntu 桌面） | AppImage | 需要系统 Node.js 22.12+；其他发行版需实机验证 |
| Windows ARM64 / macOS / Android / iOS | 暂无 | 安装器会明确拒绝，不会假装安装 |

正式发行附 `SHA256SUMS.txt`、CycloneDX `sbom.cdx.json` 和 GitHub 不可变发行证明。更完整的可行性评估、系统依赖与恢复步骤见[平台指南](./docs/PLATFORMS.md)。

## 已知限制

- **未做代码签名**：Windows SmartScreen 会提示，需要手动选择「更多信息 → 仍要运行」。
- **官方安装包只覆盖 Windows x64 与 Linux x86_64**：macOS、Windows ARM64 和移动端没有官方安装包；从源码自行构建不属于官方验证过的分发渠道。
- **Linux 的 MCP 接入依赖系统 Node.js 22.12+**：Windows 未安装系统 Node 时使用应用自带的运行时。
- **不是 Chrome 的替代品**：没有书签、扩展、账号同步和多设备同步，定位是「浏览器内核 + Agent 接入」。
- **Agent 权限很大**：能看到页面内容、Cookie、Storage 与网络流量；白名单、会话隔离、脱敏和审批是缓解措施，不是通用 DLP。
- **会话恢复有范围**：只恢复普通网页标签，不恢复隔离标签、内部页与非 HTTP(S) 地址，最多 20 条。
- **同一用户数据目录只运行一个实例**：重复启动会聚焦已有窗口；开发版使用独立目录，可与安装版并存。
- **安装与更新依赖 GitHub Releases**：访问受限时需要手动下载安装包；AppImage 原地更新要求当前文件目录可写。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 工具栏一直「等待 AI 连接」 | 确认配置已写入并重启了客户端；运行 `node install.mjs --verify-only` 检查浏览器侧是否正常 |
| 显示「等待 AI 首次调用」 | 桥已连上但还没成功调用工具：让 Agent 调用 `browser_tabs { "action": "list" }` |
| 客户端看不到工具 | 重启 / 重载客户端；检查配置文件路径与 `.aa-backup-*` 备份；DeepSeek Harness 场景确认插件已启用 |
| 工具返回「浏览器未运行」 | 启动 Aa Browser；桥每 5 秒重试连接，无需重启客户端 |
| 调用卡住或超时 | 单次调用上限 180 秒；可能有审批面板在等待确认，或页面仍在加载；用 `browser_wait` 显式等待 |
| 返回「已点击」但页面没反应 | 真实事件偶发丢失时已自动补发合成事件；用 `browser_snapshot` 复核，必要时重新 `browser_click` |
| 下载文件找不到 | 默认在 `~/.aabrowser/downloads/`，设置里可改；用 `browser_downloads` 查看记录 |
| 截图 / PDF 存到哪 | 截图在 `~/.aabrowser/screenshots/`；PDF 默认在 `~/.aabrowser/downloads/` |
| 站点打不开、提示不在白名单 | 清空或补充「站点白名单」；白名单只允许匹配的 HTTP/HTTPS 站点 |
| Windows SmartScreen 提示 | 安装包未做代码签名；确认来源为官方 Release 后选「更多信息 → 仍要运行」 |
| Linux 启动失败（FUSE / 沙箱） | 用 `APPIMAGE_EXTRACT_AND_RUN=1` 启动；检查 GTK3 / NSS / GBM / 音频库与用户命名空间策略 |
| 更新下载失败 | 检查 GitHub 访问；失败会按 1 / 5 / 15 分钟退避重试，也可在设置里手动重试 |
| 想回到旧版本 | AppImage：复制用户数据 `previous-versions/<版本>.AppImage` 回安装目录；Windows：重装旧版安装包 |

更多排查项见[通用安装与接入](./docs/CONNECT.md)与[平台指南](./docs/PLATFORMS.md)。

## 项目结构

```text
aa-browser/
├── src/
│   ├── main/          # 主进程：窗口 / 标签 / 动作 / 抓包 / Agent 服务 / MCP 工具 / 客户端接入
│   ├── preload/       # 仅外壳 UI 的 IPC 桥（页面视图不挂 preload）
│   ├── renderer/      # 浏览器外壳 UI（设置面板、新标签页、活动日志、审批面板）
│   ├── shared/        # 三方共享的协议类型与界面语言
│   └── snapshot/      # 注入引擎（DOM → 快照）与动作脚本
├── cli/
│   ├── mcp.mjs        # stdio MCP 桥源码（构建为 out/bridge/mcp.cjs）
│   ├── setup.mjs      # 一键接入 CLI（零依赖）
│   └── workbuddy.mjs  # WorkBuddy Connector 生成
├── installer/         # 通用安装 / 接入提示词源文件（生成 PROMPT.md 与新标签页）
├── packages/dsh/      # DeepSeek Harness 插件（插件市场接入）
├── site/              # 静态宣传站 + 34 工具手册（零依赖）
├── docs/              # 接入、平台、自动更新、发行与维护文档
│   └── media/         # README 演示录屏与动图预览
├── scripts/           # 冒烟 / 回归 / 安装器与接入校验 / 图标与 SBOM 生成
├── build/             # 图标等打包资源
├── electron.vite.config.ts
└── electron-builder.yml
```

## 开发与测试

要求 Node.js 22.12 或更高版本（构建、测试与 MCP 桥共用）。

```bash
npm run check          # typecheck + 工具契约 + 提示词漂移 + DeepSeek Harness 插件检查 + 页面脚本转义
npm run typecheck      # 仅 TypeScript 类型检查
npm run test:page-scripts # 注入脚本字面量转义回归（特殊字符不被截断、能原样还原）
npm run smoke          # 端到端冒烟：启动浏览器 → MCP 驱动 → 断言（含抓包，无外网依赖）
npm run test:desktop   # 原生桌面回归：会话恢复、查找、快捷键、隔离会话、审批
npm run test:update-ui # 更新提示 / 后台下载 / 重试交互（模拟 provider）
npm run test:stores    # 设置 / 历史 / 会话恢复记录的持久化回归
npm run test:security  # 安全相关回归
npm run test:installer # 安装器纯函数：平台资产选择、稳定路径、digest/文件头校验
npm run test:bridge    # MCP 桥离线行为与错误返回
npm run test:connect   # 对打包产物执行 --connect-only --verify --json（需先 dist）
npm run test:updater   # 更新器状态机（模拟 provider）
npm run test:release   # 发布标签 / 草稿 / 资产回归（模拟 GitHub API）
npm run validate:codex # 验证 Codex TOML 接入、保留其他配置、备份与幂等
npm run validate:workbuddy
npm run prompt         # 从 installer/*.md 重新生成 PROMPT.md 与新标签页提示词
npm run sbom           # 生成 CycloneDX SBOM
node scripts/live-test.mjs   # 实战示例：MCP 驱动必应搜索全流程
```

CI 在 Windows x64 与 Linux x64 上执行 `check`、工具与客户端接入校验、构建、SBOM、Electron 桌面回归、安装 / 卸载和打包产物连接验证。贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 宣传站

仓库内附带一个零依赖静态宣传站，介绍产品定位、快照流程、34 个工具与接入方式，并包含完整的[工具手册](./site/tools.html)：

```bash
python -m http.server 4321 --directory site
# 或：npx --yes serve site -l 4321
# 打开 http://127.0.0.1:4321/
```

源文件在 `site/`，无需构建即可部署到 GitHub Pages / Netlify / Vercel / Nginx。部署步骤、内容维护清单与已验证范围见 [site/README.md](./site/README.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [通用安装与接入](./docs/CONNECT.md) | 平台与客户端矩阵、安装器参数、手动步骤、排查 |
| [平台指南](./docs/PLATFORMS.md) | 发行矩阵、Linux 依赖、卸载与数据恢复 |
| [自动更新](./docs/AUTO_UPDATE.md) | 检查、下载、重启安装、SHA-512 与回滚 |
| [插件市场接入](./docs/MARKETPLACE.md) | DeepSeek Harness 插件安装与验证 |
| [维护状态](./docs/MAINTENANCE.md) | 发行证据、回归记录与维护边界 |
| [发布说明](./docs/releases/release-notes.md) / [CHANGELOG](./CHANGELOG.md) | 按版本整理的变更历史 |
| [竞品与生态调研](./docs/RESEARCH.md) | 开源项目对标、平台可行性依据 |
| [README 多语言](./docs/i18n/README.md) | 12 种语言的 README 索引与新增语言步骤 |
| [宣传站说明](./site/README.md) | 静态站部署与内容维护 |
| [贡献指南](./CONTRIBUTING.md) | 开发环境、提交约定与 PR 要求 |

## 常见问题

**它和 Playwright MCP 有什么区别？**

快照格式与 ref 交互范式对齐 Playwright MCP，所以 Agent 不需要重新学习。区别在于 Aa Browser 是一个完整的桌面浏览器：共享你的登录态、标签页与会话，原生带抓包 / Mock / HAR、Cookie / Storage 与性能诊断，不需要为每个任务启动无头实例。

**需要会写代码吗？**

不需要。安装包双击即用；接入时把 `PROMPT.md` 交给有本机执行能力的 AI，或在工具栏「设置 → 连接 AI 客户端」里勾选即可。

**支持 macOS 吗？**

目前没有官方 macOS 安装包。安装器遇到 macOS、Windows ARM64 或其他架构会明确拒绝，不会假装安装；从源码构建可以自行尝试，但不属于官方验证过的分发渠道。

**为什么工具栏显示「等待 AI 首次调用」？**

说明 MCP 桥已经连上，但还没有任何一次工具调用成功。让客户端实际调用 `browser_tabs`，返回标签列表后状态才会变成「AI 已连接」。配置写入成功本身不代表接通。

**Agent 能看到我的密码吗？**

能读取你允许它操作的页面内容，包括可能含秘密的 Cookie、Storage、请求头和响应体。请配合站点白名单与会话隔离使用，不要把高敏后台交给不可信的 Agent；敏感输入审批与网络脱敏是缓解措施，不是通用 DLP。

**为什么 Agent 说点过了，页面却没变化？**

真实输入事件在个别页面偶发丢失，Aa Browser 会补发合成事件兜底；仍不生效时用 `browser_snapshot` 复核状态，再重试 `browser_click`，或改用 `browser_evaluate` 触发页面自身逻辑。

**能同时开两个 Aa Browser 吗？**

同一用户数据目录只允许一个实例，再次启动会聚焦已有窗口。开发版使用独立的 `aa-browser-dev` 目录，可以和安装版同时运行。

**数据存在哪里？会上传吗？**

设置、历史、会话记录、下载与截图都在本机 `~/.aabrowser/` 与 Electron 用户数据目录中，详见[本地数据与卸载](#本地数据与卸载)。没有账号体系，也没有云端中转；只有检查更新时会访问 GitHub Releases。

**收费吗？**

MIT 开源、免费。没有账号体系，也没有云端中转。浏览器本地直连，更新检查走 GitHub Releases。

**怎么升级或回滚？**

Windows 安装版与 Linux AppImage 都可以在「设置 → 软件更新」检查升级；AppImage 的旧版本会保留在用户数据的 `previous-versions/` 下。细节见[自动更新](./docs/AUTO_UPDATE.md)与[平台指南](./docs/PLATFORMS.md)。

## 贡献

欢迎 bug 报告、功能讨论、文档改进与代码 PR。开始前请读 [CONTRIBUTING.md](./CONTRIBUTING.md)；新增 MCP 工具时请同步更新 `src/main/tools.ts`、`cli/mcp.mjs`、本文档的工具表（`npm run check` 会校验这三处一致）以及 `site/tools.html` 的工具手册。

安全问题请走[私密安全报告](https://github.com/yuchen0x1/aa-browser/security/advisories/new)，不要公开披露未修复的漏洞。

## 许可

[MIT](./LICENSE) © Aa Browser contributors

## 致谢

Aa Browser 站在巨人的肩膀上，设计中对齐 / 借鉴了这些优秀开源项目的能力与格式：

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — 可访问性快照 + ref 交互范式（我们对齐其格式），hover/历史导航/视口调整/元素截图等工具设计
- [browser-use](https://github.com/browser-use/browser-use) — Agent 驱动浏览器的理念与动作后回读状态的实践
- [BrowserTools MCP](https://github.com/AgentDeskAI/browser-tools-mcp) — Cookie/本地存储/选择器导出等「浏览器状态透明化」工具集
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/mcp) — CDP 能力面（网络抓包域）的参照

## Star History

<a href="https://star-history.com/#yuchen0x1/aa-browser&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date" />
  </picture>
</a>
