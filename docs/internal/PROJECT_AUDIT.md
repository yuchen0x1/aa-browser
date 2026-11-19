# Aa Browser 项目现状审计

> **本文件记录 2026-11-16 的 v0.0.5 基线，属于历史档案。** 当前版本状态、平台矩阵和验证证据见 [`docs/MAINTENANCE.md`](../MAINTENANCE.md)、[`docs/PLATFORMS.md`](../PLATFORMS.md) 和 [`docs/internal/2026-11-19-round2.md`](./2026-11-19-round2.md)。
>
> 审计时间：2026-11-16（Asia/Shanghai）
> 审计对象：本地检出目录（路径已脱敏）
> 审计范围：仓库结构、源码、配置、文档、CI、测试脚本、构建产物状态
> 说明：本文件是升级工作的基线档案。它只记录已经从本地源码、配置和实际命令输出确认的事实；竞品对标与升级路线分别记录在 COMPETITOR_ANALYSIS.md 和 UPGRADE_ROADMAP.md。

## 1. 审计结论摘要

Aa Browser 是一个面向 AI Agent 的 Electron Chromium 浏览器。它把普通浏览器标签页、可访问性结构化快照、基于稳定 ref 的真实输入、MCP stdio 桥、本机 WebSocket Agent 服务和安全审批流程组合在一个桌面应用中。

截至本次审计：

- 当前版本：0.0.5。
- 当前分支：main。
- 当前 HEAD：d0741ff，标签 v0.0.5，与 origin/main 对齐。
- 工作区不是干净状态。基线采集时已确认 build/icon.png 被删除，src/main/tabs.ts 和 install.mjs 有修改；审计期间其他并发升级工作又修改了 CI、工具、测试和包配置文件。完整列表以当前 git status 为准，以下结论应在并发变更合并或回退后重新核对。
- TypeScript 类型检查、工具契约检查、持久化回归、更新器状态回归、发布脚本回归、Codex 接入验证、WorkBuddy 接入验证和生产构建均已在本地通过。
- 本地代码和模拟测试不能证明真实用户已经完成在线更新、安装、签名校验、回滚或跨平台发布。
- 当前正式打包目标是 Windows NSIS；代码签名、macOS/Linux 构建矩阵和真实安装升级仍未验证。
- 项目已经具备较完整的 Agent 浏览器能力，但仍属于早期版本，安全高权限能力、发行可靠性、跨平台能力、长期运行和真实端到端证据需要继续完善。

## 2. 项目定位与目标用户

### 2.1 产品定位

项目描述为：

> AI-native browser — browse like a human, drive like an agent

核心目标是让：

1. 普通用户通过 Electron Chromium 浏览网页、登录站点并使用标签页。
2. 支持 MCP 的 Agent 通过本机桥接调用浏览器。
3. Agent 使用结构化页面快照和稳定引用编号，而不是依赖截图猜坐标。
4. 用户能够对敏感输入、表单提交等高风险动作进行人工审批。
5. 开发者能够抓取网络请求、读取响应、导出 HAR、模拟请求并运行自动化回归。

### 2.2 目标使用场景

- Agent 读取网页结构并执行导航、点击、输入、选择、滚动和提取。
- 登录态测试、Cookie/Storage 检查和浏览器状态诊断。
- 页面抓包、接口响应检查和网络错误模拟。
- 多标签页、多会话分区和站点白名单环境。
- 将 MCP 配置自动写入 Codex、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、ZCode 和 WorkBuddy。
- Windows 安装包分发及 GitHub Releases 自动更新。

## 3. 技术栈与工程边界

| 项目 | 当前实现 |
|---|---|
| 桌面框架 | Electron ^45.2.2 |
| 构建工具 | electron-vite ^6.0.0、Vite 8（本地实际输出） |
| 语言 | TypeScript，strict: true |
| Agent 协议 | 自定义本机 WebSocket 协议 + stdio MCP 桥 |
| WebSocket | ws ^8.22.1 |
| 更新器 | electron-updater ^6.8.11 |
| 包管理 | npm，提交了 package-lock.json |
| Node 要求 | >=20 |
| 前端 | Electron WebContentsView 外壳 UI，原生 HTML/CSS/TypeScript |
| 页面渲染 | Chromium 页面 WebContentsView；页面不挂 preload |
| 持久化 | JSON 文件；设置、历史、连接发现文件和下载记录分别管理 |
| Windows 打包 | electron-builder NSIS |
| 发布服务 | GitHub Releases provider |
| 许可证 | MIT |
| 当前平台声明 | Windows 可打包；README 明确说明 macOS/Linux 尚未配置发布矩阵和签名资产 |

