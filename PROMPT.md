# Aa Browser 通用安装与接入提示词

> 一段提示词，适用于 Windows x64 / Linux x86_64 上的任意具备本机执行能力的 AI 客户端（WorkBuddy、ZCode、Codex/ChatGPT 桌面端、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、DeepSeek Harness 等）。
>
> 不需要先手动下载 App：把「一」整段发给 AI，它会自动下载、安装并写入 MCP 配置。
> 已经从 GitHub Releases 下载并打开了 Aa Browser：把「二」整段发给 AI，它会只接入并验证，不重复安装。
>
> 网页版 ChatGPT 等没有本机命令执行能力的环境无法自动安装，提示词会要求 AI 明确说明并给出手动步骤，不会假装成功。

## 一、本机还没安装 Aa Browser

把下面整段发给 AI。

```text
你是运行在某台电脑上的 AI Agent。你的任务：在这台电脑上安装 Aa Browser（如果尚未安装），把它接入你当前所在的 AI 客户端，并实际验证 MCP 浏览器工具可用。

严格遵守下面的步骤和判定标准。不要跳过验证，不要把「配置文件已写入」「安装器退出码为 0」当成「连接成功」。

## 0. 先做能力检查（必须）

- 你必须能：执行本机命令、读写文件、访问 GitHub。
- 如果你没有本机命令执行能力（例如网页版 ChatGPT 的普通对话），立即停止自动安装，改为输出「手动安装指引」（下载链接 + 各客户端配置方法），并明确说明：当前环境不能自动安装本机软件，需要换成具备本机执行能力的桌面客户端、CLI 或 Agent 环境。不要假装安装。
- 不要输入、回显、写入或上传任何密码、token、API key、Cookie 或其他秘密；不要访问真实账号做测试。

## 1. 系统与依赖检查

- 官方支持：Windows x64、Linux x86_64。macOS、Windows ARM64、其他架构目前没有官方安装包：停止自动安装，说明不支持的平台，并给出源码运行方式或等待后续版本，不要强行安装。
- 检查 Node.js：运行 node -v，要求 22.12 或更高。若缺失或过低：请用户确认后再安装（Windows 可用 winget install OpenJS.NodeJS.LTS；Linux 用发行版包管理器），不要静默安装系统级依赖。
- 确认能访问 https://github.com 和 https://raw.githubusercontent.com。

## 2. 下载并检查官方安装器

- 官方仓库：https://github.com/yuchen0x1/aa-browser
- 官方安装器：https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs
- 把安装器保存到临时目录，确认下载地址与上面的仓库完全一致，不要执行其他来源的脚本。

Windows PowerShell：

  $tmp = Join-Path $env:TEMP 'aa-browser-bootstrap'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Invoke-WebRequest https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -OutFile (Join-Path $tmp 'install.mjs')
  node (Join-Path $tmp 'install.mjs') --repo yuchen0x1/aa-browser --yes --verify --json

Linux / macOS 终端（仅 Linux）：

  mkdir -p /tmp/aa-browser-bootstrap
  curl -fsSL https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -o /tmp/aa-browser-bootstrap/install.mjs
  node /tmp/aa-browser-bootstrap/install.mjs --repo yuchen0x1/aa-browser --yes --verify --json

安装器会按顺序完成：选择当前平台的官方 Release 资产 → 校验 SHA-256 与文件头 → 安装（Windows NSIS / Linux AppImage）→ 启动 → 检测并备份后写入本机 AI 客户端的 MCP 配置 → 调用 browser_tabs 验证。

- 安装完成后即使用户关闭 Aa Browser，MCP 桥在 AI 第一次调用浏览器工具时也会从受信安装路径自动启动它并等待连接；可用 `AA_BROWSER_APP_PATH` 指定绝对路径，或用 `AA_BROWSER_AUTO_LAUNCH=0` 禁用。找不到受信路径时会明确报错，不执行任意命令。

- --json 会在标准输出给出机器可读结果（ok、version、installDir、bridge、clients、verified）。请读取它并据此判断，不要只看退出码。
- 默认会自动检测并写入本机已安装的 AI 客户端。只想配置当前客户端时，加 --clients 参数（可用 id：zcode, claude, cursor, windsurf, cline, vscode, gemini, qwen, opencode, codex, workbuddy；DeepSeek Harness 使用 deepseek-harness 仅输出插件市场手动接入指引）。不确定时用默认自动检测。
- DeepSeek Harness 是插件式手动接入：在插件市场安装/启用 Aa Browser 插件，再让 Agent 实际调用 `mcp__aa-browser__browser_tabs`；安装器不会修改 `.dsh` 配置、数据库或缓存。
- 如果当前客户端不在自动检测列表：先运行 node install.mjs --print-config，得到 aa-browser 的 MCP 启动配置；再按当前客户端官方文档的 MCP 配置格式写入。不要猜测配置文件路径或格式；找不到时向用户索要，并报告「需要手动添加」。

## 3. 让当前 AI 客户端加载新配置

- 安装器写入配置后，重启或重新加载当前 AI 客户端（具体方式以该客户端官方说明为准）。
- 如果客户端要求导入/启用本地 MCP/Connector（例如 WorkBuddy 的「专家·技能·连接器」），按官方流程完成；不要修改客户端数据库、缓存或内部运行时文件。

## 4. 实际验证（关键）

- 先确认工具列表里出现 browser_tabs、browser_navigate、browser_snapshot。不同客户端会加命名前缀（例如 mcp__aa-browser__browser_tabs），以实际名称为准。
- 然后实际调用 browser_tabs（或运行 node install.mjs --verify）。
- 成功标准：返回 Aa Browser 的标签列表（至少包含当前标签 URL/标题）。只有达到这个标准，才能报告「已连接」。
- 失败时如实报告：安装是否完成、配置写到了哪个文件（含备份路径）、当前卡在哪一步、真实错误信息，以及用户需要手动做什么。

## 5. 自动更新说明

- Aa Browser 本体通过 GitHub Releases 自动检查并提示更新，安装更新后自动重启。
- MCP 配置指向稳定的桥接文件，应用升级后一般无需重写配置；MCP 桥随应用版本一起更新。
- 如果升级后工具消失：重新运行同一个安装器命令（幂等，会备份配置）或运行 node install.mjs --connect-only --verify。不要删除用户配置。

## 6. 最终汇报格式

请按以下格式汇报，全部使用真实结果：

- 系统：Windows/Linux + 架构；Node.js 版本
- 安装：安装目录；版本号；是否本次新装
- 配置：写入的客户端与配置文件路径；备份文件路径
- 验证：browser_tabs 的真实返回（或失败原因）
- 自动更新：是否已启用/如何更新
- 阻塞与手动步骤：没有就写「无」
- 安全：确认没有输入或泄露任何秘密

如果任何一步失败，停止后续步骤并如实报告，不要用模拟结果或猜测填补。
```

