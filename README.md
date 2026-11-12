# Aa Browser

**为 AI Agent 而生的开源桌面浏览器。**

![License](https://img.shields.io/badge/license-MIT-blue) ![CI](https://github.com/yuchen0x1/aa-browser/actions/workflows/ci.yml/badge.svg) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> 人像人一样浏览网页，Agent 像工程师一样驱动它。
> **The Agent-Native Browser** — snapshots, actions, and packet capture over MCP.

## 最新更新

### v0.0.1

Aa Browser 以重新整理后的代码重新开始发布；此前的 GitHub Releases 已撤下。

- 提供基于 MCP 的浏览器控制，包括页面导航、交互、下载、对话框和网络记录。
- 新增首次启动 AI 接入向导，并支持配置 Codex 桌面端、CLI 和 IDE；修改前自动备份并保留其他设置。
- 提供 Windows 安装包和应用内更新检查。

完整版本历史见[发布说明](./docs/releases/release-notes.md)。

传统浏览器是为"人眼看像素"设计的；而 AI Agent 需要的是**结构化页面数据**。Aa Browser 是一个完整的 Chromium 浏览器，任何人都可以正常使用它上网；同时，任何支持 MCP（Model Context Protocol）的 AI Agent 都可以连接进来，读取页面的**结构化快照**（可访问性树 + 元素 ref 编号），并执行点击、输入、选择、滚动、提取等操作——不看截图、不猜坐标。

## 特性

- 🖥️ **真浏览器**：基于 Electron（Chromium），标签页 / 地址栏 / 前进后退 / 登录态持久化，一应俱全
- 🧠 **结构化快照**：页面被转换成 YAML 风格的可访问性树，每个可交互元素带 `ref` 编号（`- button "登录" [ref=e5]`），格式对齐 Playwright MCP 生态，Agent 零学习成本
- 💸 **增量快照省 token**：页面没变 → 一行回复；小变化 → 只返回变更区块；ref 跨快照稳定复用（React 重渲染也能靠内容签名接上）；跳转/大变化自动回退完整快照。一次多步任务可省 60%+ 上下文
- 🤖 **MCP 原生接入**：标准 stdio MCP 桥，Codex / ZCode / Claude Code / Cursor 等 MCP 客户端均可驱动
- 🔒 **本地安全**：WebSocket 仅监听 127.0.0.1，随机端口 + 一次性 token，拒绝非本机连接
- 🎯 **真实输入路径**：点击走受信任的输入事件（`isTrusted=true`），输入走 `insertText` 管线并对 React 受控组件兜底，被遮挡元素自动降级为合成事件
- 🔁 **动作后自动快照**：每次点击/输入后自动返回新快照，Agent 无需二次请求即可继续决策

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
{ "tool": "browser_type",   "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

点击/输入后自动返回的是**增量快照**——只有变化的区块：

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

页面未变化时只回一行（≈50 token）；跳转到新页面或变化过大时自动回退完整快照。`browser_snapshot { full: true }` 可强制完整树。

## 架构

```text
┌─────────────────────────────────────────────────────┐
│                Aa Browser (Electron)                │
│  ┌───────────────────────────────────────────────┐  │
│  │  外壳 UI（标签栏/地址栏） ←→ 主进程 IPC        │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  页面标签 WebContentsView × N                 │  │
│  │    └─ 注入快照引擎（DOM → YAML 树 + ref 表）  │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Agent 服务 ws://127.0.0.1:<random>           │  │
│  │    ~/.aabrowser/connection.json (port+token)  │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────┘
                           │ 本地 WebSocket（token 鉴权）
┌──────────────────────────┴──────────────────────────┐
│  cli/mcp.mjs —— stdio MCP 桥（零依赖）              │
│    MCP 客户端：Codex / ZCode / Claude Code / Cursor …│
└─────────────────────────────────────────────────────┘
```

## 快速开始

### ⚡ WorkBuddy：一条消息安装并接入

把 [PROMPT.md](./PROMPT.md) 中的 WorkBuddy 提示词整段发给 WorkBuddy。它会尝试下载并运行安装器，准备 `~/.workbuddy/mcp.json` 和本地 Connector 文件；这不保证 WorkBuddy 自动加载。需要时须通过 WorkBuddy 5.9.3 支持的“专家·技能·连接器”流程导入/启用，然后由当前会话实际调用 `browser_tabs` 验证。若产品不支持本地 Connector 导入或工具未出现，报告具体阻塞；不得以安装或配置文件生成声称已接通。

手动 PowerShell 等效命令：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -OutFile install.mjs
node .\\install.mjs --repo yuchen0x1/aa-browser --clients workbuddy
```

### 其他 MCP 客户端

```bash
node install.mjs --repo yuchen0x1/aa-browser                 # 自动拉 GitHub Releases 最新版
node install.mjs --repo yuchen0x1/aa-browser --clients zcode,cursor
```

WorkBuddy 路径尝试写入用户级 `~/.workbuddy/mcp.json` 并生成本地 Connector 包。配置写入、Connector 导入/启用、bridge 鉴权、工具调用成功是不同状态，必须分别确认；不能推断 WorkBuddy 会自动发现该 JSON，也不要改写 WorkBuddy 数据库、缓存或内部运行时文件。

### 其他方式

要求：Node.js ≥ 20，Windows / macOS / Linux。

### 自动更新

正式 Windows 安装版使用 GitHub Releases 和 `electron-updater` 检查更新。打开「设置 → 软件更新」可以手动检查、选择稳定版/Beta 通道、查看状态并在下载完成后重启安装。发布和配置说明见 [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md)。

### 方式一：Windows 安装包（推荐给普通用户）

```bash
npm run dist       # 产出 release/Aa Browser-Setup-<版本>.exe（NSIS 安装器）
```

双击安装（未做代码签名，Windows SmartScreen 会提示"更多信息 → 仍要运行"）。首次打开后，新标签页会引导你完成接入：点工具栏「设置」→「连接 AI 客户端」写入配置，重启 AI 客户端，再把页面上的测试提示词发给 AI。只有 AI 实际调用 `browser_tabs` 后，工具栏才显示「AI 已连接」；配置写入成功本身不代表接通。

### 方式二：源码运行（开发者）

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm install        # 首次会下载 Electron，慢可设镜像：
                   # export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build      # 构建主进程 / 预加载 / 渲染层
npm start          # 启动 Aa Browser
```

开发模式（热更新渲染层）：

```bash
npm run dev
```

## 接入你的 Agent

**方式 A · 一键接入（推荐）**：Aa Browser 工具栏「设置」→「连接 AI 客户端」→ 勾选 → 写入，然后重启 AI 客户端并按新标签页给出的测试提示词实际调用 `browser_tabs`。工具栏显示「AI 已连接」才算验证通过；MCP 桥连上但尚未成功调用工具时会显示「等待 AI 首次调用」。
命令行等效：`node cli/setup.mjs --yes`（`--list` 查看，`--client zcode,cursor` 指定目标）。
支持传统配置式 MCP 客户端：**Codex（桌面端 / CLI / IDE）/ ZCode / Claude Code / Cursor / Windsurf / Cline / VS Code / Gemini CLI / Qwen Code**。Codex 配置写入用户级 `~/.codex/config.toml`；其他客户端写入各自 MCP 配置。写入前自动备份原配置为 `<file>.aa-backup-<时间戳>`，幂等可重复执行。保存后需重启客户端，并让它实际调用 `browser_tabs` 验证。

**WorkBuddy**：CLI 会单独生成 `~/.workbuddy/mcp.json` 的 stdio 配置（覆盖前备份并只更新 `mcpServers.aa-browser`）。安装后必须在 WorkBuddy 会话中确认 `browser_tabs` 实际出现并成功调用；若 WorkBuddy 要求 MCP UI 授权或重连，完成后再验证。WorkBuddy 不是由“配置写入成功”自动判定连接成功。

**方式 B · 通用手动 MCP 配置**：在 MCP 客户端配置中添加：

```jsonc
{
  "mcpServers": {
    "aa-browser": {
      "command": "node",
      "args": ["C:\Program Files\aa-browser 或 %LOCALAPPDATA%\Programs\Aa Browser/cli/mcp.mjs"]
    }
  }
}
```

**前提**：Aa Browser 保持运行（它会在 `~/.aabrowser/connection.json` 写入本地端口与 token，MCP 桥通过它发现浏览器）。

然后让 Agent 干活，例如："用浏览器打开 GitHub trending，把前 10 个项目整理成表格" 或 "打开 xx 后台，把登录后的接口响应都抓给我看"。

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `browser_navigate` | 导航到 URL（非 URL 文本自动转搜索词；结果内嵌完整快照，`snapshot: false` 可跳过） |
| `browser_snapshot` | 结构化页面快照（增量模式省 token；`full: true` 强制完整树） |
| `browser_click` | 按 ref 点击（支持左键/右键/双击，自动返回增量快照） |
| `browser_drag` | 按 ref 拖拽（拖到目标元素 `toRef` 或相对偏移 `dx, dy`，支持滑块与看板） |
| `browser_type` | 按 ref 输入文本（支持 `submit` 回车提交、`clear` 清空） |
| `browser_fill_form` | **批量填写**：一次调用填多个字段（文本/下拉/复选），末尾只回一次快照，省 token |
| `browser_select_option` | 按 ref 选择下拉项（按 value 或可见文本匹配） |
| `browser_scroll` | 滚动页面（先主文档，后最大滚动区域） |
| `browser_extract` | 提取整页或指定元素的纯文本 |
| `browser_evaluate` | 在页面执行 JS 表达式并返回 JSON（可按 ref 绑定 `element`） |
| `browser_dialogs` | 读取页面弹过的 `alert`/`confirm`/`prompt`（已被拦截，不会卡死） |
| `browser_wait` | 等待文本出现 / 消失 / 固定时长（`text``textGone`\`time`） |
| `browser_press_key` | 按键：Enter / Escape / 方向键 / 单字符等 |
| `browser_screenshot` | PNG 截图（支持 `ref` 元素级截图：滚动到位并按包围盒裁剪） |
| `browser_hover` | 按 ref 悬停（真实 mouseMove，触发悬停菜单/提示） |
| `browser_navigate_back` / `browser_navigate_forward` | 历史后退 / 前进（返回增量快照） |
| `browser_resize` | 调整视口尺寸（响应式测试） |
| `browser_get_selector` | 导出元素的 CSS 选择器（DOM 回验，可复用于脚本/测试） |
| `browser_find` | 页面内查找文本（原生 Ctrl+F：高亮全部匹配并定位第一处） |
| `browser_cookies` | Cookie 读 / 写 / 清（登录态测试关键能力） |
| `browser_storage` | localStorage / sessionStorage 读写与清空 |
| `browser_downloads` | 下载捕获列表（静默保存到 ~/.aabrowser/downloads/，无弹窗） |
| `browser_pdf` | 页面渲染为 PDF 并保存 |
| `browser_upload_file` | 向 `<input type=file>` 上传本机文件（触发 change 事件） |
| `browser_console` | 读取页面控制台日志 |
| `browser_network_requests` | **抓包**：列出捕获的 HTTP 请求（方法/状态/类型/大小/耗时/URL，支持过滤） |
| `browser_network_detail` | **抓包**：单个请求的完整请求/响应头 + 响应体（`body: true`） |
| `browser_har` | **抓包**：导出 HAR 1.2 文件（可导入 DevTools/Fiddler 人工分析） |
| `browser_mock_requests` | **拦截 Mock**：按 URL 子串+方法拦截请求，返回假状态/头/体（`action: continue` 只观察放行） |
| `browser_list_mocks` | **拦截 Mock**：列出当前 mock 规则（匹配器/状态/命中次数） |
| `browser_clear_mocks` | **拦截 Mock**：按 id 删除或清空全部 mock 规则 |
| `browser_tabs` | 列表 / 新建 / 切换 / 关闭标签页 |

## 安全说明

- Agent 服务只监听 `127.0.0.1`，连接需携带启动时生成的随机 token
- token 与端口写在用户目录 `~/.aabrowser/connection.json`（仅当前用户可读）
- 一键接入写入其他客户端配置前**自动备份**、只改 `aa-browser` 一个键、幂等可重复
- **注意**：Agent 能看到页面内容与网络流量，包括可能含秘密的 Cookie、Storage、请求头和响应体。敏感输入审批是基于页面字段特征的保护，不是通用 DLP；不要让不可信 Agent 访问高敏站点。
- **站点白名单**：在设置中每行填写一个 `https://example.com` 或 `https://*.example.com` 规则；填写后仅允许匹配的 HTTP/HTTPS 站点导航，留空表示关闭白名单。
- **会话隔离**：每个标签页使用独立的持久化 Electron session 分区，Cookie、Storage、缓存和请求拦截规则不会在标签页之间共享。

## 项目结构

```text
aa-browser/
├── src/
│   ├── main/          # 主进程：窗口 / 标签 / 动作 / 抓包 / Agent 服务 / MCP 工具 / 客户端接入
│   ├── preload/       # 仅外壳 UI 的 IPC 桥（页面视图不挂 preload）
│   ├── renderer/      # 浏览器外壳 UI（含设置面板）+ 新标签页
│   ├── shared/        # 三方共享的协议类型
│   └── snapshot/      # 注入引擎（DOM → 快照）与动作脚本
├── cli/
│   ├── mcp.mjs        # stdio MCP 桥（零依赖）
│   └── setup.mjs      # 一键接入 CLI（零依赖）
├── scripts/           # 冒烟测试 / 实战测试 / 图标生成
├── electron.vite.config.ts
└── electron-builder.yml
```

## 测试

```bash
npm run smoke   # 端到端冒烟：启动浏览器 → MCP 驱动 → 断言（含抓包，无外网依赖）
npm run validate:codex # 验证 Codex TOML 接入、保留其他配置、备份与幂等
node scripts/live-test.mjs   # 实战示例：MCP 驱动必应搜索全流程
```

[MIT](./LICENSE)

## 致谢

Aa Browser 站在巨人的肩膀上，设计中对齐 / 借鉴了这些优秀开源项目的能力与格式：

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — 可访问性快照 + ref 交互范式（我们对齐其格式），hover/历史导航/视口调整/元素截图等工具设计
- [browser-use](https://github.com/browser-use/browser-use) — Agent 驱动浏览器的理念与动作后回读状态的实践
- [BrowserTools MCP](https://github.com/AgentDeskAI/browser-tools-mcp) — Cookie/本地存储/选择器导出等"浏览器状态透明化"工具集
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/mcp) — CDP 能力面（网络抓包域）的参照

## Star History

<a href="https://star-history.com/#yuchen0x1/aa-browser&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yuchen0x1/aa-browser&type=Date" />
  </picture>
</a>
