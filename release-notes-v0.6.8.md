## 📢 版本概述

本次修订解决关闭主窗口后标签会话丢失的问题，并修复 MCP 桥处理 Unicode 行分隔符时的请求超时。

## 🐛 问题修复

- **标签会话**：关闭窗口时，在销毁网页视图前保存可恢复标签的顺序和当前标签。隔离标签仍不会进入恢复记录。
- **MCP 消息**：stdio 只按物理换行分帧，文本中的 Unicode 行、段落分隔符不再截断 JSON 请求；桥的输出也兼容使用逐行读取的客户端。

## 🔒 安全与兼容性

- 对话框策略和固定 iframe 动作使用统一的脚本字面量编码，保留选择器、输入与选项的原文。显式 iframe 求值语义不变。
- MCP 工具保持 42 个。现有配置、历史、会话和下载数据无需迁移。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
| --- | --- | --- |
| `aa-browser-setup-0.6.8.exe` | Windows x64 | NSIS 安装包 |
| `aa-browser-0.6.8-linux-x86_64.AppImage` | Linux x64 | AppImage |

发布页还提供更新元数据、校验清单和 SBOM。可按 [README](https://github.com/yuchen0x1/aa-browser#快速开始) 安装或在应用内检查更新。

## 🧪 验证结果

- Windows：真实 Electron 桌面会话回归、MCP 冒烟及桥离线回归通过，覆盖 Unicode 内容来回传输和原生窗口关闭；本地 Windows 打包、打包产物冒烟和 `--connect-only --verify` 通过。
- 正式安装资产及签名状态以该标签的 Windows/Linux CI 验证结果为准。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues
