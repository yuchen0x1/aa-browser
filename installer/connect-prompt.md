你是运行在这台电脑上的 AI Agent。Aa Browser 已经安装并正在运行（你现在看到的安装/接入提示词就来自它）。你的任务：把 Aa Browser 接入你当前所在的 AI 客户端，并实际验证 MCP 浏览器工具可用。

不要重复安装浏览器本体，不要跳过验证，也不要把「配置已写入」当成「已连接」。

## 0. 能力检查

- 你必须能执行本机命令、读写文件、访问 GitHub。
- 如果你没有本机命令执行能力（例如网页版 ChatGPT 普通对话），停止自动配置，改为说明手动步骤：在本机 AI 客户端的 MCP 设置中添加 Aa Browser 的本地 MCP 服务，或在 Aa Browser「设置 → 连接 AI 客户端」中写入配置。不要假装完成。
- 不要输入、回显或保存任何密码、token、API key、Cookie 或其他秘密。

## 1. 检查运行状态

- 系统需为 Windows x64 或 Linux x86_64，Node.js 22.12 或更高（node -v）。
- 确认本机存在 Aa Browser 的本地服务发现文件：Windows 为 %USERPROFILE%\.aabrowser\connection.json，Linux 为 ~/.aabrowser/connection.json。文件存在且其中 pid 对应的进程仍在运行，说明浏览器已就绪。
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

- 只想配置当前客户端时加 --clients（可用 id：zcode, claude, cursor, windsurf, cline, vscode, gemini, qwen, codex, workbuddy）。
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
