## 📢 版本概述

本次更新让自动化操作的结果可以被验证。`browser_scroll` 不再只回答「已发送」，而是返回真实的滚动前后位置、是否发生滚动以及到达边界的原因；新增 `browser_page_state`，一次读取页面可见性、焦点、滚动位置、弹窗、Cloudflare 验证与限流提示。导航可等待 SPA 渲染完成，标签列表会标明浏览器实例、标签创建时间与恢复状态，`evaluate` 的不可序列化返回值也会给出结构化诊断。MCP 工具由 42 个增至 43 个，均为向后兼容的新增或补充，用户数据无需迁移。

## ✨ 新增功能

- **`browser_page_state` 页面状态摘要**：一次返回 URL、标题、`readyState`、`visibilityState`、窗口焦点、滚动位置与可滚动性、可见 DOM 弹窗、被拦截的原生对话框、Cloudflare 验证迹象和限流提示，并附带浏览器实例 id、PID、版本、标签 id、是否恢复及创建时间。适用于操作前确认页面是否真的可交互，或排查「看起来在运行但没有反应」的问题。
- **`browser_tabs` 实例与标签身份**：`list` 输出浏览器实例 id、PID、版本、启动时间、窗口可见/最小化/焦点状态，以及每个标签的创建时间与 `♻恢复` 标记，便于区分重启后仍是同一个标签，还是新开的同名页面。
- **`browser_navigate` 支持 `waitFor`**：可等待选择器出现、文本出现或 URL 包含指定片段，`timeoutMs` 默认 10 秒、限制在 1–30 秒。超时返回 `isError` 并附当前快照，不再把「导航命令已提交」当成「页面已就绪」。

## 🔧 改进与优化

- **滚动结果可验证**：`browser_scroll` 返回 `didScroll`、`before` / `after` 坐标、`atLimit`、`scrollHeight`、`viewportHeight`、`visibilityState` 与未滚动原因（`at-limit`、`not-scrollable`、`no-scrollable-area`）。主文档不动时，会按请求方向寻找最大的可滚动容器再试一次，并再次核对实际位移；确实没有滚动时明确返回 `didScroll: false`，不再报告「已滚动」。
- **后台滚动提示**：窗口最小化或页面隐藏导致浏览器节流滚动时，结果会提示 `visibilityState` 与后台限制，便于区分「页面不支持滚动」和「后台节流」。
- **`browser_tabs select` 可选前置窗口**：默认保持原有行为，不抢系统焦点；传入 `bringToFront: true` 时恢复并聚焦窗口，返回 `windowFocused` 与 `visibilityState`，适合需要真实前台渲染或用户接管的场景。
- **未知 action 的错误更明确**：`browser_tabs` 收到未知 action 时会列出可用值 `list`、`new`、`select`、`close`，减少猜测。
- **`browser_evaluate` 返回类型诊断**：结果附带 `valueType`；循环引用、BigInt 等无法 `JSON.stringify` 的返回值返回 `EVALUATE_RESULT_SERIALIZATION_FAILED` 的结构化错误，包含类型、消息和截断预览；`undefined`、函数、Symbol 也会说明类型与预览，而不是只给一段无法判断的字符串。

## 🐛 问题修复

- **`browser_get_selector` 文本压缩与兜底选择器失效**：修复页面脚本模板字符串吞掉反斜杠，导致空白压缩正则和 `CSS.escape` 兜底没有按预期工作的问题。含连续空白、特殊字符的文本现在能生成更稳定的选择器。

## 🔒 安全与兼容性

- 新增的 `browser_page_state` 为只读、幂等工具，只返回结构与计数，不回显页面正文、输入值或凭据；`browser_tabs select` 的默认焦点行为未改变。
- 保持既有 MCP 客户端入口、工具参数与持久化配置；工具数 42 → 43，没有新增运行依赖，不需要迁移数据或重新接入客户端。
- `browser_navigate` 的 `waitFor` 只作用于主文档；跨域 iframe 内容请继续使用 `browser_frame`。
- Windows 安装包当前未配置 Authenticode 签名；GitHub 不可变发行与 `SHA256SUMS.txt` 摘要不能替代 Windows 代码签名。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.10.0.exe` | Windows x64 | NSIS 安装程序 |
| `aa-browser-setup-0.10.0.exe.blockmap` | Windows x64 | 增量更新块映射，不需手动运行 |
| `latest.yml` | Windows x64 | 应用更新元数据 |
| `aa-browser-0.10.0-linux-x86_64.AppImage` | Linux x86_64 | AppImage 应用 |
| `latest-linux.yml` | Linux x86_64 | 应用更新元数据 |
| `sbom.cdx.json` | 通用 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 通用 | 发行文件 SHA-256 校验和 |

首次安装及客户端接入参见[接入指南](https://github.com/yuchen0x1/aa-browser/blob/v0.10.0/docs/CONNECT.md)。已安装用户可通过应用内更新或下载本平台安装包升级。Linux 缺少 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1`。

## 🔄 升级与数据迁移

- **兼容性**：可直接覆盖升级；既有工具名称、参数和客户端入口保持可用，新增参数均为可选。
- **配置和数据**：保留现有设置、历史、Cookie、下载与会话数据；无需手动迁移。
- **回退方式**：需要回退时，先退出应用并备份本机配置与会话，再从旧版正式发行取得安装包。旧版不识别 `browser_page_state`，但不会影响既有工具。

## 🧪 验证结果

- Windows 本地源码：`npm run check` 通过（typecheck、Biome lint、工具定义四方一致、提示词、DSH、页面脚本、标签队列、证据、SBOM、多语言与发行正文归档）。
- 页面脚本专项：5 组通过，覆盖窗口滚动、边界、不可滚动页面、内层容器、选择器转义，以及页面状态的隐藏/焦点/滚动/弹窗/原生对话框/Cloudflare/限流判定。
- 真实 Electron + stdio MCP 冒烟：170 项检查通过，其中新增 12 项覆盖 `waitFor` 成功、页面状态解析与实例身份、短页面不滚动原因、注入长页面后的真实位移、滚动到底后的 `didScroll:false` / `atLimit:true`、`waitFor` 超时错误、循环引用序列化诊断、标签实例头与 `select` 焦点/可见性。
- 桌面回归 55/55、后台回归、官网 UI 53/53 与交互 15/15 通过。
- 未在本地执行真实打包版本从 0.9.1 到 0.10.0 的完整升级，也未在本地 Linux 桌面环境运行；标签 CI 会在 Windows 与 Ubuntu 上重新构建、执行完整回归与打包冒烟，并在两平台均通过后才发布资产。

## ⚠️ 已知问题

- 滚动兜底只尝试请求方向上最大的可滚动容器。页面存在多个嵌套滚动区时可能仍未滚动，可先用 `browser_page_state` 查看 `scroll` 指标，再决定操作目标。
- `browser_page_state` 的 Cloudflare 与限流判断基于页面标题、文案和响应迹象的启发式识别，不能替代官方状态或人工确认。
- 标签 id 跨重启稳定依赖「重启后恢复上次标签页」处于开启状态；隔离标签按设计不恢复，其 `tabId` 在重启后失效。
- `bringToFront: true` 会在窗口最小化时将其恢复并显示，可能打扰当前桌面操作；仅在需要前台渲染或用户接管时使用。
- CI 使用模拟 provider 验证更新交互；真实安装器的跨版本升级仍建议在独立测试 profile 上手工验收。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser<br>
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues<br>
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.10.0<br>
**比较：** https://github.com/yuchen0x1/aa-browser/compare/v0.9.1...v0.10.0
