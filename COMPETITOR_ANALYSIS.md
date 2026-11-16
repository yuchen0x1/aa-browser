# Aa Browser 竞品与相关开源项目对标分析

> 研究日期：2026-11-16（Asia/Shanghai）
> 项目基线：Aa Browser v0.0.5，MIT，Electron + TypeScript，Windows 优先，MCP stdio 桥接。

## 1. 研究范围与证据边界

本报告研究了 19 个开源项目，覆盖完整桌面浏览器、浏览器自动化库、AI Agent 浏览器、MCP 工具服务、浏览器服务池和 Agent 评测环境。每个项目至少检查了公开仓库、README/目录结构、许可证和 Releases；对重点项目进一步检查了近期 release notes、源码布局或许可证原文。

结论只在公开证据范围内成立：

- 仓库里有一个按钮、工具名或 README 描述，不等于对应能力已经在生产环境中验证。
- “近期活跃”只表示在本次检查时看到了近期 commit、release 或维护记录，不代表未来维护承诺。
- 性能、资源占用和稳定性没有在 Aa Browser 与所有竞品之间做统一硬件基准测试，因此本报告不编造数值排名。
- 本报告用于产品和工程取舍，不构成法律意见。引入任何代码或依赖前仍需对具体文件、依赖树和发行方式做许可证审查。

## 2. Aa Browser 当前基线

根据仓库中的 `README.md`、`package.json`、`src/`、`cli/`、`scripts/`、`electron-builder.yml` 和 `docs/`：

| 维度 | 当前事实 |
| --- | --- |
| 定位 | 面向 AI Agent 的可见桌面浏览器；普通用户也可以使用标签页、地址栏、登录态和导航 |
| 技术栈 | Electron 45、electron-vite、TypeScript、Node.js >=20、WebSocket、electron-updater |
| Agent 接入 | `cli/mcp.mjs` 提供零依赖 stdio MCP 桥；浏览器主进程提供本地 WebSocket 服务和一次性 token |
| 页面理解 | DOM 注入快照引擎，输出可访问性树与稳定 `ref`；支持完整/增量快照 |
| 操作面 | 导航、快照、点击、拖拽、输入、表单、选择、滚动、等待、键盘、悬停、历史导航、视口调整、元素截图、Cookie/Storage、上传/下载、PDF、控制台和网络抓包等工具 |
| 网络与诊断 | 请求列表、请求详情、HAR 导出、Mock 规则、控制台日志 |
| 安全边界 | Agent 服务监听 `127.0.0.1`，随机端口 + token；站点白名单、隔离会话、敏感输入审批等产品能力已在文档中说明 |
| 发布 | Windows NSIS 安装包、GitHub Releases、`electron-updater`；支持稳定/Beta 通道和安装后重启 |
| 当前优势 | 本地可视化、用户可直接接管、MCP 原生、结构化页面数据、增量快照、Windows 桌面交付 |
| 需要继续验证 | 跨平台一致性、强安全策略的覆盖面、长时间多标签稳定性、真实升级安装链路、签名和生产环境端到端证据 |

## 3. 项目总览对比