关键配置文件：

- package.json
- electron.vite.config.ts
- electron-builder.yml
- tsconfig.json
- .github/workflows/ci.yml
- docs/AUTO_UPDATE.md

## 4. 代码结构与数据流

### 4.1 目录结构

~~~text
aa-browser/
├── src/
│   ├── main/          # 主进程、窗口、标签、动作、网络、更新、Agent 服务
│   ├── preload/       # 仅外壳 UI 使用的受限 IPC 桥
│   ├── renderer/      # 浏览器外壳 UI 与新标签页
│   ├── shared/        # 主进程、渲染层、CLI 共享类型
│   └── snapshot/      # DOM 快照引擎与页面动作脚本
├── cli/
│   ├── mcp.mjs        # stdio MCP 桥
│   └── setup.mjs      # 客户端接入配置
├── scripts/           # 构建桥、冒烟测试、桌面测试、发布测试
├── docs/
├── workbuddy/
└── .github/workflows/ci.yml
~~~

### 4.2 主流程

~~~text
MCP 客户端
   │ stdio JSON-RPC
   ▼
cli/mcp.mjs
   │ 本机 WebSocket + connection.json 中的 port/token
   ▼
AgentServer（127.0.0.1 随机端口）
   │ 工具查找、取消、审批状态、执行日志
   ▼
src/main/tools.ts
   │
   ├── actions.ts       页面导航和真实输入
   ├── tabs.ts          标签页与会话分区
   ├── snapshot/        DOM → 可访问性树和 ref
   ├── network.ts       CDP 抓包和请求 Mock
   ├── downloads.ts     静默下载追踪
   ├── dialogs.ts       页面对话框守卫
   ├── approvals.ts     敏感输入/高危操作审批
   └── settings/history/updater/clients
~~~

外壳 UI 使用独立的 WebContentsView 和 preload；任意网页页面视图不挂 preload。主进程通过 aa:* IPC 将状态推送给外壳 UI。

## 5. 已实现能力清单

### 5.1 浏览器外壳与标签页

证据：src/main/index.ts、src/main/tabs.ts、src/renderer/index.html、src/renderer/src/chrome.ts

- Electron BaseWindow + 多个 WebContentsView。
- 标签创建、选择、关闭、当前进程内最近关闭标签重开。
- 前进、后退、刷新、地址栏/搜索词归一化。
- 普通标签共享 persist:aa-main 会话分区。
- 可选的一次性隔离会话分区 persist:aa-iso-*。
- 页面标题、favicon、加载状态、前进/后退状态回传。
- 页面右键菜单、开发者工具、页面截图入口。
- 页面 target=_blank/window.open 在允许时转换为新标签。
- 页面导航和重定向经过站点白名单检查。
- 页面上下文不挂 preload，外壳 UI 的 preload 受导航限制。

### 5.2 Agent 快照与交互

证据：src/snapshot/engine.js、src/snapshot/scripts.ts、src/main/actions.ts、src/main/tools.ts

- DOM/可访问性树快照。
- 完整快照、未变化快照和增量 patch 快照。
- 稳定 e<number> ref；根据内容签名复用引用的逻辑在快照引擎中实现。
- 页面导航、快照、点击、拖拽、输入、下拉选择、滚动、文本提取、等待、按键。
- 悬停、页面查找、后退、前进、视口调整、元素截图。
- Cookie、localStorage、sessionStorage、文件上传、PDF、CSS 选择器导出。
- 页面控制台日志、对话框读取、下载列表、Cookie/Storage 读写。
- 交互完成后按工具参数返回快照或增量快照。

当前工具契约检查确认主进程、MCP 桥和 README 三方均声明 33 个工具。

