## 📢 版本概述

本版修复两个数据完整性问题：关闭窗口时标签会话可能被空记录覆盖、MCP 请求含 Unicode 行/段落分隔符时被误拆而超时；同时加固连接建立期间取消请求的竞态与页面脚本数据字面量。MCP 工具保持 42 个，已有用户数据无需迁移。

## 🐛 问题修复

- **标签会话丢失**：关闭主窗口时，最终会话保存在网页视图销毁之前执行，恢复记录保留普通标签的顺序与活动标签；隔离标签仍不进入恢复记录。
- **MCP 请求截断**：stdio 桥改为只按物理换行（LF）分帧；工具参数里的 U+2028/U+2029 不再被逐行读取器误当换行，导致请求截断超时。
- **取消竞态**：浏览器连接尚未建立时到达的取消通知会被记录，连接完成后不再向浏览器发送已取消的调用。
- **脚本数据字面量**：对话框应答策略与固定 iframe 动作（选择器 / 输入文本 / 选项值）统一复用既有 jsLiteral 编码，特殊字符不再破坏注入脚本；显式 `browser_frame evaluate` 语义不变。

## 🔒 安全与兼容性

- MCP 工具数量、名称与参数保持不变；设置、历史、Cookie、下载与会话数据无需迁移。
- 本项目为开源软件；客户端代码可被读取，不应将其视作保密边界。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.6.8.exe` | Windows x64 | 安装程序，用于首次安装或覆盖升级 |
| `aa-browser-setup-0.6.8.exe.blockmap` | Windows x64 | 增量更新分块信息 |
| `latest.yml` | Windows x64 | 自动更新版本与校验元数据 |
| `aa-browser-0.6.8-linux-x86_64.AppImage` | Linux x86_64 | 免安装可执行文件 |
| `latest-linux.yml` | Linux x86_64 | 自动更新版本与校验元数据 |
| `sbom.cdx.json` | 全平台 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 全平台 | 发布文件 SHA-256 校验清单 |

- 首次安装：Windows 运行安装程序；Linux 为 AppImage 添加执行权限后从图形桌面启动。详见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.6.8/docs/PLATFORMS.md)。
- 已安装用户：在「设置 → 软件更新」检查升级，或下载安装包覆盖安装。

## 🔄 升级与数据迁移

- 可从 v0.6.7 覆盖升级，无需卸载，无需数据迁移；既有数据沿用原存储。
- Windows 回退需重新安装旧版安装包；Linux 更新保留按版本命名的旧 AppImage。

## 🧪 验证结果

- 发布前本地 Windows 通过：构建、`npm run check`（类型检查 / lint / 42 工具契约 / 提示词一致性 / DSH 插件 / 页面脚本字面量 / 证据生命周期 / README 多语言 / 发行说明一致性）。
- 本地 Windows 回归：真实 Electron 桌面会话 36 项（新增「关窗保留标签顺序与活动标签」）、MCP 冒烟（含特殊字符往返断言）、桥离线回归 2 项（新增延迟握手取消）、桥自动启动、后端诊断 114 项，全部通过。
- 本地 Windows 打包 + 打包产物冒烟 + `--connect-only --verify` 通过；`npm audit`（官方源，high）0 漏洞。
- Windows x64 与 Linux x64 远程 CI（双平台打包验证、AppImage 启动 + MCP 连接、NSIS 静默安装→冒烟→卸载）以本次标签触发的 CI 结果为准。

## ⚠️ 已知问题

- Windows 安装包未配置 Authenticode 代码签名，首次运行可能出现 SmartScreen 提示。
- lint 仍报告既有非阻断 warnings / infos，不代表全仓已无风格问题。
- macOS、Android、iOS 与 Web 浏览器产品版不在支持范围内；配套官网为独立静态站。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.8