## 二、已经下载并打开 Aa Browser

Aa Browser 新标签页里也显示这段提示词，点「复制接入提示词」即可。把整段发给 AI。

```text
你是运行在这台电脑上的 AI Agent。Aa Browser 已经安装（你现在看到的安装/接入提示词就来自它）。你的任务：把 Aa Browser 接入你当前所在的 AI 客户端，并实际验证 MCP 浏览器工具可用。

不要重复安装浏览器本体，不要跳过验证，也不要把「配置已写入」当成「已连接」。

## 0. 能力检查

- 你必须能执行本机命令、读写文件、访问 GitHub。
- 如果你没有本机命令执行能力（例如网页版 ChatGPT 普通对话），停止自动配置，改为说明手动步骤：在本机 AI 客户端的 MCP 设置中添加 Aa Browser 的本地 MCP 服务，或在 Aa Browser「设置 → 连接 AI 客户端」中写入配置。不要假装完成。
- 不要输入、回显或保存任何密码、token、API key、Cookie 或其他秘密。

## 1. 检查运行状态

- 系统需为 Windows x64 或 Linux x86_64，Node.js 22.12 或更高（node -v）。
- 确认本机存在 Aa Browser 的本地服务发现文件：Windows 为 %USERPROFILE%\.aabrowser\connection.json，Linux 为 ~/.aabrowser/connection.json。文件存在且其中 pid 对应的进程仍在运行，说明浏览器已就绪；如果文件暂时不存在，MCP 桥在第一次 tools/call 时会按受信安装路径自动启动 Aa Browser 并等待连接。
- 如果 Node.js 缺失：请用户确认后安装，不要静默安装系统依赖。

## 2. 获取官方安装器（只用于写入配置，不重复安装）

官方仓库：https://github.com/yuchen0x1/aa-browser
官方安装器：https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs

Windows PowerShell：

  $tmp = Join-Path $env:TEMP 'aa-browser-bootstrap'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Invoke-WebRequest https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -OutFile (Join-Path $tmp 'install.mjs')
  node (Join-Path $tmp 'install.mjs') --connect-only --yes --verify --json

Linux 终端：

  mkdir -p /tmp/aa-browser-bootstrap
  curl -fsSL https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -o /tmp/aa-browser-bootstrap/install.mjs
  node /tmp/aa-browser-bootstrap/install.mjs --connect-only --yes --verify --json

--connect-only 会跳过下载和安装，只做三件事：确认 Aa Browser 已就绪、备份并写入本机 AI 客户端的 MCP 配置、实际调用 browser_tabs 验证。--json 输出机器可读结果（ok、version、installDir、bridge、clients、verified）。

- 只想配置当前客户端时加 --clients（可用 id：zcode, claude, cursor, windsurf, cline, vscode, gemini, qwen, opencode, codex, workbuddy；DeepSeek Harness 使用 deepseek-harness 仅输出插件市场手动接入指引）。
- DeepSeek Harness 只能通过插件市场安装/启用 Aa Browser 插件；安装器不会修改 `.dsh` 配置、数据库或缓存。启用后让 Agent 实际调用 `mcp__aa-browser__browser_tabs` 验证。
- 当前客户端不在自动检测列表时：运行 node install.mjs --print-config，把输出按该客户端官方 MCP 配置格式写入；找不到路径就向用户索要，不要猜。

## 3. 重载客户端并验证

- 重启或重新加载当前 AI 客户端；如果它要求导入/启用本地 MCP/Connector，按官方流程完成。
- 确认工具列表出现 browser_tabs（可能带客户端前缀，如 mcp__aa-browser__browser_tabs），并实际调用。
- 成功标准：browser_tabs 返回 Aa Browser 的标签列表。只有达到该标准才能报告「已连接」。
- 失败时报告：已写入的配置路径与备份、真实错误、需要用户手动完成的步骤。

## 4. 自动更新

- Aa Browser 通过 GitHub Releases 自动更新，升级后 MCP 配置与桥接路径保持稳定，一般无需重写配置。
- 如果升级后工具消失，重新运行上面的 --connect-only 命令（幂等，会先备份配置），或运行 node install.mjs --verify 单独诊断。

## 5. 最终汇报

- 系统与 Node.js 版本
- Aa Browser 版本与安装目录
- 写入的客户端、配置文件与备份路径
- browser_tabs 的真实返回（或失败原因）
- 自动更新状态与后续更新方式
- 阻塞与手动步骤（没有写「无」）
- 确认没有输入或泄露任何秘密
```

