## 📢 版本概述

Aa Browser v0.15.0 focuses on bounded renderer recovery and an auditable task lifecycle for orchestration. Crashed or unresponsive tabs now expose recovery state and perform a limited reload recovery without silently retrying forever.

## ✅ 主要变更

- 增加 Renderer/WebContents recovery 状态、恢复次数、原因、失败信息与状态通知。
- 对 `render-process-gone` 和 `unresponsive` 执行有限次数恢复，并在标签关闭时清理恢复计时器。
- 增加严格任务状态机：`pending`、`running`、`waiting`、`paused`、`interrupted`、`recovering`、`completed`、`failed`、`cancelled`。
- TaskCenter 记录任务历史、失败原因、重试上限；破坏性任务恢复需要显式确认，同时保持现有 MCP 调用记录兼容。
- 保持旧 MCP 客户端兼容，新 Tab recovery 字段为可选字段。

## ⚠️ 验证边界

完整构建、真实 Electron 崩溃恢复、Windows 安装包签名和跨平台 Release 资产由 GitHub Actions 在发布流程中验证；本地不得以未运行的测试冒充通过。

## 🔗 项目链接

- 项目主页：https://github.com/yuchen0x1/aa-browser
- Release：https://github.com/yuchen0x1/aa-browser/releases/tag/v0.15.0
