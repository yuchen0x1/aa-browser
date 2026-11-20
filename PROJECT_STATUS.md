# 项目状态

更新于 2026-11-21。

- Aa Browser 是 Electron + TypeScript 桌面浏览器；本地 WebSocket 连接主进程，MCP 通过 stdio 桥提供 42 个工具。官网是独立静态站点。
- 正式基线：[v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8)（2026-11-21 发布，7 项资产，CodeQL 中危 #11/#12 已在新扫描中关闭）。`main` 基线 `afc27db` 的 CI 和 CodeQL 均成功执行。
- 本轮交付 `v0.6.8`：修复关闭窗口时的会话保存顺序与 MCP stdio 消息误分帧，加固对话框策略及固定 iframe 动作的脚本字面量，经 PR #13 双平台 CI 合并并完成标签发布。
- Windows 和 Linux x64 的打包、安装/启动、MCP 验证及发布资产上传由 `.github/workflows/ci.yml` 负责。

续接顺序：[待办](AUTONOMOUS_TASKS.md) → [开发记录](AUTONOMOUS_CHANGELOG.md) → [问题](AUTONOMOUS_ISSUES.md) → [安全](SECURITY_AUDIT.md) → [发行](RELEASE_HISTORY.md)。
