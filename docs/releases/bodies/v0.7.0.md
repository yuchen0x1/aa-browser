## 📢 版本概述

本次更新新增可共享的 AI 连接诊断，保护手动导出的证据文件，改进 MCP 快照内部传输和标签切换的焦点可靠性，并补齐 Linux 默认 AppImage 路径冷启动与精确 SBOM 元数据。保持 42 个 MCP 工具和现有客户端入口，没有新增运行依赖，不要求手动迁移数据。

## ✨ 新增功能

- **AI 连接诊断**：「设置 → AI 集成 → Agent 本地服务」显示启动、连接、首调用验证和桥文件状态，并提供下一步建议。可展开本机连接详情；共享诊断只包含版本、平台、状态和连接数，不包含路径、端口、令牌、配置或浏览数据。

## 🔧 改进与优化

- **MCP 文本快照**：不再将完整结构化元素数组重复传回主进程。分页、元素引用、动作定位和快照文本不变；引擎默认结构化输出保留。3,000 按钮、60 页 Windows 夹具中，未压缩返回 JSON 从 16,880,734 B 降到 227,374 B。这不是网络传输、内存或启动性能数据。
- **键盘标签**：活动标签切换复用已有节点，原生页面只切换一次挂载；键盘方向键、Home、End 与连接详情保留可见焦点。
- **SBOM**：从锁文件取得 Electron 的真实版本，同名同版本依赖存在生产路径时以 required 为准。

## 🐛 问题修复

- **手动保存**：显式指定路径的 PDF / HAR 与右键「截图保存」不参加证据清理。对历史无归属标记的文件采取保守保留策略；新自动产物仍受 TTL、配额和文件身份检查管理。
- **Cookie 操作**：拒绝未指定或无效的操作；有效的写入与清除继续遵循已有操作审批设置。
- **Linux 冷启动**：桥接器识别安装器默认的 `~/Applications/AaBrowser.AppImage`；显式 AppImage 路径仍须通过名称及文件检查。

## 🔒 安全与兼容性

- 保持 42 个 MCP 工具、既有客户端入口和持久化配置；没有新增运行依赖。
- 共享诊断由主进程字段白名单生成，不复制浏览记录、配置内容或连接令牌。
- Windows 安装包当前未配置 Authenticode 签名；GitHub 不可变发行和资产摘要不能替代 Windows 代码签名。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.7.0.exe` | Windows x64 | NSIS 安装程序 |
| `aa-browser-setup-0.7.0.exe.blockmap` | Windows x64 | 增量更新块映射，不需手动运行 |
| `latest.yml` | Windows x64 | 应用更新元数据 |
| `aa-browser-0.7.0-linux-x86_64.AppImage` | Linux x86_64 | AppImage 应用 |
| `latest-linux.yml` | Linux x86_64 | 应用更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 校验和 |

首次安装及客户端接入参见[接入指南](https://github.com/yuchen0x1/aa-browser/blob/v0.7.0/docs/CONNECT.md)。已安装用户可使用应用内更新或下载对应平台资产；Linux 缺少 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1`。

## 🔄 升级与数据迁移

- **兼容性**：本次为兼容性次版本升级，不新增手动迁移步骤。
- **配置和数据**：保留现有设置、历史、普通会话和客户端入口；手动导出的文件与无归属标记历史文件采取保守保留策略。
- **回退方式**：需要回退时，先退出应用并备份本机配置和会话，再从旧版正式发行取得安装包；不承诺未来版本数据可直接跨版本回退。

## 🧪 验证结果

- 本地 Windows / Linux 增强桌面回归均为 48/48，UI/UX 均为 84/84，打包应用 MCP smoke 各 145 项通过。
- Windows / Linux 源码候选冷启动和 Linux 默认路径 AppImage 冷启动已通过；最终离线检查通过，仍有 48 warnings / 503 infos，未屏蔽规则。
- 功能提交的远端双平台 CI 和 CodeQL 已通过，Windows 真实 NSIS 安装 → MCP → 卸载已通过；最终标签另以对应 CI 结果为准。
- Windows 首轮 CI 的既有网页可见性测试发生采样时序失败，仅重跑失败作业后通过；保留失败记录，未修改宣传网页或跳过测试。
- 真实打印设备、所有第三方客户端、macOS / ARM 及多个物理显示器不列为已通过。

## ⚠️ 已知问题

- Linux 自定义安装目录不会自动持久化冷启动路径；在 MCP 客户端为桥设置 `AA_BROWSER_APP_PATH` 为受支持 AppImage 的绝对路径，或先手动启动浏览器。
- 本版本不包含随后提出的多项目并发隔离、标题栏拖动或 F12 开发者工具改进；这些问题另行排查和验收。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.7.0<br>
**比较：** https://github.com/yuchen0x1/aa-browser/compare/v0.6.12...v0.7.0