### 5.3 网络与调试能力

证据：src/main/network.ts、src/main/tools.ts

- 基于 Electron CDP debugger 的网络抓包。
- 网络请求按 URL、方法、状态和资源类型筛选。
- 请求详情、请求/响应头、响应体读取。
- HAR 1.2 导出；默认脱敏认证头和疑似凭据查询参数。
- URL/请求头默认脱敏，includeSensitive: true 可显式恢复敏感信息。
- Fetch 域请求拦截和 Mock：添加/列出/删除/清空规则。
- DevTools 与抓包共用 debugger，代码对二者互斥关系有处理。

### 5.4 安全控制

证据：src/main/index.ts、src/main/agent-server.ts、src/main/sessions.ts、src/main/approvals.ts、src/main/actions.ts

- Agent 服务只监听 127.0.0.1，随机端口，连接必须携带随机 token。
- connection.json 包含 PID、版本、启动时间和实例 ID，退出时按实例校验后清理。
- 页面视图不挂 preload，外壳 IPC 校验发送方必须是受信任的 chrome view。
- 页面导航、重定向、地址栏提交均经过允许规则检查。
- 默认拒绝摄像头、麦克风、定位、剪贴板读取、通知、MIDI、HID、串口、USB、蓝牙、屏幕捕获等权限。
- 敏感输入由用户直接输入；Agent 提供的敏感文本不写入或回传。
- 敏感字段填写期间检查 URL、标签、字段指纹是否变化。
- 表单提交和配置的高危操作可以要求人工审批。
- 下载文件名经过 basename 和危险字符清理，下载目录可配置。
- 设置和历史使用原子 JSON 写入；无效旧文件会在修复写入前备份。
- 网络详情和 HAR 默认做敏感信息脱敏。
- 开启高危操作审批后，`includeSensitive:true` 的网络详情和 HAR 导出进入人工确认。

### 5.5 持久化和用户数据

证据：src/main/settings.ts、src/main/history.ts、src/main/atomic-json.ts、src/main/downloads.ts

- 设置 JSON 默认位于 ~/.aabrowser/settings.json。
- 历史 JSON 默认位于 ~/.aabrowser/history/history.json，最多保留 1000 条。
- 下载默认位于 ~/.aabrowser/downloads，内存最多保留 100 条记录。
- 设置包括搜索引擎、完整快照、下载目录、操作审批、站点白名单、隔离会话、更新通道和自动更新。
- 无效设置和历史记录进行类型归一化；保存失败时保留旧文件和内存状态。
- 隔离分区关闭时清除 Cookie、Storage 和缓存；启动时扫描残留分区目录。

### 5.6 客户端接入

证据：src/main/clients.ts、cli/setup.mjs、scripts/validate-codex-setup.mjs、scripts/validate-workbuddy.mjs

- 支持多种 MCP 客户端检测和配置写入。
- 写入前自动备份，重复执行幂等。
- JSON、JSONC 和 Codex TOML 分开处理。
- 无法解析的配置不会强行覆盖，而是返回手动处理提示。
- WorkBuddy 使用独立 connector 元数据和 stdio 配置路径。
- README 明确区分“配置写入”“客户端导入/启用”“实际工具调用验证”。

### 5.7 更新与发布

证据：src/main/updater.ts、docs/AUTO_UPDATE.md、electron-builder.yml、.github/workflows/ci.yml

- GitHub Releases provider。
- 稳定/Beta 通道、启动检查、周期检查、焦点/网络恢复检查。
- 检查、下载、完成、错误、重试、取消和显式重启安装状态。
- 自动更新失败有有限次数的退避重试。
- 更新状态展示在主界面提示条和设置面板。
- GitHub Actions 在 v* 标签触发 Windows 构建、生成 latest.yml、blockmap、SHA-256 清单并发布 Release。
- 发布脚本检查标签与 package.json 版本匹配，并验证资产集和公开 Release 标签。

## 6. 当前优势

