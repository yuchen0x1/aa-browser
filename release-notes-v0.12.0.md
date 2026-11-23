## 📢 版本概述

本次更新为 Aa Browser 增加等价于 Chrome「加载已解压的扩展程序」的本地扩展管理能力。用户可以从设置中选择 MV2 / MV3 扩展目录，也可以让 Agent 通过 `browser_extensions` 加载、列出和移除扩展；目录会在共享会话中生效并跨重启恢复。地址栏输入 `chrome://extensions` 会直接打开扩展管理区，既有 MCP 客户端配置和用户数据无需迁移。

## ✨ 新增功能

- **设置中的加载已解压扩展**：打开设置 → 扩展，点击「加载已解压的扩展程序…」，选择包含 `manifest.json` 的本地目录；支持 MV2 / MV3 并显示名称、版本和清单版本。
- **`browser_extensions` MCP 工具**：使用 `action=list` 查看已加载扩展，`action=load` 传入扩展目录绝对路径，`action=remove` 按扩展 id 或路径卸载。
- **跨重启恢复**：成功加载的目录写入 `~/.aabrowser/extensions.json`，下次启动会在首个标签创建前自动恢复；失效目录会被跳过并从列表清理。
- **扩展管理入口**：地址栏输入 `chrome://extensions` 会打开 Aa Browser 设置中的扩展分区，而不是停留在不可用的 Chrome 内部页。

## 🔧 改进与优化

- **共享会话隔离**：扩展装载到普通标签共用的持久会话，对之后打开或刷新的页面生效；隔离标签不装载共享扩展，避免跨会话注入。
- **清单与错误校验**：加载前校验目录、`manifest.json`、名称、版本和 MV2/MV3 清单版本；重复加载同一路径保持幂等并返回已有条目。
- **管理界面可访问性**：扩展列表提供名称、版本、清单版本和路径提示，支持中英文界面、键盘操作和单独移除。

## 🐛 问题修复

- 修复地址栏输入 `chrome://extensions` 时被普通网页导航策略拒绝的问题，现在会稳定打开扩展管理设置。
- 修复扩展恢复早于首个标签创建的启动时序，确保恢复的 content script 能在后续页面首载时注入。

## 🔒 安全与兼容性

- 扩展目录中的代码按 Chromium 扩展权限运行；只应加载用户信任的本地目录。Aa Browser 不提供扩展商店、账号同步或远程安装。
- 扩展注册表仅保存本机绝对路径；列表和诊断不会把扩展源码上传到网络。加载失败、缺失目录和损坏清单不会写入有效恢复记录。
- 既有 MCP 工具、客户端入口、设置、Cookie、下载和会话数据格式保持兼容；本版本无需重新接入客户端或手动迁移数据。
- Windows 安装包当前未配置 Authenticode 签名；GitHub Release 的不可变资产和 SHA-256 校验不能替代 Windows 代码签名。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.12.0.exe` | Windows x64 | NSIS 安装程序 |
| `aa-browser-setup-0.12.0.exe.blockmap` | Windows x64 | 增量更新块映射，不需手动运行 |
| `latest.yml` | Windows x64 | 应用更新元数据 |
| `aa-browser-0.12.0-linux-x86_64.AppImage` | Linux x86_64 | AppImage 应用 |
| `latest-linux.yml` | Linux x86_64 | 应用更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 校验和 |

首次安装及客户端接入参见[接入指南](https://github.com/yuchen0x1/aa-browser/blob/v0.12.0/docs/CONNECT.md)。已安装用户可通过应用内更新或下载本平台安装包升级。Linux 缺少 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1`。

## 🔄 升级与数据迁移

- **兼容性**：可直接覆盖升级；既有工具名称、参数和客户端入口保持可用，新增扩展管理参数为可选。
- **配置和数据**：保留现有设置、历史、Cookie、下载与会话数据；无需手动迁移。已加载扩展目录另存为 `~/.aabrowser/extensions.json`，升级后会继续恢复。
- **回退方式**：需要回退时先退出应用并备份本机配置、会话和 `extensions.json`，再从旧版正式发行取得安装包。旧版会忽略扩展注册表，不影响既有工具。

## 🧪 验证结果

- Windows 本地：`npm run check`、`npm run build` 和 `npm run test:extensions` 通过。
- 真实 Electron 扩展回归：`node scripts/test-extensions-e2e.mjs` 验证 MCP/UI 加载、content script 注入、注册表持久化与重启恢复；并使用 `C:\Users\lenmo\Desktop\linuxsb-scripts\linuxsb-plus\.output\chrome-mv3` 在 `https://linux.sb/topic/34104` 验证 `↑顶`、`①楼` 和蓝紫 SB 设置球。
- 未在本机执行真实 Linux AppImage 安装升级；跨平台打包、签名、安装生命周期和公开资产摘要以标签 CI 与 GitHub Release 核对结果为准。

## ⚠️ 已知问题

- 扩展加载后不会改写已经打开的页面；请刷新目标标签页或重新导航。隔离标签页不会装载共享会话扩展。
- Windows 安装包仍未配置 Authenticode 签名，首次下载请核对 GitHub Release 的 SHA-256 校验和。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.12.0<br>
**比较：** https://github.com/yuchen0x1/aa-browser/compare/v0.11.0...v0.12.0
