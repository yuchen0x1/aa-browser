## 📢 版本概述

本次更新新增 Cloudflare 验证辅助，解决普通浏览器控制无法观察跨域挑战窗口的问题。Agent 可以检查挑战状态、定位可见复选框并等待页面完成；真实点击仍需用户明确确认，滑块和图片挑战继续由用户手动完成。

## ✨ 新增功能

- **`browser_cloudflare` 工具**：使用 `action=inspect` 检查当前标签的 Cloudflare 挑战，枚举可见的跨域 iframe、`frameId` 和复选框 `candidateIndex`。
- **显式真实点击**：使用 `action=click` 与 `confirm:true` 对可见复选框发送一次真实鼠标事件；使用 `action=wait` 等待挑战稳定消失。
- **安全脱敏**：挑战 URL 中的查询令牌会在 MCP 输出中脱敏，普通跨域 iframe 不会被误判为 Cloudflare。

## 🔧 改进与优化

- Cloudflare 验证辅助与现有标签解析、页面队列、操作审批和 DSH 桥保持一致，无需额外服务进程或远程 WebSocket。
- README、MCP 工具契约、DeepSeek Harness 桥和完整边界文档同步更新。

## 🐛 问题修复

- 修复 Cloudflare 验证控件位于跨域 iframe 时，普通页面快照无法判断挑战是否仍在进行的问题。
- 修复 iframe 内复选框坐标需要叠加宿主 iframe 屏幕偏移才能发送真实点击的问题。

## 🔒 安全与兼容性

- 不读取、生成或注入 Cloudflare challenge token，不导出 Cookie，也不修改请求头或网络响应。
- 只允许对 `challenges.cloudflare.com` 的可见复选框执行一次点击；滑块、图片验证码和 Turnstile 必须由用户完成。
- `click` 默认拒绝，必须传入 `confirm:true`；开启高危操作人工确认时还会经过 Aa Browser 审批面板。
- 没有新增运行依赖、配置字段或数据迁移；Windows 安装包当前未配置 Authenticode 签名，请从官方 Release 核对 `SHA256SUMS.txt`。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.13.0.exe` | Windows x64 | NSIS 安装程序 |
| `aa-browser-setup-0.13.0.exe.blockmap` | Windows x64 | 增量更新块映射 |
| `latest.yml` | Windows x64 | 应用更新元数据 |
| `aa-browser-0.13.0-linux-x86_64.AppImage` | Linux x86_64 | AppImage 应用 |
| `latest-linux.yml` | Linux x86_64 | 应用更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 校验和 |

## 🔄 升级与数据迁移

- **兼容性**：可直接覆盖升级；既有 MCP 客户端配置、标签数据和工具调用保持兼容。
- **配置和数据**：无需迁移；Cloudflare 辅助不会改写浏览器 profile、Cookie、历史或网络数据。
- **回退方式**：回退前退出应用并备份用户数据；旧版不会识别 `browser_cloudflare`，但既有工具和配置不受影响。

## 🧪 验证结果

- Windows 本地：`npm run check`、`npm run build` 和 `npm run test:cloudflare` 通过；专项测试覆盖普通 iframe 过滤、挑战域名识别、真实鼠标事件、iframe 坐标叠加、令牌脱敏和显式确认。
- 未在本机对真实第三方 Cloudflare 防护站点执行挑战；跨平台打包、安装、公开资产和 Release 不可变证明以本次标签 CI 为准。

## ⚠️ 已知问题

- Cloudflare 滑块、图片验证码、Turnstile 以及需要额外交互的挑战不会自动完成，请直接在浏览器页面中操作后再调用 `action=wait`。
- 真实挑战可能因站点风控、网络或浏览器环境变化而要求额外验证；本工具不绕过 Cloudflare 的风控策略。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.13.0