1. **Agent 交互契约完整**：快照、稳定 ref、真实输入和动作后回读形成闭环。
2. **权限边界清晰**：页面 WebContents 不挂 preload，外壳 IPC 有 sender 校验。
3. **本机连接面较小**：Agent 服务只监听回环地址并使用随机 token。
4. **状态和失败处理较成熟**：设置、历史、更新器和连接文件都有明确的异常路径。
5. **测试覆盖早期核心回归**：工具契约、持久化、更新器、发布脚本和桌面流程均有脚本化测试。
6. **工程化文档较完整**：README、自动更新说明、贡献指南、发布说明和 WorkBuddy 文件齐全。
7. **功能面超出最小浏览器桥**：已具备网络抓包、HAR、Mock、Cookie、Storage、上传、PDF、下载和客户端配置管理。

## 7. 缺陷、风险与技术债务

以下项目是从当前代码、配置和验证范围得出的改进候选；未把推测写成已确认 Bug。

### P1：发行和更新能力的外部证据不足

- 当前只配置 Windows NSIS。
- 构建产物没有代码签名，SmartScreen 体验仍可能受影响。
- electron-updater 的在线检查、下载、SHA-512 校验、安装、重启和回滚没有在真实旧版/新版安装包之间完成端到端验证。
- test:updater 使用模拟 provider；test:release 使用模拟 GitHub API。
- 本地 npm run dist 受 Electron 下载和网络环境影响，不能替代远程 Actions 证据。

影响：不能仅凭本地测试宣称生产更新链路已完成。

### P1：高权限网络工具可直接暴露敏感数据

- 网络捕获缓冲区在进程内保存原始 URL 和请求/响应头。
- browser_network_detail 的 includeSensitive: true 会返回认证头和疑似凭据参数。
- browser_network_detail 还可读取响应体；响应体默认只截断长度，没有通用的内容级脱敏。
- HAR 可以选择导出敏感字段。
- 这些能力对调试有价值，但应继续评估最小权限、审批、日志策略、导出路径限制和内存清理。

当前代码已有默认脱敏，但默认脱敏不等于完整 DLP。

### P1：用户数据和会话恢复能力有限

- 普通标签的“最近关闭重开”只保存在当前进程内，应用重启后不恢复标签。
- 历史记录、设置和下载记录是分开持久化的；下载记录本身主要是内存状态，重启后不保留完整下载历史。
- 隔离分区目录在当前进程内可能因 Chromium 文件句柄无法删除，代码改为清数据并在下次启动 sweep；这依赖下次启动回收物理目录。

### P1：跨平台产品能力未完成

- electron-builder.yml 只有 Windows NSIS。
- 没有 macOS/Linux 构建矩阵、签名、notarization、AppImage/deb 等资产和验证。
- 客户端配置路径中存在平台分支，但这不等于桌面发行已经跨平台完成。

### P2：安全策略需要持续收紧和验证

- 本地 connection.json 使用普通文件写入；Windows ACL、非 Windows 文件权限和多用户场景尚未形成独立验证报告。
- Agent 能读取 Cookie、Storage、网络请求和页面内容；这符合产品定位，但需要清晰的高敏站点使用边界和更细的审批/授权模型。
- 页面权限拒绝策略较严格，未来增加上传、通知、剪贴板等能力时必须保持权限模型一致。
- 需要持续检查外部导航、重定向、特殊协议、下载和 window.open 的边界组合。

### P2：测试证据仍有覆盖空白

- 已通过的测试主要是本地模拟、隔离 Electron 实例和固定 fixture。
- 长时间运行、并发 Agent、多客户端、崩溃恢复、强制退出、磁盘满、权限拒绝、代理/证书错误、真实登录站点和大响应体尚未形成完整矩阵。
- 性能指标（启动时间、内存、CPU、快照耗时、抓包开销）当前没有基线数据。
- 没有把完整浏览器回归作为每次升级都必须保存的可比较报告。

### P2：文档与实现同步需要自动化

- README、主进程工具表、MCP 桥工具表之间已有 check:tools 防漂移检查，但其他契约（设置字段、客户端路径、发布资产、权限策略）仍主要依靠人工同步。
- 版本、发布说明、README 最新更新和 docs/releases 需要继续保持同一提交内一致。

### P3：可维护性和可观测性

