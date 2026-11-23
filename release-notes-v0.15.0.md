## 📢 版本概述

Aa Browser v0.15.0 focuses on bounded renderer recovery and an auditable task lifecycle for orchestration. Crashed or unresponsive tabs now expose recovery state and perform a limited reload recovery without silently retrying forever. This release publishes Windows x64 assets only; Linux is temporarily held back after a Linux desktop regression failed in release CI.

## ✅ 主要变更

- 增加 Renderer/WebContents recovery 状态、恢复次数、原因、失败信息与状态通知。
- 对 `render-process-gone` 和 `unresponsive` 执行有限次数恢复，并在标签关闭时清理恢复计时器。
- 增加严格任务状态机：`pending`、`running`、`waiting`、`paused`、`interrupted`、`recovering`、`completed`、`failed`、`cancelled`。
- TaskCenter 记录任务历史、失败原因、重试上限；破坏性任务恢复需要显式确认，同时保持现有 MCP 调用记录兼容。
- 保持旧 MCP 客户端兼容，新 Tab recovery 字段为可选字段。

## ⚠️ 验证边界

Windows 桌面回归与安装包冒烟已在标签 CI 中通过；真实 Electron 崩溃恢复和 Windows 代码签名仍未验证。Windows 安装包未签名，安装时可能出现 SmartScreen 提示。Linux 打包与桌面验证已从 v0.15.0 移除，待回归修复后在后续版本恢复。

## 🔗 项目链接

- 项目主页：https://github.com/yuchen0x1/aa-browser
- Release：https://github.com/yuchen0x1/aa-browser/releases/tag/v0.15.0

## 📦 发布资产

- `aa-browser-setup-0.15.0.exe`（Windows x64，未签名）
- `aa-browser-setup-0.15.0.exe.blockmap`
- `latest.yml`
- `sbom.cdx.json`
- `SHA256SUMS.txt`
