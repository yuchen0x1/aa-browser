# 项目状态

更新于 2026-11-21（UTC+8）。

- Aa Browser 是 Electron + TypeScript 桌面浏览器；本地 token WebSocket 连接主进程，MCP stdio 桥提供 42 个工具，官网是独立静态站点。
- 正式基线：[v0.6.10](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.10)（2026-11-21 发布，7 项资产，标签 CI 双平台与发布作业全绿；包含 v0.6.9 未发行的全部修复）。`main` 基线 `8bfa1ae` 的 CI/CodeQL 已成功。
- v0.6.10 修复：MCP 桥并发握手单飞与 socket 所有权、iframe 敏感值描述回显和冷启动回归 profile 清理竞态；无新依赖、数据迁移或 MCP schema 变更。
- 发行链补全：v0.6.9 标签 CI 因 Linux `ENOTEMPTY` 失败且未发布，其修复随 v0.6.10 一并发行；孤儿标签处置已记录在 [问题](AUTONOMOUS_ISSUES.md)。
- 新增延迟握手并发、连接生命周期和 frameElements 敏感值三项专项回归，并改进现有冷启动清理回归；均纳入 CI。Windows x64 与 Linux x64 打包、安装/启动、MCP 连接和发行资产由标签流水线验收；候选不等于已发布，最终状态见 [发行记录](RELEASE_HISTORY.md)。
- [能力盘点、七项目对照与路线](docs/project-review-20261121.md) 已更新。尚未量化的性能候选、客户端配置编辑、分页快照和证据管理目录分离仍公开列入后续待办，不把本轮当作全项目完结。
- 原用户工作树仍保留未提交截图；代码、fixture、profile、证据和安装验证在隔离 worktree 内执行。

续接顺序：[待办](AUTONOMOUS_TASKS.md) → [开发记录](AUTONOMOUS_CHANGELOG.md) → [问题](AUTONOMOUS_ISSUES.md) → [安全](SECURITY_AUDIT.md) → [发行](RELEASE_HISTORY.md)。
