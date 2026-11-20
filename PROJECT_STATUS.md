# 项目状态

更新于 2026-11-21（UTC+8）。

- Aa Browser 是 Electron + TypeScript 桌面浏览器；本地 token WebSocket 连接主进程，MCP stdio 桥提供 42 个工具，官网是独立静态站点。
- 正式基线：[v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8)。本轮从远程 `main` / `e5554cd` 开始，初查 CI/CodeQL 成功、开放 CodeQL/Dependabot/secret-scanning 告警各 0；这是时间点结果而非无漏洞保证。
- 当前候选 v0.6.9：地址栏无损编辑、客户端精确取消和重复在途 ID、敏感输入/iframe 求值审批一致性、权限作用域与生命周期、证据身份核验及失败清理计账。无新依赖、数据迁移或 MCP schema 变更。
- 新的取消/权限/审批专项回归与桥自动启动加入 CI。Windows x64 与 Linux x64 打包、安装/启动、MCP 连接和七项发行资产由标签流水线验收；候选不等于已发布，最终状态见 [发行记录](RELEASE_HISTORY.md)。
- [能力盘点、七项目对照与路线](docs/project-review-20261121.md) 已更新。尚未量化的性能候选、桥并发建连/配置编辑等问题保持公开列入后续待办，不把本轮当作全项目完结。
- 原用户工作树仍保留未提交截图；代码、fixture、profile、证据和安装验证在隔离 worktree 内执行。

续接顺序：[待办](AUTONOMOUS_TASKS.md) → [开发记录](AUTONOMOUS_CHANGELOG.md) → [问题](AUTONOMOUS_ISSUES.md) → [安全](SECURITY_AUDIT.md) → [发行](RELEASE_HISTORY.md)。
