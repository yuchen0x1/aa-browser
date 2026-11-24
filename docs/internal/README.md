# 内部工作档案

本目录保存**面向维护者**的过程档案，不是产品文档：根目录只保留用户文档和构建入口，历史过程记录统一归档到这里；`README.md`、`docs/` 下的指南和站点都不会链接到这里。

| 文件 | 内容 |
|---|---|
| [PROJECT_AUDIT.md](./PROJECT_AUDIT.md) | 2026-11-16 的 v0.0.5 基线审计（历史档案） |
| [UPGRADE_REPORT.md](./UPGRADE_REPORT.md) | 2026-11-16 第一轮升级交付报告 |
| [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) | 40 项可验收升级路线图与取舍依据 |
| [COMPETITOR_ANALYSIS.md](./COMPETITOR_ANALYSIS.md) | 19 个同类项目的深度对标结论 |
| [2026-11-19-round2.md](./2026-11-19-round2.md) | 2026-11-19 第二轮（v0.2.0）升级交付报告 |
| [AUTONOMOUS_TASKS.md](./AUTONOMOUS_TASKS.md) | 自主开发待办与历史轮次归档 |
| [AUTONOMOUS_CHANGELOG.md](./AUTONOMOUS_CHANGELOG.md) | 自主开发过程记录与发行证据 |
| [AUTONOMOUS_ISSUES.md](./AUTONOMOUS_ISSUES.md) | 未解决问题与验证边界 |
| [PROJECT_STATUS.md](./PROJECT_STATUS.md) | 2026-11-24 项目状态快照 |
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | 2026-11-21 定向安全审查记录 |
| [RELEASE_HISTORY.md](./RELEASE_HISTORY.md) | v0.6.10–v0.17.0 正式发行核验记录 |

约定：

- 面向用户的版本历史仍以 [`docs/releases/release-notes.md`](../releases/release-notes.md) 和 `CHANGELOG.md` 为准；本目录的结论只在维护者之间流转。
- 新的轮次或审计报告放进本目录，文件名以日期开头，例如 `2026-12-01-round3.md`。
- 文档里的本机路径已脱敏；复现时以仓库内的命令和评测脚本为准。
