# 通用安装与接入

Aa Browser 把「安装浏览器」和「接入 AI 客户端」合并成一段提示词。具备本机命令执行能力的 AI 拿到这段提示词后，会自动完成下载、校验、安装/接入和实际验证。

适用平台：**Windows x64、Linux x86_64**。macOS、Windows ARM64 和其他架构目前没有官方安装包，安装器会明确拒绝，不会假装安装。

## 两种使用方式

| 你的情况 | 用哪段提示词 | 安装器实际执行 |
| --- | --- | --- |
| 还没下载 Aa Browser | [PROMPT.md](../PROMPT.md) 第一部分 | 下载最新 Release → 校验 SHA-256/文件头 → 安装 → 启动 → 写入 MCP 配置 → 验证 |
| 已下载并打开了 Aa Browser | 新标签页「复制接入提示词」或 [PROMPT.md](../PROMPT.md) 第二部分 | 跳过安装，只写 MCP 配置 → 调用 `browser_tabs` 验证 |

两段提示词都要求 AI 先做能力检查：如果它没有本机终端/文件权限（例如网页版 ChatGPT 的普通对话），必须停止自动安装并给出手动步骤，不能假装成功。

## 支持哪些 AI 客户端

自动写入 MCP 配置的客户端：

ZCode、Claude Code、Cursor、Windsurf、Cline、VS Code（原生 MCP）、Gemini CLI、Qwen Code、OpenCode（[anomalyco/opencode](https://github.com/anomalyco/opencode)）、Codex（桌面端 / CLI / IDE，即 ChatGPT 的本地 Codex）、WorkBuddy。

DeepSeek Harness 使用插件市场手动接入：安装并启用 Aa Browser 插件，然后让 Agent 实际调用 `mcp__aa-browser__browser_tabs`；安装器与桌面端不会修改 `.dsh` 配置、数据库或缓存。命令行如需看到该手动指引，可使用 `node cli/setup.mjs --yes --client deepseek-harness`。

其他支持 MCP 的客户端（不在上述自动写入列表）：

- DeepSeek Harness：见 [插件市场接入](MARKETPLACE.md)。
- 其他客户端：先运行安装器获取通用配置片段，再按该客户端官方 MCP 文档添加。

```bash
node install.mjs --print-config
```

输出是 `mcpServers.aa-browser` 的启动命令。不要猜测客户端的配置文件路径；找不到时向用户确认。

## 手动命令（AI 不能执行时）

Windows PowerShell：

```powershell
$tmp = Join-Path $env:TEMP 'aa-browser-bootstrap'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Invoke-WebRequest https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -OutFile (Join-Path $tmp 'install.mjs')
node (Join-Path $tmp 'install.mjs') --repo yuchen0x1/aa-browser --verify --json
```

Linux：

```bash
mkdir -p /tmp/aa-browser-bootstrap
curl -fsSL https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -o /tmp/aa-browser-bootstrap/install.mjs
node /tmp/aa-browser-bootstrap/install.mjs --repo yuchen0x1/aa-browser --verify --json
```

已经装好、只想接入当前客户端：

```bash
node install.mjs --connect-only --verify --json
```

只验证连接（不写配置）：

```bash
node install.mjs --verify-only
```

## 安装器做了什么

1. 从 GitHub Releases 取最新版本，按平台选择 `.exe`（Windows）或 `.AppImage`（Linux）。
2. 校验 Release 提供的 SHA-256 digest 和文件头（PE / ELF）；校验失败立即中止。
3. Windows 静默安装 NSIS；Linux 把 AppImage 安装到 `~/Applications/AaBrowser.AppImage` 并赋予执行权限。
4. 启动 Aa Browser，等待 `~/.aabrowser/connection.json` 就绪。
5. 定位稳定 MCP 桥路径，调用 `cli/setup.mjs` 备份并写入检测到的客户端配置。写入前备份为 `<文件>.aa-backup-<时间戳>`，只修改 `aa-browser` 一个条目。
6. `--verify` 通过本地 WebSocket 实际调用 `browser_tabs`；只有返回标签列表才算成功。
7. `--json` 输出机器可读结果，供 AI 判断而不是只看退出码。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--repo yuchen0x1/aa-browser` | 从官方 GitHub Releases 安装最新版 |
| `--connect-only` | 跳过安装，只写配置并可选验证 |
| `--verify` / `--verify-only` | 安装/接入后验证 / 只验证 |
| `--json` | 机器可读输出（日志走 stderr） |
| `--clients zcode,cursor` | 只配置指定客户端 |
| `--dir <目录>` | Windows 安装目录 / Linux AppImage 目录 |
| `--no-launch` | 不自动启动浏览器 |
| `--sha256 <hex>` | 显式校验安装包哈希 |
| `--print-config` | 只输出通用 MCP 配置片段 |

## 自动更新与升级

- **浏览器本体**：通过 GitHub Releases 自动检查、下载，用户确认后重启安装；安装包带更新描述与 SHA-512 校验。
- **MCP 桥**：客户端配置指向稳定路径（Windows 安装目录内 / Linux 用户数据目录 `mcp/bridge.cjs`），应用升级后无需重写配置，桥随应用更新。
- **安装器**：幂等。升级后若工具消失，重新运行 `--connect-only --verify` 即可，写配置前仍会备份。
- **DeepSeek Harness 插件**：由插件市场负责升级，插件只负责定位并启动 MCP 桥。

## 排查

在「设置 → AI 集成 → Agent 本地服务」查看本机状态。**已认证**仅表示客户端连到了本地服务；在客户端成功调用 `browser_tabs` 的 `list` 后才显示为**已验证**。AppImage 包内有桥但用户数据目录未生成稳定入口时，先完成客户端接入。桥文件存在不代表第三方客户端已写入或能运行该文件。

展开「本机连接详情」可在本机核对端口和发现文件路径。需要共享排查信息时，可用「复制连接诊断」；复制结果只有版本、平台、服务状态、桥文件状态和连接数量，不会复制路径、端口、令牌、配置或浏览数据。

### 多个客户端 / 多个项目同时使用

所有客户端控制同一个浏览器窗口，**不是每个项目自动获得一个浏览器实例**。客户端可能为各项目启动独立桥，也可能复用同一桥；浏览器不能从连接推断项目身份。

- 每个项目先用 `browser_tabs` 的 `new` 创建自己的标签，保存返回的 `tabId`；后续支持 `tabId` 的工具都显式传入该值。不要靠先 `select` 再省略 `tabId`：活动标签是全局共享的，另一个项目或手动点击都能切换它。
- 需要不同登录态时，创建标签时使用 `isolated: true`。普通标签共享 Cookie 和 Chromium 会话；仅分开 `tabId` 不隔离登录态。隔离标签不跨重启恢复，也不是针对恶意客户端的权限边界。
- 同一标签的受队列保护页面操作按入队顺序执行，不同标签使用独立队列。队列防止工具操作重叠，不提供标签所有权、跨多个调用的事务或独占租约；其他客户端仍可显式操作同一 `tabId`。
- 排队取消不会执行该调用，也不会让后续调用越过尚未完成的前驱。取消不撤销已发生的点击、已派发的网页 JS、网络请求或外部副作用。运行中取消后，已跟踪的底层异步操作若尚未结束，队列会继续保留其占用；网页脚本永久不结束时，后续操作可能持续等待，可关闭该标签并为项目新建标签。
- 标签选择/关闭、窗口尺寸、下载、证据及普通会话级状态仍有共享影响；手动浏览器操作不经过 MCP 队列。需要严格互不影响时，使用具有独立配置与数据目录的浏览器实例，而不是只增加标签。

推荐用法：项目 A 保存 `tabId=A`，项目 B 保存 `tabId=B`，各自的导航、快照、点击和输入始终带自己的 ID。不要关闭其他项目的标签或修改共享窗口/会话设置。

| 现象 | 处理 |
| --- | --- |
| 提示缺少 Node.js 或版本过低 | 安装 Node.js 22.12+ 后重试；安装器需要 Node 运行，浏览器本体不依赖系统 Node |
| 下载 GitHub 失败 | 检查网络/代理；官方下载地址必须是 `github.com` / `raw.githubusercontent.com` |
| Windows SmartScreen 提示 | 当前安装包未配置 Authenticode 签名；确认来源为官方 Release 后选择「更多信息 → 仍要运行」 |
| Linux 缺少 FUSE | 用 `APPIMAGE_EXTRACT_AND_RUN=1` 启动 AppImage；MCP 桥仍会写到用户数据目录 |
| Linux 使用 `--dir` 自定义目录后无法冷启动 | 默认自动发现只包含 `~/Applications/AaBrowser.AppImage`。自定义目录不会自动写入桥的启动配置；在 MCP 客户端为桥设置 `AA_BROWSER_APP_PATH`，值为受支持 Aa Browser AppImage 的绝对文件路径，或先手动启动浏览器 |
| 客户端看不到工具 | 重启/重载客户端；确认配置写入路径和备份；运行 `node install.mjs --verify-only` 验证浏览器侧是否正常 |
| 浏览器未运行 | MCP 桥会在第一次 `tools/call` 时从受信安装路径自动拉起 Aa Browser，并等待最多 30 秒；找不到路径时设置 `AA_BROWSER_APP_PATH`，不需要自动启动时设置 `AA_BROWSER_AUTO_LAUNCH=0`；`--connect-only` 验证失败会明确报错 |
| 工具名带前缀 | 例如 `mcp__aa-browser__browser_tabs`，以客户端实际展示为准 |

## 安全边界

- 只从官方仓库 `yuchen0x1/aa-browser` 下载安装器；安装器校验 Release 的 SHA-256 与文件头。
- 安装器只修改 `aa-browser` 一个 MCP 条目，写入前备份原配置。
- 不写入任何 token/密码；提示词明确禁止 AI 输入或泄露秘密。
- 页面视图不挂 preload，MCP 服务只监听 `127.0.0.1` 并使用随机 token；详见 [README 安全说明](../README.md#安全说明)。

## 已验证范围

- Windows：安装包安装/运行/卸载、`--connect-only --verify --json`、`--print-config`、通用提示词渲染均有本地自动化测试（见 [维护状态](MAINTENANCE.md)）。
- Linux：由 CI 在 Ubuntu runner 上构建 AppImage 并运行打包后 MCP 冒烟与 connect-only 测试。
- 真实在线升级/回滚、代码签名仍需在发布后单独验收。
