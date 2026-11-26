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
npm run test:page-scripts # 注入脚本字面量转义回归（ref 白名单、特殊字符不被截断）
npm run test:desktop # 原生 Electron 界面、查找、恢复与隐私回归
npm run test:update-ui # 更新提示/后台下载/重试交互（模拟 provider，不运行安装器）
npm run test:stores  # 设置/历史容错、原子写入与异常备份
npm run test:updater # 更新器调度/状态测试（模拟更新源，不访问网络）
npm run test:release # 发布标签/草稿/资产回归（模拟 GitHub API）
npm run test:agent-cancellation # 真实回环 WS：同号/重复请求、精准取消、连接重建
npm run test:session-permissions # 生产权限策略：隔离会话、媒体子能力、文档失效（模拟 Electron）
npm run test:approval-parity # 生产工具 handler：敏感输入与求值审批（模拟页面/审批边界）
node scripts/test-workflows.mjs # 生产工作流：依赖、加密输入、崩溃检查点与副作用恢复
```

要求使用 Node.js 22.12 或更高版本。Windows 和 Ubuntu 的打包及支持状态见 [平台指南](docs/PLATFORMS.md)。

日常维护直接在默认主分支 `main` 迭代，先完整验证再提交和推送；有未提交用户工作时使用隔离 worktree，不覆盖现场，不制造长期开发分支。外部贡献仍可通过 PR 审查。发布提交须通过两平台 CI 和适用安全检查，禁止强推覆盖历史。发布标签采用新的 `vX.Y.Z`，指向 `main` 上匹配 `package.json` 的提交；紧急修复同样经过验证并使用新版本号。

## 提交 PR 前

- `npm run check`、`npm run build`、`npm run smoke`、`npm run test:desktop`、`npm run test:stores`、`npm run test:updater` 与 `npm run test:release` 必须通过（CI 会自动跑）
- MCP 定义唯一来源是 `src/shared/tool-defs.mjs`，不要在桥里复制 schema；主进程增加 handler，README 工具表同步登记，运行 `npm run check:tools` 与 `npm run test:tools`
- 修改注入引擎（`src/snapshot/engine.js`）时注意保持**自包含**：函数体不得引用外部变量/import，主进程靠 `Function.prototype.toString()` 注入
- 动作/配置类改动请附带 smoke 断言

## 代码约定

- 主进程/渲染层用 TypeScript 严格模式；注入引擎为自包含 JS（原因见上）
- 提交信息使用 conventional commits（feat/fix/chore/docs…）
- 涉及用户配置文件写入的功能：必须备份、幂等、最小改动
- Profile 路由使用 `ProfileManager` 的异步上下文，禁止用可变全局“当前 Profile”替代；旧版 `persist:aa-main` 必须保持可读
- 工作流复用既有受保护工具，不绕过审批、标签队列或 Profile 租约；调度意图先持久化，可能产生副作用的中断步骤不能自动重放
- 文件读写经过统一文件策略；日志和测试产物不得包含真实 Cookie、密码或 token
- 架构与扩展边界见 [架构说明](docs/ARCHITECTURE.md)，安全约束见 [安全模型](docs/SECURITY_MODEL.md)

## 报告 Bug

请附：Aa Browser 版本、复现步骤、Electron userData 目录中的 `error.log`（如有）、以及 Agent 侧收到的错误文本。

## 仓库文件管理

- 源码、测试、图标、客户端配置模板和 `package-lock.json` 需要提交；`node_modules/`、`out/`、`release/` 等生成目录不入库。
- 临时审计报告、调试输出、测试 profile 和下载产物统一放在 `.local-verification/`。运行 `npm run clean:artifacts` 预览可清理项，追加 `-- --apply` 执行；文档引用的证据、成功的真实旧版更新提示证据和旧版更新夹具会保留。需要清理本地打包输出时追加 `--include-release`；`node_modules/` 和个人浏览器数据不在清理范围。
- `.env`、本机 MCP 配置、浏览器用户数据和签名私钥不入库；环境示例文件只能包含占位符。
- 维护过程记录、审计和历史状态快照统一放在 `docs/internal/`，根目录不再堆放已归档的轮次文档。
- `docs/releases/release-notes.md` 保留正式版本历史；发布流程直接读取 `docs/releases/bodies/v<版本>.md`，根目录不再保留重复正文。历史正文也可从对应 Git 标签查看。
- 推送前检查 `git status --short` 和 `git diff --cached --stat`；忽略规则不会自动移除已经被 Git 跟踪的文件。

## 测试数据与界面截图

两套端到端测试都在仓库 `.local-verification/` 下使用独立 profile、服务发现文件、设置、历史和下载目录，不连接日常使用的 Aa Browser。桌面测试保留各次运行的 `result.json` 便于定位问题；此目录不会入库。

默认桌面回归不依赖 Windows 截图合成器。需要更新实际界面截图时，在可见桌面上运行：

```powershell
$env:AA_DESKTOP_SCREENSHOTS = '1'
npm run test:desktop
Remove-Item Env:AA_DESKTOP_SCREENSHOTS
```

截图写入本次运行的 `.local-verification/desktop-<时间戳>-<进程号>/page-find-toolbar.png`，与 `result.json` 保存在一起，不入库；被遮挡或无可见桌面的 Windows 环境可能导致 Chromium 截图失败，该次运行会报告失败。
