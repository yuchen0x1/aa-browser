## 📢 版本概述

本次安全与稳定性修订收紧了 AI 网络分析的响应体边界。`browser_network_detail` 现在会在主进程侧限制超大响应，并对默认返回的 JSON、表单和常见授权文本做内容级脱敏；既有扩展管理、MCP 工具和用户数据保持兼容。

## ✨ 新增功能

- **响应体大小治理**：文本和二进制响应在穿过 MCP 桥前最多保留 1 MiB，超限结果带有截断标记、原始大小和 MIME 类型摘要。
- **内容级默认脱敏**：JSON 中的 token、密码、Cookie、授权、支付字段，以及表单 / Bearer / Basic 凭据默认替换为 `[redacted]`。

## 🔧 改进与优化

- `browser_network_detail` 的 `body:true` 结果明确区分文本、二进制和截断响应，避免 Agent 把二进制 base64 当作可读正文。
- `includeSensitive:true` 保持显式能力；开启高危操作人工确认时仍先经过浏览器审批，默认路径不读取原始秘密到 MCP 响应。

## 🐛 问题修复

- 修复响应体默认只按字符截断、可能把 JSON 或授权文本中的敏感值原样交给 Agent 的边界问题。
- 修复 UTF-8 多字节文本在字节上限截断时可能产生半个字符的风险。

## 🔒 安全与兼容性

- 默认脱敏是内容级缓解措施，不是恶意 Agent 沙箱；页面、网络和登录态仍应只交给可信客户端。
- 没有新增 MCP 工具、运行依赖、配置字段或数据迁移；现有 `includeSensitive` 审批语义保持不变。
- Windows 安装包当前未配置 Authenticode 签名；请从官方 Release 核对 `SHA256SUMS.txt`。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.12.1.exe` | Windows x64 | NSIS 安装程序 |
| `aa-browser-setup-0.12.1.exe.blockmap` | Windows x64 | 增量更新块映射 |
| `latest.yml` | Windows x64 | 应用更新元数据 |
| `aa-browser-0.12.1-linux-x86_64.AppImage` | Linux x86_64 | AppImage 应用 |
| `latest-linux.yml` | Linux x86_64 | 应用更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 校验和 |

## 🔄 升级与数据迁移

- **兼容性**：可直接覆盖升级；既有 MCP 工具名称、参数、客户端配置和扩展注册表保持兼容。
- **配置和数据**：无需迁移；响应体治理只改变默认工具输出，不改写浏览器 profile、Cookie、历史或扩展目录。
- **回退方式**：回退前退出应用并备份用户数据；旧版会忽略本版本新增的响应体元数据，不影响既有配置。

## 🧪 验证结果

- Windows 本地：`npm run check`、`npm run build`、`npm run test:network-security`、`npm run smoke` 和 `npm run test:desktop` 通过。
- 专项回归覆盖 JSON/表单/Bearer 脱敏、1 MiB UTF-8 截断、二进制摘要和 `includeSensitive` 原文通道。
- 未在本机执行真实 Linux AppImage 安装升级、代码签名或旧版回滚；跨平台打包和公开资产以标签 CI 与 Release 核验为准。

## ⚠️ 已知问题

- 原始响应在 Chromium CDP 返回到主进程时仍可能短暂存在；本版本限制其进入 MCP/Agent 边界的大小，尚未完成 EV-014 所要求的捕获阶段敏感值内存分级存储。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.12.1
