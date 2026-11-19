# Aa Browser 平台指南

## 当前发行矩阵

| 平台 | 包 | 启动及 MCP | 更新与恢复 |
| --- | --- | --- | --- |
| Windows x64 | NSIS `.exe` | 原生窗口与快捷键。支持系统 Node.js，未安装时使用随包运行时 | 主界面检查、下载及确认重启。安装失败时可从 Releases 手动安装旧版 |
| Ubuntu 桌面 x86_64 | AppImage | Linux 窗口关联及 XDG 数据目录。MCP 需要系统 Node.js 22.12+ | 检查、下载及确认重启。替换前保留本机旧 AppImage |
| 其他发行版和架构 | 见评估表 | 兼容性需要实机验证 | 暂无独立发行渠道 |

浏览、查找、共享登录态与隔离标签、下载、历史、权限确认、跨会话标签恢复和 34 个 MCP 工具来自同一内核。Windows 和 Linux 使用各自系统的路径、应用标识及文件对话框。Windows 安装助手 `install.mjs` 负责 NSIS 安装和 WorkBuddy Connector 生成。Linux 用户直接启动 AppImage，再在「设置 → 连接 AI 客户端」中写入配置。独立 MCP 配置写入完成后需要重启客户端并成功调用 `browser_tabs`。

## 安装、卸载与恢复

**Windows**。从项目 Release 下载 `aa-browser-setup-<版本>.exe`，按常规向导安装。现有版本可使用应用内更新。卸载入口位于系统「已安装的应用」。桌面快捷方式和卸载项由 NSIS 管理。也可以把新标签页的通用接入提示词发给任意具备本机执行能力的 AI，由它自动完成下载、安装和 MCP 配置。

**Linux**。使用带 GTK 3、NSS、GBM 和音频库的 x86_64 桌面系统。应用需要 Chromium 沙箱可用。AppImage 由当前用户运行，并应放在当前用户可写的位置。通用安装器会把它安装到 `~/Applications/AaBrowser.AppImage`（可用 `--dir` 修改目录）；也可以手动下载后使用固定路径，方便桌面快捷方式跟随更新。

