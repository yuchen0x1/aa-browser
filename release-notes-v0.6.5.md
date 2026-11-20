## 📢 版本概述

本版集中改善浏览器外壳的主题一致性、英文界面与键盘可访问性，并补齐工程回归防线：新增独立 lint、125% / 150% / 200% DPI 显示矩阵，清理 Electron 测试中的预期错误噪声。MCP 工具集保持 42 个，现有设置与浏览数据无需迁移。

## 🔧 改进与优化

- **主题与可读性**：统一浏览器外壳的主题色与控件状态，内部新标签页跟随主题；调整官网示意图文字对比度。
- **英文界面与来源语言**：补齐标签、下载、审批、AI 活动与客户端接入等界面文案；连接状态由 renderer 按当前语言生成，发行说明与错误详情明确标为发布者原文或来源语言。
- **键盘可访问性**：设置面板管理焦点并在关闭后恢复焦点；地址栏建议补充选项语义、选中状态与键盘操作。
- **独立 lint**：新增 `npm run lint`，使用 Biome 并纳入 `npm run check`；保留非阻断的既有风格诊断，不进行全仓格式化。
- **DPI 与显示器回归**：新增 `npm run test:display-matrix`，覆盖 125%、150%、200% 的 renderer 布局和显示器工作区窗口边界，并在多显示器可用时遍历显示器。

## 🐛 问题修复

- 更新 Electron `console-message` 事件读取方式，避免弃用接口噪声；初始化空白页的预期加载取消不再误报。
- favicon 的 CSP 明确允许 HTTP(S) 与 data 图片，避免合法站点图标触发外壳控制台错误；脚本策略保持不变。
- 设置校验失败保留错误反馈和原配置，不再通过 Electron IPC 打印预期输入错误堆栈。
- 冒烟测试区分主动清理隔离 Electron 与意外退出，避免正常结束被误报为退出失败。

## 🔒 安全与兼容性

- Agent 信息展示不再向 renderer 传递连接 token。
- MCP 工具数量及参数保持兼容；设置、历史、Cookie、下载与标签恢复数据沿用原存储。
- 本项目为开源软件；客户端代码可被读取，不应将其视作保密边界。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.6.5.exe` | Windows x64 | 安装程序，用于首次安装或覆盖升级 |
| `aa-browser-setup-0.6.5.exe.blockmap` | Windows x64 | 增量更新分块信息 |
| `latest.yml` | Windows x64 | 自动更新版本与校验元数据 |
| `aa-browser-0.6.5-linux-x86_64.AppImage` | Linux x86_64 | 免安装可执行文件 |
| `latest-linux.yml` | Linux x86_64 | 自动更新版本与校验元数据 |
| `sbom.cdx.json` | 全平台 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 全平台 | 发布文件 SHA-256 校验清单 |

- 首次安装：Windows 运行安装程序；Linux 为 AppImage 添加执行权限后从图形桌面启动。详见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.6.5/docs/PLATFORMS.md)。
- 已安装用户：在「设置 → 软件更新」检查升级，或下载安装包覆盖安装。

## 🔄 升级与数据迁移

- 可从 v0.6.4 覆盖升级，无需卸载，无需数据迁移。
- Linux 更新保留按版本命名的旧 AppImage；Windows 回退需重新安装旧版安装包。

## 🧪 验证结果

- 发布前本地已通过 `npm run check`、`npm run build`、`npm run smoke`、桌面回归 35 项及更新 UI 回归 9 项。
- DPI 矩阵 125% / 150% / 200% 通过；本机只有一块物理显示器，多显示器实际遍历未实测，测试会明确报告跳过。
- 双平台打包、安装后 MCP 验证与公开更新链路以本次标签触发的 CI 结果为准。

## ⚠️ 已知问题

- Windows 安装包未配置 Authenticode 代码签名，首次运行可能出现 SmartScreen 提示。
- lint 仍报告既有的非阻断 warnings / infos，不代表全仓已无风格问题。
- macOS、Android、iOS 与 Web 版不在支持范围内。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.5
