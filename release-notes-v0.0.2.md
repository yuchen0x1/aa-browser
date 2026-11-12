# Aa Browser v0.0.2

发布日期：2026-11-13

## 本次更新

- 新标签页提示词改为完整的安装与连接提示词，明确包含官方仓库、安装脚本、Windows PowerShell 命令、客户端重载和 `browser_tabs` 实际验证步骤。
- AI 连接状态移到工具栏左侧的高可见位置，状态文本和对比度更清晰，点击状态按钮可直接打开连接设置。
- 设置面板打开时扩展到完整窗口，便于查看客户端接入和软件更新选项。
- 修复真实点击事件偶发静默丢失的问题；复选框、单选框、对话框按钮和下载链接现在有页面点击兜底。
- 同步更新 README 和冒烟测试，覆盖安装提示词及上述交互回归。

## 验证

- `npm run check`
- `npm run build`
- `npm run smoke`
- `node --check scripts/smoke.mjs`
- `git diff --check`
