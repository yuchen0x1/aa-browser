# 正式发布记录

历史发布正文见 [归档索引](../releases/release-notes.md)。本表只记录已核实的正式版本；候选不占用正式版本记录。

## v0.13.0 正式发行（2026-11-23）

- 标签 `v0.13.0` 指向已确认的 `main` 提交 `ea6905c64abc624347515681744c85e2a0ca9326`；标签 CI `45099078476` 的 Linux x64、Windows x64 重跑与「Publish tested release」作业全部成功。首次标签运行因两个旧生产工具夹具未 mock 新增 `./cloudflare` 依赖而失败，补齐夹具后同一标签重跑通过。
- 正式 Release 已发布为 Latest、非草稿、非预发布且不可变；7 项公开资产（NSIS 安装包与 blockmap、AppImage、两平台更新元数据、SBOM、SHA256SUMS）均已上传，GitHub 资产摘要与 `SHA256SUMS.txt` 一致，`latest*.yml` 和 SBOM 版本为 0.13.0。
- 主线 CI `45099071924`、CodeQL `45099072444` 与发布维护核验 `45100035811` 成功；`npm run check:release-bodies:remote` 通过，28 个版本的正文归档与线上 Release 一致。
- 标签流水线完成跨平台构建、Linux AppImage/MCP 冒烟和 Windows NSIS 安装→MCP→卸载验证；本机与 CI 均未额外宣称 Authenticode、真实第三方 Cloudflare 挑战、旧版升级/回滚或 Linux 实机安装。
- 本版本新增 `browser_cloudflare` 人在回路验证辅助；不读取或注入 challenge token，不修改 Cookie、请求头或网络响应，滑块/图片/Turnstile 仍由用户完成。

## v0.12.1 正式发行（2026-11-23）

- 标签 `v0.12.1` 指向已确认的 `main` 合并提交 `c915abca482c1e562f75c45fb689105150669a60`；标签 CI `45094994167` 的 Windows x64、Linux x64 与「Publish tested release」作业全部成功。
- 正式 Release 已发布为 Latest、非草稿、非预发布；7 项公开资产（NSIS 安装包与 blockmap、AppImage、两平台更新元数据、SBOM、SHA256SUMS）均已上传，GitHub 资产摘要与 `SHA256SUMS.txt` 一致，`latest*.yml` 和 SBOM 版本为 0.12.1。
- 主线 CI `45094923063` 与 CodeQL `45094923087` 成功；`npm run check:release-bodies:remote` 通过，27 个版本的正文归档与线上 Release 一致。
- 标签流水线完成跨平台构建、Linux AppImage/MCP 冒烟和 Windows NSIS 安装→MCP→卸载验证；本机未额外宣称 Authenticode 签名、真实旧版升级/回滚或 Linux 实机安装。
- 本版本完成 EV-013：响应体在主进程侧按 1 MiB 字节上限治理并默认内容级脱敏；EV-014 的捕获阶段敏感值内存分级仍列为后续工作。

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
| [v0.13.0](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.13.0) | 已发布（2026-11-23），Latest。标签 CI `45099078476` 双平台与发布作业成功；7 项资产、SHA-256 清单、SBOM、更新元数据与远程正文归档校验通过。首次运行的夹具失败已在同标签重跑前修复。 |
| [v0.12.1](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.12.1) | 已发布（2026-11-23），Latest。标签 CI `45094994167` 双平台与发布作业成功；7 项资产、SHA-256 清单、SBOM、更新元数据与远程正文归档校验通过。 |
| [v0.6.12](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.12) | 已发布（2026-11-21），Latest。标签 CI `44865353450` 双平台与发布作业成功；7 项不可变资产、GitHub Release 证明、SHA-256 清单、SBOM 与更新元数据校验通过。 |
| [v0.6.11](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.11) | 已发布（2026-11-21）。标签 CI `44852624681` 双平台与发布作业成功；7 项资产与版本元数据一致；CodeQL 通过、依赖审计 0 漏洞；正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.10](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.10) | 已发布（2026-11-21）。标签 CI 双平台与发布作业成功；7 项资产与版本元数据一致；正文归档通过 `check:release-bodies:remote`。含 v0.6.9 未发行修复。 |
| [v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8) | 已发布（2026-11-21）。标签 CI `44796723617` 双平台测试与发布作业全部成功；7 项资产均含 sha256 摘要，`latest.yml` / `latest-linux.yml` 版本 0.6.8 与 tag、package.json 一致；发布正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.7](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.7) | 已发布。GitHub 列出 Windows NSIS 安装包及 blockmap、Linux AppImage、两平台更新元数据、SBOM 和 SHA256 清单，共 7 件资产。 |

后续发布：先验证候选提交的 CI 与安全状态，合并后在 `main` 祖先上使用精确版本标签；由现有标签 CI 构建并发布，再核对公开资产和版本一致性。
