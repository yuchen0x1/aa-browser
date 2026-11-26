## 📢 版本概述

v0.18.1 是维护版本，新增可预览的本地构建与验证产物清理命令。它只处理可重建输出和没有被文档引用的临时验证目录，不改动浏览器运行行为、用户数据格式或更新机制。

## ✨ 新增功能

- **本地产物清理**：运行 `npm run clean:artifacts` 查看清理计划；确认后追加 `-- --apply` 才会执行。命令保留旧版更新夹具、成功的真实旧版更新提示证据、维护文档提及的验证目录、根级日志、依赖和发布产物。

## 🔧 改进与优化

- 新增回归测试，验证清理范围、默认预览行为，以及历史证据、用户数据、`node_modules/` 和 `release/` 不会被删除。
- 删除旧版根目录 Release Notes 副本；历史正文以 `docs/releases/bodies/` 中与 GitHub Release 核对的归档为准。
- Windows x64 与 Linux x86_64 继续使用既有稳定版更新源和应用内更新提示。

## 🐛 问题修复

- 修复本地重复 Electron 验证运行目录长期累积、难以安全清理的问题；现在只会列出未被文档引用的直接子目录供维护者选择清理。

## 🔒 安全与兼容性

- 清理命令默认只预览，执行时仅接受仓库内指定的 `out/` 和 `.local-verification/` 子目录；不跟随链接目录，不触碰浏览器个人数据。
- 本版本没有应用运行时安全策略或用户数据格式变更。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.18.1.exe` | Windows x64 | NSIS 安装包，未配置 Authenticode 签名 |
| `aa-browser-setup-0.18.1.exe.blockmap` | Windows x64 | 发布元数据；应用内更新使用完整包 |
| `latest.yml` | Windows x64 | 稳定版更新元数据 |
| `aa-browser-0.18.1-linux-x86_64.AppImage` | Linux x86_64 | AppImage；验证范围限 Ubuntu 24.04 CI/Xvfb |
| `latest-linux.yml` | Linux x86_64 | 稳定版更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 清单 |

- 首次安装：Windows 运行安装器；Linux 为 AppImage 增加执行权限后启动。接入步骤见 [安装与 MCP 指南](https://github.com/yuchen0x1/aa-browser/blob/main/docs/CONNECT.md)。
- 已安装用户：在「设置 → 软件更新」检查并按提示下载、确认重启安装；关闭自动检查的用户可手动检查。

## 🔄 升级与数据迁移

- **兼容性**：沿用 v0.18.0 的应用标识、安装方式和稳定更新源，可直接覆盖升级。
- **配置和数据**：浏览器个人数据、登录态、Profile、设置和 MCP 配置格式均不变，不需要迁移。
- **回退方式**：回退前先关闭应用并备份 `.aabrowser` 与 Electron userData；旧版本无法管理新版本之后创建的数据格式。

## 🧪 验证结果

- `npm run check`：静态检查、现有回归和新增本地产物清理保护测试通过。
- Release CI：Windows x64 与 Ubuntu 24.04 桌面测试、安装包构建、安装/卸载及发布资产校验通过。

## ⚠️ 已知问题

- Windows 安装包没有 Authenticode 签名，可能出现 SmartScreen 提示；Linux 验证范围限 Ubuntu 24.04 CI/Xvfb，不代表所有发行版或物理多显示器。
- 自动清理只处理仓库忽略的本地构建和验证产物；不会删除 `release/`、`node_modules/`、根级日志或任何个人浏览器数据。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.18.1
