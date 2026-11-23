# 项目状态

更新于 2026-11-23（UTC+8）。

- Aa Browser 是 Electron + TypeScript 桌面浏览器；本地 token WebSocket 连接主进程，MCP stdio 桥提供 47 个工具，官网是独立静态站点。
- v0.14.0 候选新增五种真实窗口模式、独立实时预览、人工接管和多客户端任务中心；后台拖拽已使用 Chromium 原生 `dragIntercepted` 数据，最小化导航、点击、输入、滚动、拖放和截图均有真实 Electron/MCP 回归证据；Windows 30 分钟 soak 与 DPI 100%–200% 已通过。
- v0.13.0 新增 `browser_cloudflare`：识别 `challenges.cloudflare.com` 跨域挑战 iframe、在显式 `confirm:true` 后发送一次真实复选框点击，并等待挑战完成；不绕过滑块、图片或 Turnstile，也不处理 challenge token。
- v0.12.1 正式收紧网络响应体：`browser_network_detail` 在主进程侧限制 1 MiB，文本/二进制结果结构化，JSON、表单和常见授权凭据默认内容级脱敏；EV-014 的捕获阶段内存分级仍待后续。
- 最新已发布基线：[v0.13.0](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.13.0)（2026-11-23）；标签 CI、跨平台安装/MCP 冒烟、公开资产与远程正文校验均已通过。v0.14.0 尚未发布，不能提前改写本节。
- v0.6.10 修复：MCP 桥并发握手单飞与 socket 所有权、iframe 敏感值描述回显和冷启动回归 profile 清理竞态。
- v0.6.11 修复：设置面板代次隔离与输入法保护、一键接入客户端配置 JSONC/TOML 安全写入（新依赖 jsonc-parser、smol-toml）、discovery 文件权限加固、同毫秒下载 ID 冲突；无数据迁移或 MCP schema 变更。
- 发行链补全：v0.6.9 标签 CI 失败且未发布，其修复随 v0.6.10 一并发行；孤儿标签已于 2026-11-21 核验后删除（记录在 [问题](AUTONOMOUS_ISSUES.md)）。
- 新增延迟握手并发、连接生命周期和 frameElements 敏感值三项专项回归，并改进现有冷启动清理回归；均纳入 CI。Windows x64 与 Linux x64 打包、安装/启动、MCP 连接和发行资产由标签流水线验收；正式版本状态见 [发行记录](RELEASE_HISTORY.md)。
- v0.6.12 修复：取消后副作用边界、App/CLI 备份保留与范围保护、JSONC 字节保真和 TOML EOF 幂等、自有目录收权；配置主诊断 159/159、取消 20/20（17 项真中途取消）和独立复审通过。
- [能力盘点、七项目对照与路线](../project-review-20261121.md) 已更新。快照分页全量元数据和历史同步写盘已量化；复杂配置编辑、权限策略迁移、性能优化和证据管理目录分离仍按问题表推进，不把本轮当作全项目完结。
- 原用户工作树仍保留未提交截图；代码、fixture、profile、证据和安装验证在隔离 worktree 内执行。

续接顺序：[待办](AUTONOMOUS_TASKS.md) → [开发记录](AUTONOMOUS_CHANGELOG.md) → [问题](AUTONOMOUS_ISSUES.md) → [安全](SECURITY_AUDIT.md) → [发行](RELEASE_HISTORY.md)。
