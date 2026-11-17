# Changelog

产品版本历史以 [`docs/releases/release-notes.md`](./docs/releases/release-notes.md) 为准。

## 未发布 — 2026-11-17

- 新增界面语言设置，支持自动跟随系统或浏览器语言，并可手动选择简体中文或 English；选择会持久化并立即应用到核心浏览器壳层。

## v0.0.6 — 2026-11-16

- 安全：拒绝非 HTTP(S) 的外部导航协议，避免空白站点白名单放行本地或调试内容。
- 安全：GitHub Release 安装器对远程安装包执行 fail-closed SHA-256 digest 校验。
- 安全：高危审批开启时，`includeSensitive:true` 的网络详情和 HAR 导出需要人工确认。
- 工程：CI 增加按 workflow/ref 的并发控制、默认只读仓库权限和安全回归脚本。
- 文档：新增项目审计、19 个开源项目对标、40 项升级路线图和升级交付报告。

\n
