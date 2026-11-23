# 项目状态

更新于 2026-11-21（UTC+8）。

- Aa Browser 是 Electron + TypeScript 桌面浏览器；本地 token WebSocket 连接主进程，MCP stdio 桥提供 42 个工具，官网是独立静态站点。
- 正式基线：[v0.6.12](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.12)（2026-11-21 发布，Latest、7 项不可变资产，标签 CI `44865353450` 双平台与发布作业全绿）。标签提交 `580566f` 的主线 CI/CodeQL 成功，开放扫描告警为 0。
- v0.6.10 修复：MCP 桥并发握手单飞与 socket 所有权、iframe 敏感值描述回显和冷启动回归 profile 清理竞态。
- v0.6.11 修复：设置面板代次隔离与输入法保护、一键接入客户端配置 JSONC/TOML 安全写入（新依赖 jsonc-parser、smol-toml）、discovery 文件权限加固、同毫秒下载 ID 冲突；无数据迁移或 MCP schema 变更。
- 发行链补全：v0.6.9 标签 CI 失败且未发布，其修复随 v0.6.10 一并发行；孤儿标签已于 2026-11-21 核验后删除（记录在 [问题](AUTONOMOUS_ISSUES.md)）。
- 新增延迟握手并发、连接生命周期和 frameElements 敏感值三项专项回归，并改进现有冷启动清理回归；均纳入 CI。Windows x64 与 Linux x64 打包、安装/启动、MCP 连接和发行资产由标签流水线验收；候选不等于已发布，最终状态见 [发行记录](RELEASE_HISTORY.md)。
- v0.6.12 修复：取消后副作用边界、App/CLI 备份保留与范围保护、JSONC 字节保真和 TOML EOF 幂等、自有目录收权；配置主诊断 159/159、取消 20/20（17 项真中途取消）和独立复审通过。
- [能力盘点、七项目对照与路线](../project-review-20261121.md) 已更新。快照分页全量元数据和历史同步写盘已量化；复杂配置编辑、权限策略迁移、性能优化和证据管理目录分离仍按问题表推进，不把本轮当作全项目完结。
- 原用户工作树仍保留未提交截图；代码、fixture、profile、证据和安装验证在隔离 worktree 内执行。

续接顺序：[待办](AUTONOMOUS_TASKS.md) → [开发记录](AUTONOMOUS_CHANGELOG.md) → [问题](AUTONOMOUS_ISSUES.md) → [安全](SECURITY_AUDIT.md) → [发行](RELEASE_HISTORY.md)。
