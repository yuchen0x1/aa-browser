# Aa Browser · 一键安装提示词

> 将下方代码块整段发给 WorkBuddy。目标是一条消息触发下载、安装、启动和 WorkBuddy MCP 配置，并由 WorkBuddy 实际验证工具；若 WorkBuddy 当前版本阻止配置或工具未加载，必须报告阻塞点，不得把安装成功说成连接成功。

## 发给 WorkBuddy

```text
请在这台 Windows 电脑上为我安装并接入 Aa Browser，并由你自己验证接入结果。请按顺序执行，不能用 WorkBuddy 内置 browser 工具代替 Aa Browser 工具，也不能仅凭配置文件存在就宣称成功。

1. 检查当前系统为 Windows x64，并检查 Node.js 20 或更高版本；如缺少 Node.js，先说明需要安装并征求我确认，不要静默安装系统级依赖。
2. 从官方仓库 https://github.com/yuchen0x1/aa-browser 获取 `install.mjs`，在独立临时目录保存后检查脚本来源和内容，不要从非官方地址下载或执行脚本。
3. 运行：`node install.mjs --repo yuchen0x1/aa-browser --clients workbuddy`
   该命令从 GitHub 最新已发布 Release 下载并安装 Aa Browser；安装器会校验安装包的 SHA-256（Release 提供 digest 时）并检查 PE 头，校验失败即中止。安装后尝试启动浏览器，并准备 WorkBuddy 用户级 MCP 配置 `~/.workbuddy/mcp.json` 及本地 Connector 文件。它不代表 WorkBuddy 已加载该配置。若命令失败，停止并报告真实错误，不要改写 WorkBuddy 数据库、插件缓存或其他内部文件。
4. 若 WorkBuddy 未自动加载工具，只能依据你确认过的 WorkBuddy 5.9.3 官方支持路径，在“专家·技能·连接器”中导入/启用生成的本地 Connector；不要假定 mcp.json 自动热加载，也不要编造刷新/重连操作。若当前版本不支持本地导入，报告此阻塞并停止。
5. 在当前会话中确认工具清单确实出现 Aa Browser 的 `browser_tabs`、`browser_navigate`、`browser_snapshot`。调用 `browser_tabs`；只有工具调用成功并返回 Aa Browser 标签信息，才能报告连接通过。若工具不存在，明确报告“安装完成但 WorkBuddy 未加载 Aa Browser MCP 工具”，附上配置路径和下一步人工操作。
6. 连接通过后才进行本地验证：从本次获取/克隆的 Aa Browser 仓库根目录定位 `scripts/test-page.html`，转为正确的 `file:///` URL 后用 `browser_navigate` 打开，再调用 `browser_snapshot`；在普通搜索框输入 `Aa Browser 测试` 并点击搜索按钮，确认结果文字。若本次安装流程没有提供仓库源码和测试页，明确报告无法执行此项，不要猜本机路径。不要访问其他网站，不要触碰真实账号，不要输入或提交密码、token、API key 或其他秘密。
7. 汇报安装目录、配置备份文件、是否生成/更新 WorkBuddy MCP 配置、browser_tabs 的实际结果、测试页各步骤结果，以及任何需要我手工完成的 WorkBuddy UI 步骤。
```

## 手动终端等效命令（仅在用户明确要求时）

```powershell
$tmp = Join-Path $env:TEMP 'aa-browser-bootstrap'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Invoke-WebRequest https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs -OutFile (Join-Path $tmp 'install.mjs')
node (Join-Path $tmp 'install.mjs') --repo yuchen0x1/aa-browser --clients workbuddy
```

## WorkBuddy 配置和限制

安装器为 WorkBuddy 配置 `~/.workbuddy/mcp.json` 中的 `mcpServers.aa-browser`，并在覆盖现有配置前生成 `*.aa-backup-*`。配置写入不等于工具已加载；最终验收必须由 WorkBuddy 实际调用 `browser_tabs`。若 WorkBuddy 的安全策略或版本要求在 UI 中确认 MCP，请由 WorkBuddy 指引用户完成确认后再继续。不要编辑 WorkBuddy 数据库、插件缓存或运行时配置。

其他支持 MCP 的客户端仍可使用：`node install.mjs --repo yuchen0x1/aa-browser`。不传 `--clients` 会接入安装器识别到的所有客户端。

## 发布者

`npm run dist` 按 `package.json` 版本生成 Windows 安装包；`--repo yuchen0x1/aa-browser` 只会获取最新已发布 GitHub Release，不会获取仓库未提交/未发布的 WorkBuddy 改动。使用本提示词前，必须确认最新 Release 已包含 WorkBuddy Connector 支持；否则远程安装器尚不具备这些改动。
