# Aa Browser

**为 AI Agent 而生的开源桌面浏览器。**

> 人像人一样浏览网页，Agent 像工程师一样驱动它。

传统浏览器是为"人眼看像素"设计的；而 AI Agent 需要的是**结构化页面数据**。Aa Browser 是一个完整的 Chromium 浏览器，任何人都可以正常使用它上网；同时，任何支持 MCP（Model Context Protocol）的 AI Agent 都可以连接进来，读取页面的**结构化快照**（可访问性树 + 元素 ref 编号），并执行点击、输入、选择、滚动、提取等操作——不看截图、不猜坐标。

## 特性

- 🖥️ **真浏览器**：基于 Electron（Chromium），标签页 / 地址栏 / 前进后退 / 登录态持久化，一应俱全
- 🧠 **结构化快照**：页面被转换成 YAML 风格的可访问性树，每个可交互元素带 `ref` 编号（`- button "登录" [ref=e5]`），格式对齐 Playwright MCP 生态，Agent 零学习成本
- 💸 **增量快照省 token**：页面没变 → 一行回复；小变化 → 只返回变更区块；ref 跨快照稳定复用（React 重渲染也能靠内容签名接上）；跳转/大变化自动回退完整快照。一次多步任务可省 60%+ 上下文
- 🤖 **MCP 原生接入**：标准 stdio MCP 桥，ZCode / Claude Code / Cursor 等任何 MCP 客户端均可驱动
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
│    任何 MCP 客户端：ZCode / Claude Code / Cursor …  │
└─────────────────────────────────────────────────────┘
```

## 快速开始

要求：Node.js ≥ 20，Windows / macOS / Linux。

```bash
git clone <本仓库> aa-browser
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

**第一步**：启动 Aa Browser（保持运行）。它会在 `~/.aabrowser/connection.json` 写入本地端口与 token。

**第二步**：在 MCP 客户端配置中添加：

```jsonc
{
  "mcpServers": {
    "aa-browser": {
      "command": "node",
      "args": ["<本仓库绝对路径>/cli/mcp.mjs"]
    }
  }
}
```

> Claude Code：`claude mcp add aa-browser -- node <仓库路径>/cli/mcp.mjs`
> Cursor / ZCode / 其他客户端：把上面的 JSON 写入对应 `mcp.json`。

**第三步**：让 Agent 干活。例如："用浏览器打开 GitHub trending，把前 10 个项目整理成表格。"

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `browser_navigate` | 导航到 URL（非 URL 文本自动转搜索词；结果内嵌完整快照，`snapshot: false` 可跳过） |
| `browser_snapshot` | 结构化页面快照（增量模式省 token；`full: true` 强制完整树） |
| `browser_click` | 按 ref 点击（自动返回增量快照） |
| `browser_type` | 按 ref 输入文本（支持 `submit` 回车提交、`clear` 清空） |
| `browser_select_option` | 按 ref 选择下拉项（按 value 或可见文本匹配） |
| `browser_scroll` | 滚动页面（先主文档，后最大滚动区域） |
| `browser_extract` | 提取整页或指定元素的纯文本 |
| `browser_wait` | 等待指定文本出现（轮询） |
| `browser_press_key` | 按键：Enter / Escape / 方向键 / 单字符等 |
| `browser_screenshot` | PNG 截图（图像 + 保存路径） |
| `browser_console` | 读取页面控制台日志 |
| `browser_tabs` | 列表 / 新建 / 切换 / 关闭标签页 |

## 安全说明

- Agent 服务只监听 `127.0.0.1`，连接需携带启动时生成的随机 token
- token 与端口写在用户目录 `~/.aabrowser/connection.json`（仅当前用户可读）
- **注意**：Agent 能看到你登录的页面内容。请勿让不可信的 Agent 访问网银、工作邮箱等高敏站点；后续版本将加入"操作确认弹窗"与站点白名单（见 Roadmap）

## 项目结构

```text
aa-browser/
├── src/
│   ├── main/          # 主进程：窗口 / 标签 / 动作 / Agent 服务 / MCP 工具
│   ├── preload/       # 外壳 UI 的 IPC 桥
│   ├── renderer/      # 浏览器外壳 UI + 新标签页
│   ├── shared/        # 三方共享的协议类型
│   └── snapshot/      # 注入引擎（DOM → 快照）与动作脚本
├── cli/mcp.mjs        # stdio MCP 桥（零依赖）
├── scripts/           # 冒烟测试 / 实战测试脚本
└── electron.vite.config.ts
```

## 测试

```bash
npm run smoke   # 端到端冒烟：启动浏览器 → MCP 驱动 → 断言（无网络依赖）
node scripts/live-test.mjs   # 实战示例：MCP 驱动必应搜索全流程
```

## Roadmap

- [ ] 操作确认弹窗：Agent 点击/提交前可选人工确认
- [ ] 站点白名单 / 会话隔离分区
- [x] ~~快照增量更新与缓存（进一步降 token）~~（v0.2.0 已完成）
- [ ] 下载管理、书签、多窗口
- [ ] npm 发布 `aa-browser-mcp`，支持 `npx` 一行接入
- [ ] macOS / Linux 打包分发

## License

[MIT](./LICENSE)