| 项目 | 类型与仓库 | 许可证（仓库公开信息） | 已核验能力/证据 | 对 Aa Browser 的启示 | 决策 |
| --- | --- | --- | --- | --- | --- |
| [Chromium](https://github.com/chromium/chromium) | 浏览器内核与完整浏览器源码 | BSD-3-Clause，另含大量第三方许可 | 超大型多进程浏览器代码库，持续提交；可作为安全沙箱、渲染、进程和更新的基础参照 | 不复制内核；跟踪 Chromium/Electron 安全更新、进程隔离和权限变化 | 跟踪并吸收架构原则 |
| [Electron](https://github.com/electron/electron) | Chromium + Node.js 桌面框架 | MIT，另含第三方 notices | Electron 桌面窗口、IPC、WebContents、打包生态；Aa Browser 当前直接使用 | 继续沿用；重点补 IPC 契约、窗口生命周期、权限和升级测试 | 保持，持续升级 |
| [Brave Browser](https://github.com/brave/brave-browser) / [brave-core](https://github.com/brave/brave-core) | 隐私优先 Chromium 派生浏览器 | MPL-2.0（并含 Chromium/第三方 notices） | 多平台发行、隐私默认值、发布资产与校验信息；浏览器与 core 分仓 | 借鉴隐私默认值、渠道发布、资产校验和安全公告流程 | 概念重实现，避免直接复制 |
| [Zen Browser](https://github.com/zen-browser/desktop) | 生产力/工作空间浏览器，Firefox 派生 | MPL-2.0 | `1.24.1b`（2026-11-06）release notes 包含跨 space 路由冻结、更新重启窗口闪现、跨平台崩溃等修复；仓库分为源码、构建、配置和脚本 | 借鉴 workspace/space、紧凑桌面布局、发布后快速修复和多显示器兼容 | 采用交互思路，重新实现 |
| [Floorp](https://github.com/Floorp-Projects/Floorp) | 可定制、隐私取向 Firefox 派生浏览器 | MPL-2.0 | 仓库按 browser features、native、libs、docs、bridge 等分层，持续维护 Firefox 生态兼容 | 借鉴可选 feature 模块、设置分组和功能开关 | 概念重实现 |
| [LibreWolf](https://github.com/librewolf-community/browser-linux) | 隐私/安全强化 Firefox 构建 | MPL-2.0；当前活动维护点已转向 Codeberg，GitHub 镜像显示 archived | 补丁、构建脚本、CI、签名 key 和 changelog 分离；GitHub 镜像不应被当成当前主仓库 | 借鉴隐私 hardening、补丁流水线和签名分层；先核实活动上游 | 只借鉴流程 |
| [qutebrowser](https://github.com/qutebrowser/qutebrowser) | Python + QtWebEngine，键盘优先浏览器 | GPL-3.0 | 命令驱动、vim-like 快捷键、低干扰 UI；仓库与 release 仍有维护记录 | 借鉴 command palette、键盘可达性和脚本化命令；不直接复制 GPL 代码 | 设计借鉴，代码排除 |
| [Playwright](https://github.com/microsoft/playwright) | 多浏览器自动化与测试库 | Apache-2.0 | Chromium/Firefox/WebKit 统一 API；包含 locator、trace、video、测试 runner、CLI、library 和 MCP 入口；v1.65.0 在 2026-11-05 发布 | 借鉴 locator/ref 稳定性、等待语义、trace 和可回放诊断 | 优先采用接口原则，必要时依赖升级 |
| [Puppeteer](https://github.com/puppeteer/puppeteer) | Chrome/Firefox JavaScript 自动化库 | Apache-2.0 | CDP-first，提供网络、console、页面生命周期等低层事件；v25.17.0 在 2026-11-10 更新 | 借鉴 CDP 事件边界、网络拦截和上下文生命周期 | 作为 Electron/CDP 参考，不引入重复运行时 |
| [Selenium](https://github.com/SeleniumHQ/selenium) | 标准 WebDriver/BiDi 跨语言生态 | Apache-2.0 | Java、.NET、JS、Python、Ruby、Rust 绑定；Selenium Manager、Grid、BiDi 仍在更新 | 借鉴标准化 session/driver、兼容性矩阵和多浏览器回归 | 作为协议与测试基线 |
| [WebdriverIO](https://github.com/webdriverio/webdriverio) | Node.js 浏览器/移动自动化框架 | MIT | runner、reporter、service、Cucumber、Appium 等插件分层；v10.2.0 在 2026-11-06 可见 | 借鉴插件注册、服务生命周期、报告与录像 | 重实现插件契约 |
| [chromedp](https://github.com/chromedp/chromedp) | Go CDP 驱动 | MIT | 轻量、直接、可组合的 CDP actions；适合后台 worker 和隔离任务 | 借鉴任务上下文、取消、标签隔离和低开销 worker 设计 | 只借鉴并发/取消原则 |
| [browser-use](https://github.com/browser-use/browser-use) | Python AI 浏览器 Agent | MIT | README/1.0.0 资料描述持久 Python REPL + CDP 执行模型、结构化输出、敏感数据 typed secret/redaction、域名 allow/prohibit、下载上传、CLI/MCP 和成本/超时信息 | 借鉴 typed result、秘密脱敏、域名策略、可观测成本和状态返回；注意其云服务连接与版本 pin | 概念重实现，默认本地化 |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | 视觉/LLM 浏览器工作流 | AGPL-3.0 | `v1.0.58`（2026-11-15）修复 SQLite quickstart、错误码、secret scrubbing、signed upload links、依赖 advisories 等 | 借鉴 workflow/state/error taxonomy、凭据脱敏、签名上传和依赖安全；AGPL 不直接嵌入 | 只研究设计，代码排除 |
| [Stagehand](https://github.com/browserbase/stagehand) | TypeScript/Python 的 LLM 浏览器 SDK | MIT | `act`/`extract`/`observe` 分层；Playwright/CDP/cloud-browser 接口；仓库有 packages、tests/fixtures、changesets、SECURITY、CI | 借鉴动作、观察、结构化抽取的边界和 changeset 发布 | 优先重实现 API 语义 |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | 浏览器 Agent 研究与评测环境 | Apache-2.0 | 包含 MiniWoB、WebArena、WorkArena、VisualWebArena、WebLINX、OpenApps、TimeWarp 等环境；AgentLab 用于实现和评估 agent | 借鉴可重复任务、抽象环境、回归评分和 benchmark harness | 建立 Aa Browser benchmark，不嵌入运行时 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP 浏览器工具服务 | Apache-2.0 | 结构化 accessibility snapshot；`v0.0.85`（2026-11-09）包含 background extension、文件上传错误恢复、storage state 隔离；近期还加入录制为 Playwright code、设备模拟和非 2xx 暴露 | 直接对标工具契约、权限、录制、隔离、大小上限和路径校验 | 优先级最高的设计参照；代码仅在兼容时借鉴 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Google DevTools MCP 服务 | Apache-2.0 | Puppeteer/CDP/Lighthouse、console/network/DOM/debugger、性能诊断；仓库含 CHANGELOG、SECURITY、自动 release 检查 | 借鉴诊断工具面、性能 trace、Lighthouse、工具 schema 和发布门禁 | 优先重实现诊断/契约 |
| [Browserless](https://github.com/browserless/browserless) | 容器化浏览器服务池 | SSPL-1.0 OR Browserless Commercial License | Docker 部署、Chrome/Firefox/WebKit、Playwright/Puppeteer/WebSocket、自建或云托管；许可证明确商业闭源场景需商业许可 | 借鉴远程浏览器池、并发隔离、健康检查和容器边界；不直接依赖其服务端代码 | 仅借鉴架构，商业许可前不引入 |

研究数量：**19 个**。其中 8 个是浏览器或浏览器发行版，6 个是自动化/Agent SDK，3 个是 MCP/诊断服务，1 个是浏览器服务池，1 个是评测环境。

## 4. 重点对标结论

### 4.1 产品能力

| 能力 | Aa Browser 当前状态 | 领先参考 | 差距与判断 |
| --- | --- | --- | --- |
| Agent 读取页面 | 已有完整/增量可访问性快照和稳定 ref | Playwright MCP、Browser Use | 已具备核心差异化；需要补 snapshot 版本、失效原因和可回放记录 |
| Agent 操作 | 已有导航、点击、输入、拖拽、表单、键盘、等待等工具 | Playwright、Stagehand | 工具面较完整；需要统一 timeout、取消、重试、错误码和幂等性 |
| 网络透明度 | 已有请求列表、详情、HAR、mock | Chrome DevTools MCP、Puppeteer | 已有能力面；需要敏感字段默认脱敏、响应体上限和导出权限审计 |
| 会话与登录态 | 普通标签共享登录态，可开启隔离会话 | Playwright MCP、Zen、Brave | 需要 profile/session 生命周期、清理失败恢复和跨标签授权可视化 |
| 工作空间 | 当前以标签页为主 | Zen、Floorp | “任务空间/项目空间”是明显产品机会，应在不破坏普通浏览器习惯的前提下加入 |
| 自动化工作流 | MCP 工具可组合，但任务状态/恢复模型仍需加强 | Skyvern、Stagehand、Browser Use | 需要持久任务状态、失败分类、重试/退避、人工接管和可恢复点 |
| 评测与回归 | 有 smoke、tool contract、desktop 等脚本 | BrowserGym、Playwright | 需要固定站点夹具、场景基准、结果快照和版本化评分 |
| 诊断 | 有 console/network/HAR | Chrome DevTools MCP | 可补性能 trace、页面健康摘要、导航瀑布和错误聚合 |

### 4.2 用户体验与桌面交互

Aa Browser 的独特价值是“可见浏览器 + Agent 驱动”，而不是隐藏的 headless worker。竞品研究表明，以下体验值得吸收：

- **Zen/Floorp**：将标签、空间、侧栏和设置组织成可持续工作的桌面结构；适合 Aa Browser 的多任务 Agent 场景。
- **qutebrowser**：命令面板、键盘可达性和低干扰状态反馈；适合快捷操作与无鼠标使用。
- **Brave/LibreWolf**：隐私开关和权限状态应可被用户理解，而不是只存在于配置文件。
- **Playwright MCP/Chrome DevTools MCP**：工具调用后的状态、错误和诊断信息要能在 UI 中追溯，避免“Agent 说做了但用户看不懂”。

现阶段不建议为了追求视觉相似而复制任何竞品的皮肤或布局。应保留 Aa Browser 的 Chromium/Windows 原生体验，把空间、任务、权限和诊断能力接到真实业务流中。

### 4.3 技术架构

可借鉴的共同架构规律：

1. **工具边界清楚**：Playwright MCP、Chrome DevTools MCP 将浏览器动作、诊断、状态和文件能力拆成小工具，并给出明确输入约束。
2. **状态是第一等数据**：Skyvern、Stagehand、Browser Use 都把任务状态、结构化结果、错误类别或观察结果显式化；不只返回一段自然语言。
3. **生命周期可取消**：Puppeteer、chromedp、WebDriver 生态都围绕 browser/context/page/session 生命周期管理取消与清理。
4. **发布有证据**：Zen、Brave、Playwright MCP 等项目在 release 资产、校验和变更日志上留下可检查记录；Aa Browser 的更新链路应继续加强签名和端到端安装证据。
5. **评测可重复**：BrowserGym 说明 Agent 功能必须有固定任务和可比较评分，否则很难判断“升级”是否真的改善。

## 5. Aa Browser 的优势与短板

### 5.1 已验证或有仓库证据的优势

- **本地可见性**：用户能看到标签页、导航、登录态和 Agent 动作，可随时接管。
- **MCP 原生**：本地 WebSocket + stdio bridge 将浏览器进程和 MCP 客户端解耦，支持多种客户端配置。
- **结构化快照**：可访问性树、ref、增量快照和动作后回读构成清晰的 Agent 交互闭环。
- **抓包与状态透明**：Cookie、Storage、console、network、HAR、mock 等能力明显超过只做点击输入的最小 Agent 浏览器。
- **本地安全默认值**：127.0.0.1、随机端口和一次性 token 减少局域网暴露；站点白名单和隔离会话提供进一步控制面。
- **Windows 交付路径**：已有 NSIS、GitHub Releases 和 `electron-updater` 文档与脚本，普通用户可以安装。

### 5.2 需要优先补齐的短板

这些是根据源码/文档能力边界和竞品对标提出的工程缺口，不能理解为所有缺口都已在运行时复现：

1. 工具协议需要 schema 版本、读/写/破坏性/幂等性元数据、统一错误码和大小上限。
2. 会话隔离需要清晰的 profile、tab、任务归属和清理失败恢复语义。
3. 文件上传、下载、HAR、响应体和 Cookie/Storage 工具需要默认脱敏、路径 containment 和用户可见审批记录。
4. 多步任务缺少统一的持久状态、重试策略、退避、取消、超时和人工接管协议。
5. 增量快照需要更明确的版本号、ref 失效原因、跳转边界和恢复方式，避免 Agent 使用过期 ref。
6. 缺少类似 BrowserGym 的稳定 benchmark，用于比较快照、动作、网络和恢复能力的回归变化。
7. 性能诊断目前偏网络和 console，需要导航瀑布、渲染/脚本耗时、内存和长时间运行指标。
8. 发布安全仍需独立验证代码签名、签名 manifest、更新回滚和旧版本到新版本的真实安装链路。
9. workspace/space、任务列表、动作历史和人工接管入口仍有产品化空间。
10. 依赖和 Chromium/Electron 安全升级需要自动化兼容性矩阵与 release gate。

## 6. 借鉴决策矩阵

| 借鉴项 | 主要参考 | Aa Browser 采用方式 | 许可证/风险控制 |
| --- | --- | --- | --- |
| Accessibility snapshot + ref | Playwright MCP | 保持现有格式对齐；补 snapshot version、失效原因、截断提示 | Apache-2.0；优先重实现接口，不复制无关代码 |
| Tool metadata and safety | Playwright MCP、Chrome DevTools MCP | 为工具声明只读、破坏性、幂等性、开放世界、大小上限和权限 | Apache-2.0；写入本项目 schema |
| CDP diagnostics | Chrome DevTools MCP、Puppeteer | 增加性能 trace、导航摘要、console/network 关联 ID | Apache-2.0；不重复打包完整 Puppeteer 运行时 |
| Typed result / secret redaction | browser-use | 为上传、Cookie、响应体和任务结果定义结构化返回；敏感值默认遮蔽 | MIT；重新实现并审查云/telemetry 依赖 |
| Observe/act/extract 分层 | Stagehand | 将观察、动作和提取在 MCP 层区分，避免一个工具承担多种权限 | MIT；重新实现协议 |
| Workflow state and failure taxonomy | Skyvern | 引入任务状态机、失败类别、退避、人工接管和恢复点 | AGPL-3.0；只借鉴公开设计，不复制代码 |
| Workspace/space | Zen、Floorp | 增加项目/任务空间，持久化标签、白名单、session 和最近任务 | MPL-2.0 仅作设计参考 |
| Keyboard command surface | qutebrowser | 增加命令面板、快捷键帮助和可访问焦点管理 | GPL-3.0；只做独立实现 |
| Privacy hardening | Brave、LibreWolf | 建立可解释的隐私预设、站点权限面板和安全升级清单 | MPL/Chromium notices；不复制品牌或补丁 |
| Browser service isolation | Browserless、chromedp | 未来若拆分 worker，采用 per-job context、健康检查和资源上限 | Browserless 为 SSPL/商业许可，不直接依赖 |
| Benchmark harness | BrowserGym、Playwright | 建立本地固定页面夹具、任务脚本、结果快照和性能预算 | Apache-2.0；测试数据与运行时分离 |
| Release and update evidence | Brave、Zen、Electron | 保留 changelog、校验和、签名、回滚、安装回归证据 | 各项目仅作流程参考 |

## 7. 许可证与供应链结论

### 可优先评估的宽松许可证

Playwright、Playwright MCP、Puppeteer、Selenium、BrowserGym、Chrome DevTools MCP 使用 Apache-2.0；Stagehand、browser-use、WebdriverIO、chromedp 使用 MIT。它们适合作为接口设计和独立重实现的首选参考，但仍需保留版权/NOTICE，并逐项检查第三方依赖。

### 需要隔离或法律复核的许可证

- qutebrowser 是 GPL-3.0；不直接复制其源代码或把其组件静默链接进 MIT 桌面应用。
- Skyvern 是 AGPL-3.0；网络服务和衍生分发义务更强，只研究流程和错误模型。
- Brave、Zen、Floorp、LibreWolf 使用 MPL-2.0 或包含 MPL/Firefox/Chromium 代码；MPL 具有文件级义务和第三方 notices，不能只看仓库根许可证。
- Browserless 明确使用 `SSPL-1.0 OR Browserless Commercial License`；商业闭源场景不得默认视为可自由嵌入。
- Chromium、Electron、Brave 等大型项目包含大量第三方代码；任何复制都必须重新跑 SPDX、NOTICE、商标和发行包检查。

本次研究没有复制外部源代码，也没有新增第三方依赖。后续若把某个项目的代码引入 Aa Browser，应先建立依赖许可证清单、保留原始版权声明，并在构建产物中提供 notices。

## 8. 建议的实施顺序

### P0：安全和数据边界

1. 统一工具 schema、错误码、大小限制和危险操作元数据。
2. 为 Cookie、Storage、请求/响应体、HAR、上传/下载加默认脱敏和路径/域名 containment。
3. 建立 session/profile/tab 的隔离、清理、异常恢复和审计事件。
4. 验证更新包签名、manifest 认证、安装回滚和旧版本升级链路。

### P1：核心 Agent 可靠性

5. 任务状态机、取消、重试/退避、超时、幂等和人工接管。
6. 增量快照版本号、ref 失效原因、跳转边界和恢复接口。
7. 基于固定页面夹具的动作/快照/网络回归 benchmark。
8. 录制动作到可回放脚本，输出结构化结果和诊断关联 ID。

### P2：产品能力和诊断

9. workspace/space 与任务列表。
10. 性能 trace、导航瀑布、页面健康摘要、内存/长运行指标。
11. 可解释的隐私预设、站点权限面板和 Agent 权限提示。
12. 插件/工具扩展契约、版本兼容矩阵和开发者文档。

### P3：生态和高级能力

13. 更多客户端的可验证接入向导与诊断。
14. 多浏览器/远程 worker 的可选架构，而不是默认引入云服务。
15. 基准任务公开报告、可回放工件和社区贡献模板。

## 9. 研究来源

以下链接是本次核验的主要入口，页面状态以 2026-11-16 检查结果为准：

- [Chromium](https://github.com/chromium/chromium)
- [Electron](https://github.com/electron/electron)
- [Brave Browser](https://github.com/brave/brave-browser) / [brave-core](https://github.com/brave/brave-core)
- [Zen Browser](https://github.com/zen-browser/desktop) / [Zen Releases](https://github.com/zen-browser/desktop/releases)
- [Floorp](https://github.com/Floorp-Projects/Floorp)
- [LibreWolf GitHub mirror](https://github.com/librewolf-community/browser-linux) / [LibreWolf Codeberg](https://codeberg.org/librewolf)
- [qutebrowser](https://github.com/qutebrowser/qutebrowser)
- [Playwright](https://github.com/microsoft/playwright)
- [Puppeteer](https://github.com/puppeteer/puppeteer)
- [Selenium](https://github.com/SeleniumHQ/selenium)
- [WebdriverIO](https://github.com/webdriverio/webdriverio)
- [chromedp](https://github.com/chromedp/chromedp)
- [browser-use](https://github.com/browser-use/browser-use)
- [Skyvern](https://github.com/Skyvern-AI/skyvern)
- [Stagehand](https://github.com/browserbase/stagehand)
- [BrowserGym](https://github.com/ServiceNow/BrowserGym)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Browserless](https://github.com/browserless/browserless)

## 10. 结论

Aa Browser 不需要变成另一个通用浏览器，也不需要复制某一个 Agent 框架。它已经拥有“可见 Chromium 浏览器 + MCP + 结构化快照 + 网络透明度”的明确组合优势。最有价值的升级方向是把现有工具面收敛成可版本化、可审计、可恢复、可回归的 Agent 平台：先完成权限和数据边界，再补任务状态、录制回放、workspace 和 benchmark，最后扩展插件、性能诊断和发布生态。

本报告给出的 19 个项目和借鉴决策将作为 `UPGRADE_ROADMAP.md` 中 EV 项目的对标依据；每个 EV 项目仍需在实际代码、测试和许可证审查中单独验收。
