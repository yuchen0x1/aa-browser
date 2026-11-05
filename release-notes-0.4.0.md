### WorkBuddy 安装与 MCP 接入补充（工作树改动，尚未发布）

- 新增 WorkBuddy 用户级 MCP 配置支持：`~/.workbuddy/mcp.json` 的 `mcpServers.aa-browser`，本地 stdio 运行已安装包内的 Electron bridge。
- 新增 `cli/workbuddy.mjs`，按 WorkBuddy 的 MCP 配置生成器约定准备配置；已有配置会先备份，只替换 `aa-browser` 项。
- `node install.mjs --repo yuchen0x1/aa-browser --clients workbuddy` 可选择 WorkBuddy 客户端配置目标。
- 更新 `PROMPT.md`，要求 WorkBuddy 实际调用 `browser_tabs` 和本地测试页步骤作为验收；未加载工具时必须报告未接通，不能用 WorkBuddy 自带 browser 代替。
- 本文档仅描述代码变化，不表示已在真实 WorkBuddy 会话验收或已发布新版本。
