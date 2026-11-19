# Aa Browser 自动更新

Windows NSIS 与 Linux AppImage 使用 [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases) 和 `electron-updater`。开发版和 Linux 解包后二进制模式关闭应用内更新。通过 AppImage 运行时，只有当前文件目录可写才可原地替换。

## 查找和安装

打开「设置 → 软件更新」手动检查或开启自动检查和下载。自动模式约在启动 5 秒后检查，此后每 15 分钟补查，窗口恢复和网络恢复会触发限流补查。失败时按 1、5、15 分钟退避。设置提供稳定版/Beta 通道，Beta 资产由实际发布决定。

主界面显示可用版本、下载进度、速度和失败状态。详细版本、日期、大小及变更日志在更新状态提示中。点击「稍后」会收起当前阶段的提示。下载完成后只有用户确认「重启安装」才交给系统安装器。安装失败需用户重新确认。

更新从官方仓库通过 HTTPS 获取。electron-updater 在交付安装前按平台更新描述验证 SHA-512。每个 Release 也附 `SHA256SUMS.txt` 与 CycloneDX `sbom.cdx.json`；SBOM 覆盖应用组件和 npm 依赖树，并同样计入 SHA-256 清单。从 v0.1.0 起，GitHub 不可变 Release 会对标签、提交及资产生成密码学发行证明，可以独立验证任意下载文件。

```sh
gh release verify v0.1.0 --repo yuchen0x1/aa-browser
gh release verify-asset v0.1.0 ./aa-browser-0.1.0-linux-x86_64.AppImage --repo yuchen0x1/aa-browser
```

应用内 SHA-512 比对和 `gh` 发行证明验证是两个流程。Windows Authenticode 签名需要配置证书，目前无证书。未来启用 Windows 签名时，应在 `WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD` 配置发行证书，在首次签名安装包及后续签名更新之间验证发布者校验。代码签名与首次信任建立需单独验收。

安装 AppImage 前会将运行中的版本保存至 Electron 用户数据的 `previous-versions/<版本>.AppImage`。运行旧文件、Windows 重新安装旧版以及数据兼容检查见 [恢复步骤](PLATFORMS.md#安装卸载与恢复)。恢复由用户发起。退回旧版本时可以先暂停自动检查。

## 发布

1. 在短期分支同步更新 `package.json`、lockfile、`release-notes-vX.Y.Z.md`、版本历史和 README。
2. 两平台 CI 通过后合并，确认仓库的不可变 Release 已启用。
3. 从通过 CI 的 `main` 提交创建并推送 `vX.Y.Z` 标签。
4. 标签 CI 打包并启动两平台产物，验证安装包/更新描述的版本、文件名、大小和 SHA-512，构建 SHA-256 清单。仅当两平台均通过时才在 `release` 环境上传草稿资产。
5. 草稿资产经 GitHub API 摘要检查后公开。正式版本的标签及资产由 GitHub 锁定。草稿中已有资产若摘要不同，应从原通过的 run 恢复已验证产物或排查草稿，原公开版本始终保留。SBOM 在发布 job 内由同一提交的 lockfile 生成，并进入 `SHA256SUMS.txt` 与资源集校验。
6. Release maintenance 检查公开链接、版本元数据、摘要和发行证明。

建议在发版前保存老版本安装包，并在独立测试 profile 上完成一次升级和恢复。CI 的更新 UI 用模拟 provider 验证交互。打包冒烟会启动实际安装目录或 AppImage 并调用 MCP。完整的已验证证据见 [维护状态](MAINTENANCE.md)。