- 主进程承担窗口、标签、IPC、Agent、更新和状态推送等多个职责，后续扩展时需要继续控制模块边界。
- Agent 日志当前输出工具名和请求 ID；生产使用时还应明确日志级别、留存策略、敏感字段过滤和诊断开关。
- 网络抓包、console 缓冲区和动作日志均有内存上限，但没有面向用户的容量/清理策略说明。

## 8. 已执行验证

以下命令在本地仓库执行并通过。npm 输出的 store-dir 是当前 npm 环境警告，不影响这些命令的退出状态。

| 检查 | 结果 | 证据 |
|---|---|---|
| npm run typecheck | PASS | TypeScript tsc --noEmit 退出成功 |
| npm run check:tools | PASS | 主进程、桥、README 均为 33 个工具 |
| npm run check | PASS | 类型检查和工具契约检查均通过 |
| npm run test:tools | PASS | 33 个 MCP 工具注解/契约通过 |
| npm run test:stores | PASS | 8/8 持久化检查通过 |
| npm run test:updater | PASS | 12/12 更新器状态检查通过；模拟 provider |
| npm run test:release | PASS | 4/4 发布元数据检查通过；模拟 GitHub API |
| npm run test:security | PASS | 安装器拒绝缺少、格式错误和无效显式 SHA-256 digest |
| npm run validate:codex | PASS | Codex TOML 保留无关设置、备份和幂等检查通过 |
| npm run validate:workbuddy | PASS | WorkBuddy connector 元数据、schema、隔离配置检查通过 |
| npm run build | PASS | Electron main/preload/renderer 和 MCP bridge 构建成功；bridge 约 151 KB |
| npm run smoke | PASS | 本地隔离 Electron/MCP 端到端流程通过；测试页改为 HTTP fixture 以符合安全协议策略 |
| npm run test:desktop | PASS | 20 项原生桌面回归通过，包含非 HTTP(S) 导航拒绝和敏感网络审批拒绝 |
| npm run test:update-ui | PASS | 5 项模拟更新 UI 回归通过；不代表真实安装器 |
| npm run dist -- --publish never | PASS | 产出 Windows NSIS、blockmap、latest.yml；未配置代码签名，使用默认 Electron 图标 |

## 9. 尚未验证或需要外部条件的项目

| 项目 | 状态 | 原因 |
|---|---|---|
| 真实在线更新 | 未验证 | 需要已发布且高于当前版本的 GitHub Release |
| 签名校验和 SmartScreen | 未验证 | 当前未配置代码签名证书 |
| 真实安装升级/回滚 | 未验证 | 需要旧版和新版 Windows 安装包 |
| macOS/Linux 发布 | 未实现/未验证 | 当前 builder 配置没有对应目标 |
| 性能基线 | 未建立 | 尚无启动、内存、CPU、快照和抓包基准采样 |
| 长时间/并发/崩溃恢复 | 未建立 | 尚无专项测试矩阵 |

## 10. 当前成熟度判断

按当前证据，项目可以描述为：

- **核心 Agent 浏览器能力：较完整**
- **本地开发与回归工程化：良好**
- **安全边界：已有明确设计，仍需高权限数据治理和攻击面测试**
- **更新与发行：Windows 本地/CI 配置基本成形，真实安装链路未闭环**
- **跨平台：未完成**
- **生产级证据：部分具备，不能整体宣称已达到生产级**

这不是对产品价值的否定，而是对验证范围的限定：源码存在、模拟测试通过和真实用户环境中的可安装/可更新/可恢复之间仍有差距。

## 11. 后续升级输入

后续 COMPETITOR_ANALYSIS.md 和 UPGRADE_ROADMAP.md 应优先围绕以下已证实的方向展开：

1. 真实发行与更新闭环：签名、资产校验、安装、回滚和多平台矩阵。
2. 高权限网络和浏览器状态工具的审批、脱敏、导出路径和生命周期管理。
3. 跨会话标签恢复、下载历史和崩溃恢复。
4. 长时间运行、并发调用、取消、重试和资源上限。
5. 性能基线与可观测性。
6. 工具/配置/文档契约自动同步。
7. 站点白名单、特殊协议、权限请求和下载路径的安全回归。
8. 真实页面和真实客户端接入验证。

---

\n