```sh
mkdir -p ~/Applications
mv aa-browser-0.1.0-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

如果系统没有可用的 FUSE 挂载，可在保持 Chromium 沙箱启用的情况下，通过 `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage` 启动。遇到沙箱错误，检查发行版对 Chromium 用户命名空间的应用级策略。MCP 写入路径使用 Electron 用户数据下的 `mcp/bridge.cjs`，更新后浏览器重启会刷新桥文件。

Linux 卸载时关闭应用并移除 AppImage 以及自行添加的启动器。Windows 和 Linux 用户都可以选择保留或备份 Electron 用户数据。Linux 为 XDG 配置目录下的 Aa Browser 用户数据，Windows 为用户 AppData。站点登录态及关键设置保存在 Chromium profile，临时连接描述文件默认位于 `~/.aabrowser/connection.json`。跨会话标签记录默认位于 `~/.aabrowser/session.json`（可用 `AA_BROWSER_SESSION_FILE` 覆盖），只保存普通网页地址，不含 Cookie、请求头或账号密码。移除程序后，如需移除 MCP 配置，只从各客户端中删除 `aa-browser` 条目。

Linux 应用内更新的旧文件保存在用户数据下的 `previous-versions/<版本>.AppImage`。新版本无法启动时，关闭残留进程，把需要的旧文件复制回安装目录，赋予执行权限并启动。Windows 可以重新安装原来的官方安装器。最好在尝试降级前复制用户数据。已登录会话可能受 Chromium 跨版本格式约束。

## 平台可行性

A 为直接维护，B 为适配后有明确价值，C 为延后，D 为受产品核心或平台限制排除。发行和设备验收证据见 [维护状态](MAINTENANCE.md)。

| 候选 | 级别 | 核心、体验及约束 | 开发和维护成本、分发更新 |
| --- | --- | --- | --- |
| Windows 11 x64 | A | Chromium 标签、MCP 和用户态安装可完整使用 | 低。现用 NSIS 与 GitHub 更新，CI 和本机覆盖 |
| Windows 10 x64 | A | 与 Windows 11 共享安装包。实际兼容随 Electron 与系统版本变化 | 低。还需要 Windows 10 实机升级验收 |
| Windows ARM64 | C | Chromium 可原生编译，需要 ARM64 依赖和设备确认 | 中。新增安装器、更新频道隔离和实机维护 |
| Linux / Ubuntu x86_64 | B | GTK/XDG 客户端，需可用用户命名空间，MCP 用系统 Node | 中。一份 AppImage 及 Linux 更新描述，Ubuntu Runner 可测 |
| Debian | C | AppImage 可试用，仍需确认 glibc/GTK、FUSE 和沙箱 | 中。独立 DEB 还需维护 apt 签名与升级策略 |
| Fedora | C | AppImage 与 RPM 可行，Wayland、沙箱和依赖需要验证 | 中。原生 RPM 需要签名仓库与跨版 CI |
| Arch Linux | C | 可直接试用 AppImage，滚动 ABI 需长期验收 | 中至高。AUR/Flatpak 发布和签名需额外维护 |
| macOS Intel | C | 能复用 Electron 核心，需增补 macOS 窗口生命周期、钥匙串和权限交互 | 高。Intel Runner、Developer ID、DMG、更新 ZIP、公证缺少 |
| macOS Apple Silicon | C | 交互同上，需 arm64 原生构建及相应实机 | 高。签名、公证、独立更新和设备未建立 |
| Android 手机 | C | 原生 WebView 可提供浏览核心，Electron/CDP 与 stdio MCP 需要重新设计 | 高。需 Kotlin UI、登录态、签名及商店或 APK 更新 |
| Android 平板 | C | 依赖 Android 内核和大屏标签管理 | 高。增加分屏与横竖屏矩阵 |
| Android 折叠屏 | C | 依赖 Android 平板布局及窗口姿态管理 | 高。需要真实双屏姿态与后台验证 |
| iOS | D | 普通 WebKit 沙盒无法直接运行现有 Electron、Node 或本机 stdio MCP | 高。重写后仍缺现有核心，需商店审核和签名 |
| iPadOS | D | 同 iOS，另有大屏窗口和多任务要求 | 高。需独立产品和商店分发 |
| 桌面 Web | D | 网页受跨源、凭据和浏览器权限限制，无法承载任意站点的原生标签及本机 MCP | 高。可做远程控制面，需服务端和权限重构 |
| 移动 Web | D | 移动浏览器增加后台及存储约束，远程桌面无法等效接管 | 高。无核心收益 |
| 响应式 Web | D | 响应式只改变控制面布局，核心权限限制同 Web | 高。部署更新无法补足核心 |
| PWA | D | 离线缓存和独立窗口仍受浏览器沙盒与同源约束 | 高。需独立网络后端，功能缺口仍在 |
| Chrome 扩展 | C | 可用标签/内容脚本和 native messaging，需另设宿主和授权 UI | 高。权限、商店与宿主更新双渠道 |
| Edge 扩展 | C | MV3 方案类似 Chrome，但各自商店和宿主部署 | 高。分发测试重复 |
| Firefox 扩展 | C | WebExtensions 和不同调试接口，快照/网络语义需改造 | 高。AMO 审查、独立 QA |
| Docker | C | 能容器化浏览器测试和 worker，可视接管及本机登录态隔离需另行设计 | 高。需环境隔离、显示和镜像更新 |
| NAS | C | 通常没有桌面，CPU/架构和 AppImage 需求不同 | 高。远程服务和权限需要新产品边界 |
| 私有化部署 | C | 本机桌面已经可离线运行。远程部署需身份、授权和多租户隔离 | 高。新增服务和持久化运维 |
| 云服务器 | C | 无本机桌面、文件与个人登录态，需要安全的远程会话和人工接管 | 高。需服务、部署与租户更新 |
| CLI | A | 现有 stdio bridge 与客户端配置工具与桌面版本同步，依靠桌面内核 | 低。随安装包、源码和协议合约一起维护 |
| DEB/RPM/Flatpak | C | 系统包可以便利安装，但会各自引入仓库信任、沙箱/文件访问和更新路径 | 中至高。等待跨发行版和签名后的实机验收 |

平台依据见 [Electron 45 发行说明](https://www.electronjs.org/blog/electron-45-0)、[electron-builder v26 AppImage](https://www.electron.build/v26/docs/appimage/) 和 [竞品调研](RESEARCH.md)。
