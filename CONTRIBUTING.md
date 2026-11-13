# 贡献指南

感谢关注 Aa Browser！欢迎任何形式的贡献：bug 报告、功能讨论、文档改进、代码 PR。

## 开发环境

```bash
git clone https://github.com/yuchen0x1/aa-browser.git
cd aa-browser
npm install        # Electron 下载慢可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build
npm run dev        # 开发模式（渲染层热更新）
npm run smoke      # MCP 端到端冒烟测试，本地测试页面
npm run test:desktop # 原生 Electron 界面、查找、恢复与隐私回归
npm run test:stores  # 设置/历史容错、原子写入与异常备份
npm run test:updater # 更新器调度/状态测试（模拟更新源，不访问网络）
npm run test:release # 发布标签/草稿/资产回归（模拟 GitHub API）
```

要求：Node.js ≥ 20，Windows（macOS/Linux 可开发但安装包尚未支持）。

## 提交 PR 前

- `npm run check`、`npm run build`、`npm run smoke`、`npm run test:desktop`、`npm run test:stores`、`npm run test:updater` 与 `npm run test:release` 必须通过（CI 会自动跑）
- 新增 MCP 工具时同步更新：`src/main/tools.ts`、`cli/mcp.mjs` 工具定义、README 工具表
- 修改注入引擎（`src/snapshot/engine.js`）时注意保持**自包含**：函数体不得引用外部变量/import，主进程靠 `Function.prototype.toString()` 注入
- 动作/配置类改动请附带 smoke 断言

## 代码约定

- 主进程/渲染层用 TypeScript 严格模式；注入引擎为自包含 JS（原因见上）
- 提交信息使用 conventional commits（feat/fix/chore/docs…）
- 涉及用户配置文件写入的功能：必须备份、幂等、最小改动

## 报告 Bug

请附：Aa Browser 版本、复现步骤、Electron userData 目录中的 `error.log`（如有）、以及 Agent 侧收到的错误文本。

## 测试数据与界面截图

两套端到端测试都在仓库 `.local-verification/` 下使用独立 profile、服务发现文件、设置、历史和下载目录，不连接日常使用的 Aa Browser。桌面测试保留各次运行的 `result.json` 便于定位问题；此目录不会入库。

默认桌面回归不依赖 Windows 截图合成器。需要更新实际界面截图时，在可见桌面上运行：

```powershell
$env:AA_DESKTOP_SCREENSHOTS = '1'
npm run test:desktop
Remove-Item Env:AA_DESKTOP_SCREENSHOTS
```

截图写入 `docs/screenshots/page-find-toolbar.png`；被遮挡或无可见桌面的 Windows 环境可能导致 Chromium 截图失败，该次运行会报告失败。
