# 正式发布记录

历史发布正文见 [归档索引](docs/releases/release-notes.md)。本表只记录已核实的正式版本；候选不占用正式版本记录。

## v0.6.9 候选验收（尚未正式发布）

- 基线为远程 `main` / `e5554cd` 与正式 v0.6.8；本轮代码、版本与发行正文位于隔离工作树，未纳入原工作区截图。
- 本地 Windows：构建/check、45 项桌面、79 项 UI/UX、更新交互、MCP 冒烟、工具、国际化、114 项诊断、14 项打印、存储/更新器/安装器/发行/桥和官方 npm 审计通过；新增生产 handler 6 组、权限 12 组及真实 WS 取消回归通过。站点与四档 DPI 已通过。
- 串行 UI 复跑 79/79；此前并行运行有一次 hover=false，未删断言。符号链接创建在 Windows EPERM 跳过，junction 真实执行，文件错误为故障注入；媒体硬件、多物理显示器及真实打印输出未测。
- 本地 Windows 正式包与连接验证、双平台远程 CI/CodeQL、main 推送、精确新标签及公开七资产校验须全部完成后，才将本节转为正式发行记录。

| 正式版本 | 状态与证据 |
| --- | --- |
| [v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8) | 已发布（2026-11-21）。标签 CI `44796723617` 双平台测试与发布作业全部成功；7 项资产均含 sha256 摘要，`latest.yml` / `latest-linux.yml` 版本 0.6.8 与 tag、package.json 一致；发布正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.7](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.7) | 已发布。GitHub 列出 Windows NSIS 安装包及 blockmap、Linux AppImage、两平台更新元数据、SBOM 和 SHA256 清单，共 7 件资产。 |

后续发布：先验证候选提交的 CI 与安全状态，合并后在 `main` 祖先上使用精确版本标签；由现有标签 CI 构建并发布，再核对公开资产和版本一致性。
