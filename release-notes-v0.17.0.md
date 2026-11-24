## 📢 版本概述

Aa Browser v0.17.0 改进公开 GitHub Release 安装包的下载体验：优先使用 GitHub 官方线路，依据实际传输情况判断超时、中断或持续低速，再按策略尝试可用代理线路。安装前仍必须通过受信任的摘要与文件大小校验。

## ✨ 新增功能

- **线路智能切换**：以 GitHub 官方线路为首选；连接超时、持续低速或传输中断后，按线路评分尝试 GH-Proxy 与备用线路。下载速度按实际响应数据测量，不以 Ping 代替；切换带有超时、重试上限和冷却时间。
- **断点续传**：线路中断后保留有效临时数据，使用 HTTPS Range 请求续传；恢复的部分文件仍需匹配原始 URL、受信任大小和摘要。
- **安装器下载回退**：`install.mjs --repo yuchen0x1/aa-browser` 可在公开 GitHub Release 下载失败时切换线路，并以 GitHub API 返回的公开资产摘要和大小校验文件。

## 🔒 安全与兼容性

- **可信校验**：应用内更新的 `SHA256SUMS.txt` 必须由 GitHub 官方主机提供，仅允许跳转到 GitHub 官方资产 CDN；SHA-256 清单、更新元数据中的文件大小和 SHA-512 必须一致。校验失败不会交给安装器，现有版本保持不变。
- **凭据隔离**：只为公开 Aa Browser Release 文件启用代理线路；仅使用 HTTPS 和受限重定向主机，不向第三方代理发送 GitHub Token、Cookie 或其他身份请求头。
- **完整包下载**：应用内更新关闭 blockmap 差分下载，使重试、续传和完整性校验共用同一下载路径。更新将下载完整安装包，可能比增量更新消耗更多流量和时间。
- **兼容性**：保留原有版本检查、进度界面、确认后安装、安装失败重试及 Linux AppImage 回退流程；不改变用户数据格式。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.17.0.exe` | Windows x64 | NSIS 安装包，未配置 Authenticode 签名 |
| `aa-browser-setup-0.17.0.exe.blockmap` | Windows x64 | electron-updater 发布元数据资产；应用内更新不再使用 blockmap 差分下载 |
| `latest.yml` | Windows x64 | 更新元数据 |
| `aa-browser-0.17.0-linux-x86_64.AppImage` | Linux x86_64 | AppImage；Linux 验证范围限 Ubuntu 24.04 CI/Xvfb |
| `latest-linux.yml` | Linux x86_64 | 更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX SBOM |
| `SHA256SUMS.txt` | 通用 | GitHub Release 文件 SHA-256 清单 |

- 已安装用户：可在「设置 → 软件更新」下载后确认重启安装，也可从本页手动安装。
- 回退：Windows 可重新安装旧版官方安装包；Linux AppImage 更新保留上一版本副本，恢复前请备份用户数据。

## 🧪 验证结果

- `npm run check`、`npm run build` 和 `npm run dist -- --publish never` 通过；Windows x64 更新元数据的版本、文件名、大小和 SHA-512 经 `release-assets prepare windows-x64` 校验。
- GitHub 下载模拟测试 13/13、Electron 更新器模拟测试 7/7、安装器下载测试 6/6、更新状态测试 14/14、更新界面测试 9/9、发布校验测试 5/5 通过。
- Windows x64 解包应用通过完整 MCP 冒烟与 `install.mjs --connect-only --verify` 的隔离验证。
- 这些测试不代表中国大陆网络速度，也不等同于完整 Release 大文件下载；大陆网络和完整包真实下载没有独立环境验证。

## ⚠️ 已知限制

- GH-Proxy 和备用线路是公开第三方服务，不提供本项目可依赖的 SLA；全部线路失败时应用保留当前版本并显示下载错误。
- Windows 安装包未 Authenticode 签名，首次运行可能出现 SmartScreen 提示。
- Linux 真实桌面发行版覆盖范围仍限 Ubuntu 24.04 CI/Xvfb。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.17.0
