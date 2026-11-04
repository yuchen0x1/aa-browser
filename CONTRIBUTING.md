# 贡献指南

感谢关注 Aa Browser！欢迎任何形式的贡献：bug 报告、功能讨论、文档改进、代码 PR。

## 开发环境

```bash
git clone https://github.com/yuchen0x1/aa-browser.git
cd aa-browser
npm install        # Electron 下载慢可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build
npm run dev        # 开发模式（渲染层热更新）
npm run smoke      # 端到端冒烟测试（31 项断言，无外网依赖）
```

要求：Node.js ≥ 20，Windows（macOS/Linux 可开发但安装包尚未支持）。

## 提交 PR 前

- `npm run typecheck` 与 `npm run smoke` 必须通过（CI 会自动跑）
- 新增 MCP 工具时同步更新：`src/main/tools.ts`、`cli/mcp.mjs` 工具定义、README 工具表
- 修改注入引擎（`src/snapshot/engine.js`）时注意保持**自包含**：函数体不得引用外部变量/import，主进程靠 `Function.prototype.toString()` 注入
- 动作/配置类改动请附带 smoke 断言

## 代码约定

- 主进程/渲染层用 TypeScript 严格模式；注入引擎为自包含 JS（原因见上）
- 提交信息使用 conventional commits（feat/fix/chore/docs…）
- 涉及用户配置文件写入的功能：必须备份、幂等、最小改动

## 报告 Bug

请附：Aa Browser 版本、复现步骤、`~/.aabrowser/error.log`（如有）、以及 Agent 侧收到的错误文本。
