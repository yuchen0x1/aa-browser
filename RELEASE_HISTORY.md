# 正式发布记录

历史发布正文见 [归档索引](docs/releases/release-notes.md)。本表只记录已核实的正式版本；候选不占用正式版本记录。

## v0.6.10 正式发行（2026-11-21）

- 标签 `v0.6.10` 指向 `main` / `8bfa1ae`；标签 CI `44844320267` 双平台测试与「Publish tested release」作业全部成功。
- 7 项资产（NSIS 安装包 + blockmap、AppImage、两平台 `latest*.yml`、SBOM、SHA256SUMS）已核对，`latest*.yml` 版本 0.6.10 与 tag、package.json 一致。
- 发行前本地 Windows 门槛复核：`check`、`build`、冷启动自动启动回归连续 3 次、桥离线 / 连接竞态 / 生命周期、iframe 敏感描述回归全部通过。
- 发布正文以标签候选稿为基础修正：移除「尚未创建 Release」的候选声明并补充本地复核证据；归档 `bodies/v0.6.10.md` 与线上正文一致。

| 正式版本 | 状态与证据 |
| --- | --- |
| [v0.6.10](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.10) | 已发布（2026-11-21）。标签 CI 双平台与发布作业成功；7 项资产与版本元数据一致；正文归档通过 `check:release-bodies:remote`。含 v0.6.9 未发行修复。 |
| [v0.6.8](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8) | 已发布（2026-11-21）。标签 CI `44796723617` 双平台测试与发布作业全部成功；7 项资产均含 sha256 摘要，`latest.yml` / `latest-linux.yml` 版本 0.6.8 与 tag、package.json 一致；发布正文归档通过 `check:release-bodies:remote`。 |
| [v0.6.7](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.7) | 已发布。GitHub 列出 Windows NSIS 安装包及 blockmap、Linux AppImage、两平台更新元数据、SBOM 和 SHA256 清单，共 7 件资产。 |

后续发布：先验证候选提交的 CI 与安全状态，合并后在 `main` 祖先上使用精确版本标签；由现有标签 CI 构建并发布，再核对公开资产和版本一致性。
