# Aa Browser v0.6.3

让首次使用更容易完成 AI 浏览器接入，并新增 Codex 客户端支持。

## 更新内容

- 新增首次启动 AI 接入向导：按步骤配置客户端、重启 AI，并发送可复制的连接测试提示词。
- 连接状态以 AI 成功调用 `browser_tabs(action=list)` 为准；仅写入配置或完成 MCP 握手不再误报为「AI 已连接」。
- 支持 Codex 桌面端、CLI 和 IDE，将 MCP 配置写入用户级 `~/.codex/config.toml`；自动备份原文件并保留其他设置。
- 新增 Codex 配置验证，检查现有 TOML 设置保留、原文件备份和重复执行幂等。

完整版本历史见 [发布说明](./docs/releases/release-notes.md)。

Windows 安装包尚未配置代码签名，SmartScreen 可能提示确认。