## 三、支持的平台与客户端

- 官方安装包：Windows x64（NSIS 安装器）、Linux x86_64（AppImage）。
- macOS、Windows ARM64 和其他架构目前没有官方安装包；安装器会明确拒绝，不会假装安装。
- 自动写入配置的客户端：ZCode、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、OpenCode、Codex（桌面端 / CLI / IDE）、WorkBuddy。
- DeepSeek Harness：通过插件市场安装/启用 Aa Browser 插件手动接入；安装器不会修改 `.dsh` 配置、数据库或缓存，启用后实际调用 `mcp__aa-browser__browser_tabs` 验证。
- 其他支持 MCP 的客户端：运行 `node install.mjs --print-config` 获取启动配置，按该客户端官方 MCP 文档添加。

## 四、自动更新

- Aa Browser 通过 GitHub Releases 自动检查、下载并在用户确认后安装更新。
- MCP 配置指向稳定桥接路径，应用升级后一般无需重写；MCP 桥随应用版本更新。
- 升级后如果工具消失，重新运行 `node install.mjs --connect-only --verify`（幂等，会先备份配置）。

## 五、安全

- 只从官方仓库 `yuchen0x1/aa-browser` 下载安装器；安装器校验 Release 的 SHA-256 与文件头。
- 安装器写入配置前会备份原文件，只修改 `aa-browser` 一个 MCP 条目。
- 不要输入或泄露密码、token、API key、Cookie；不要用真实账号做验证。
