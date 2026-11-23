# 正式发布记录

历史发布正文见 [归档索引](../releases/release-notes.md)。本表只记录已核实的正式版本；候选不占用正式版本记录。

## v0.6.12 正式发行（2026-11-21）

- 标签 `v0.6.12` 指向已确认的 `main` 提交 `580566fc15e966d192a1e5ced2175e7438ba7754`；标签 CI `44865353450` 的 Windows x64、Linux x64 与「Publish tested release」作业全部成功。
- 正式 Release 已发布为 Latest、非草稿、非预发布，资产不可变；`gh release verify` 的 GitHub 证明核验通过。
- 7 项公开资产（NSIS 安装包与 blockmap、AppImage、两平台更新元数据、SBOM、SHA256SUMS）均可下载，GitHub SHA-256 摘要与清单一致；SBOM 与 `latest*.yml` 版本均为 0.6.12。
- 主线 CI `44864527704`、CodeQL `44864527642` 成功；测量脚本告警 #13 已转 fixed，发布前开放扫描告警为 0。
- 本地 Windows 打包、实际安装→已安装程序 MCP 完整冒烟→卸载通过；原生 Linux/POSIX 权限与共享目录保护实测通过；独立复审无剩余阻断项。
- 发布正文已去除候选声明，归档 `bodies/v0.6.12.md`，同步索引与 EXPECTED_TAGS；没有移动已发布标签或覆盖不可变资产。

## v0.6.11 正式发行（2026-11-21）

- 标签 `v0.6.11` 指向 `main` / `b639787`；标签 CI `44852624681` 双平台测试与「Publish tested release」作业全部成功。
- 7 项资产（NSIS 安装包 + blockmap、AppImage、两平台 `latest*.yml`、SBOM、SHA256SUMS）已核对，`latest*.yml` 版本 0.6.11 与 tag、package.json 一致。
- 发行前本地 Windows 门槛：CI 同款 24 套回归全部通过（含新增 27 组设置/IME 安全回归、147 项主诊断）、NSIS 打包与 `release-assets prepare windows-x64` 校验、安装→MCP 冒烟→静默卸载实测；独立二审 P1/P2 零发现，依赖审计 0 漏洞。
- 首次打标签（`e8de8c0`）的发布作业因缺少根目录 `release-notes-v0.6.11.md` 候选稿在第一步失败，无任何内容发布；补候选稿后重打标签指向 `b639787`，与 v0.6.7 轮失败即移先例一致。
- 归档 `bodies/v0.6.11.md` 与线上正文一致；索引加行、EXPECTED_TAGS 增补 v0.6.11。

## v0.6.10 正式发行（2026-11-21）

- 标签 `v0.6.10` 指向 `main` / `8bfa1ae`；标签 CI `44844320267` 双平台测试与「Publish tested release」作业全部成功。
- 7 项资产（NSIS 安装包 + blockmap、AppImage、两平台 `latest*.yml`、SBOM、SHA256SUMS）已核对，`latest*.yml` 版本 0.6.10 与 tag、package.json 一致。
- 发行前本地 Windows 门槛复核：`check`、`build`、冷启动自动启动回归连续 3 次、桥离线 / 连接竞态 / 生命周期、iframe 敏感描述回归全部通过。
- 发布正文以标签候选稿为基础修正：移除「尚未创建 Release」的候选声明并补充本地复核证据；归档 `bodies/v0.6.10.md` 与线上正文一致。

| 正式版本 | 状态与证据 |
| --- | --- |
| [v0.6.12](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.12) | 已发布（2026-11-21），Latest。标签 CI `44865353450` 双平台与发布作业成功；7 项不可变资产、GitHub Release 证明、SHA-256 清单、SBOM 与更新元数据校验通过。 |
| [v0.6.11](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.11) | 已发布（2026-11-21）。标签 CI `44852624681` 双平台与发布作业成功；7 项资产与版本元数据一致；CodeQL 通过、依赖审计 0 漏洞；正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.10](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.10) | 已发布（2026-11-21）。标签 CI 双平台与发布作业成功；7 项资产与版本元数据一致；正文归档通过 `check:release-bodies:remote`。含 v0.6.9 未发行修复。 |
| [v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8) | 已发布（2026-11-21）。标签 CI `44796723617` 双平台测试与发布作业全部成功；7 项资产均含 sha256 摘要，`latest.yml` / `latest-linux.yml` 版本 0.6.8 与 tag、package.json 一致；发布正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.7](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.7) | 已发布。GitHub 列出 Windows NSIS 安装包及 blockmap、Linux AppImage、两平台更新元数据、SBOM 和 SHA256 清单，共 7 件资产。 |

后续发布：先验证候选提交的 CI 与安全状态，合并后在 `main` 祖先上使用精确版本标签；由现有标签 CI 构建并发布，再核对公开资产和版本一致性。
