# Aa Browser 升级路线图

> 制定日期：2026-11-16（Asia/Shanghai）
> 依据：`PROJECT_AUDIT.md`、`COMPETITOR_ANALYSIS.md`、源码与本地验证结果
> 编号规则：每一项都是可以独立实施和验收的升级，状态以本工作区为准。

## 优先级定义

- **P0**：安全边界、数据泄露、严重发布信任问题或核心功能缺陷。
- **P1**：核心 Agent 体验、可靠性和重要能力缺口。
- **P2**：性能、架构、诊断和规模化能力。
- **P3**：高级体验、生态、跨平台和工程化完善。

## P0：安全与发布信任

### EV-001 — 只允许安全网页协议导航

- **模块**：标签导航、站点白名单。
- **当前问题**：空白名单曾放行 `file:`, `data:`, `devtools:`, `view-source:` 等非 HTTP(S) 输入。
- **依据**：`src/main/tabs.ts` 的 `normalizeUrl()` 接受这些 scheme，原 `isUrlAllowed()` 对非 HTTP(S) 返回 `!rules.length`。
- **对标参考**：Playwright MCP 的路径/导航边界；Brave/LibreWolf 的隐私默认值。
- **参考实现方式**：先校验协议，再应用站点规则；只有精确的新标签页内部 URL 允许绕过协议检查。
- **改进方案**：拒绝所有非 HTTP(S) 目标，保留内部新标签页初始化路径。
- **预期效果**：阻止本地文件、数据页和调试协议绕过白名单。
- **文件或模块**：`src/main/tabs.ts`、`scripts/test-desktop.mjs`。
- **难度**：低。
- **优先级**：P0。
- **验收标准**：`file/data/view-source` 通过 UI 和 MCP 导航均失败；普通 HTTP(S) 与新标签页仍可用。
- **状态**：已实施，`npm run test:desktop` 已通过。

### EV-002 — GitHub Release 安装器强制校验 digest

- **模块**：通用安装器。
- **当前问题**：Release 缺少或格式错误的 digest 时原逻辑只告警并继续安装。
- **依据**：`install.mjs` 原 `verifyArtifact()` 对无效 digest 返回；Release workflow 生成的 SHA-256 清单原先不被安装器消费。
- **对标参考**：Brave/LibreWolf 的签名与资产校验流程；GitHub Release 资产 digest。
- **参考实现方式**：远程资产必须有严格格式的 `sha256:<64 hex>`，校验失败立即终止。
- **改进方案**：`--repo` 默认要求 digest；显式 `--sha256` 严格校验；本地文件保留可选校验。
- **预期效果**：避免中间人或损坏下载被当作官方安装包执行。
- **文件或模块**：`install.mjs`、`scripts/test-security.mjs`。
- **难度**：低。
- **优先级**：P0。
- **验收标准**：缺少、格式错误和错误哈希均非零退出；有效本地安装路径行为保持兼容。
- **状态**：已实施，Node 安全回归已加入。

### EV-003 — 敏感网络数据人工审批

- **模块**：网络详情与 HAR 导出。
- **当前问题**：`includeSensitive:true` 会返回认证头/凭据参数或写入 HAR，缺少与其他高危动作一致的人工确认。
- **依据**：`src/main/tools.ts` 只有默认脱敏，没有把敏感网络披露接入 `ApprovalManager`。
- **对标参考**：Browser Use 的 typed secret/redaction；Skyvern 的 secret scrubbing。
- **参考实现方式**：敏感字段默认脱敏；显式披露在高危审批开关开启时进入审批队列。
- **改进方案**：网络详情和 HAR 在 `includeSensitive:true` 时调用 `opGate()`。
- **预期效果**：减少 Agent 无提示读取或落盘认证数据的风险。
- **文件或模块**：`src/main/tools.ts`。
- **难度**：低。
- **优先级**：P0。
- **验收标准**：审批开启时未批准调用失败；批准后返回原有数据；默认脱敏行为不变。
- **状态**：已实施，类型检查和桌面审批拒绝场景均已通过。

### EV-004 — Windows 安装包代码签名

- **模块**：electron-builder、Release CI。
- **当前问题**：安装器没有 Authenticode 签名，SmartScreen 仍会显示未知发布者。
- **依据**：`electron-builder.yml` 无证书配置，`docs/AUTO_UPDATE.md` 明确记录未签名。
- **对标参考**：Brave、LibreWolf 的签名 key/发布资产流程。
- **参考实现方式**：CI 使用 secret 注入证书，构建后用 `signtool verify` 校验发布者和时间戳。
- **改进方案**：配置 `CSC_LINK`/`CSC_KEY_PASSWORD` 或等价签名服务；签名验证成为发布门禁。
- **预期效果**：提升 Windows 安装信任，降低仿冒包风险。
- **文件或模块**：`electron-builder.yml`、`.github/workflows/ci.yml`、`docs/AUTO_UPDATE.md`。
- **难度**：中（需要证书和 CI secret）。
- **优先级**：P0。
- **验收标准**：公开 Release 的 exe 签名有效、证书链可验证、CI 在签名缺失时失败。
- **状态**：未实施，依赖发布证书。

### EV-005 — 发布来源和依赖供应链校验

- **模块**：Release workflow、Electron 下载。
- **当前问题**：CI 使用外部 Electron mirror，尚无完整来源固定、缓存和 provenance 记录。
- **依据**：`.github/workflows/ci.yml` 的 `ELECTRON_MIRROR`；发布资产只生成 SHA-256 清单。
- **对标参考**：Chrome DevTools MCP 的自动 release 检查；Brave 的渠道化发布。
- **参考实现方式**：固定依赖 lockfile、记录构建环境和来源，校验 Electron artifact 后再打包。
- **改进方案**：建立可信 mirror allowlist、缓存摘要和构建 provenance/SBOM。
- **预期效果**：减少构建源漂移和不可复现发布。
- **文件或模块**：`.github/workflows/ci.yml`、`package-lock.json`、`docs/AUTO_UPDATE.md`。
- **难度**：中。
- **优先级**：P0。
- **验收标准**：构建日志能追溯 Node/Electron/依赖版本和摘要；来源异常时失败。
- **状态**：未实施。

### EV-006 — 高风险文件路径策略统一

- **模块**：HAR、上传、下载、截图、PDF。
- **当前问题**：各工具分别处理路径和输出，缺少统一的路径边界、符号链接和敏感目录策略。
- **依据**：`src/main/tools.ts`、`src/main/actions.ts`、`src/main/downloads.ts` 分散处理文件参数。
- **对标参考**：Playwright MCP 的路径穿越检查和上传限制；Browserless 的隔离边界。
- **参考实现方式**：集中校验绝对路径、工作目录、文件大小、扩展名和符号链接。
- **改进方案**：增加 `path-policy` 模块并让所有文件工具复用。
- **预期效果**：降低 Agent 读写用户私密目录或覆盖任意文件的风险。
- **文件或模块**：新增 `src/main/path-policy.ts`，修改 `tools.ts`、`actions.ts`、`downloads.ts`。
- **难度**：中。
- **优先级**：P0。
- **验收标准**：越界、符号链接逃逸、超大文件和不允许扩展名均被拒绝；默认目录正常工作。
- **状态**：未实施。

## P1：核心 Agent 能力与可靠性

### EV-007 — 快照协议版本与 ref 失效原因

- **模块**：快照引擎、工具协议。
- **当前问题**：快照有版本字段，但 ref 失效主要依赖通用错误文本，Agent 难以区分跳转、重渲染和超时。
- **依据**：`src/shared/types.ts`、`src/snapshot/engine.js`、`src/main/actions.ts`。
- **对标参考**：Playwright MCP accessibility snapshot 与 locator 错误；Stagehand observe/extract 分层。
- **参考实现方式**：返回结构化 `snapshotVersion`、`refStatus` 和失效原因。
- **改进方案**：在工具错误与快照元数据中加入可选字段，保持文本兼容。
- **预期效果**：减少重复快照和错误重试。
- **文件或模块**：`shared/types.ts`、`snapshot/engine.js`、`actions.ts`、`tools.ts`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：导航、DOM 大变更、目标删除和超时分别返回可识别原因。
- **状态**：未实施。

### EV-008 — 统一 timeout、取消和等待语义

- **模块**：所有 MCP 动作。
- **当前问题**：导航、settle、审批、桥调用各自有超时，用户难以预测调用最长时间。
- **依据**：`actions.ts` 的导航/settle、`approvals.ts` 的审批上限、`cli/mcp.mjs` 的调用上限分散定义。
- **对标参考**：Playwright 的 timeout/expect 等待；Puppeteer/CDP 生命周期。
- **参考实现方式**：定义工具级 timeout 配置、AbortSignal 传递和统一错误码。
- **改进方案**：共享 `ExecutionContext`，记录 deadline、取消来源和实际耗时。
- **预期效果**：减少 MCP 超时后主进程仍继续执行的悬挂任务。
- **文件或模块**：`shared/types.ts`、`actions.ts`、`agent-server.ts`、`cli/mcp.mjs`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：取消后动作停止或明确不可取消；所有超时错误包含工具名、阶段和 deadline。
- **状态**：未实施。

### EV-009 — 失败分类与有限重试

- **模块**：导航、网络、上传下载和 MCP bridge。
- **当前问题**：临时网络错误、页面拒绝和参数错误主要以字符串区分，没有统一 retryable 标记。
- **依据**：`ActionError` 和 `agent-server.ts` 当前只返回 error 文本。
- **对标参考**：Skyvern workflow/error taxonomy；Browser Use 的超时和错误状态。
- **参考实现方式**：错误包含 `code`, `retryable`, `afterMs` 和安全上下文。
- **改进方案**：仅对连接重置、导航中断等临时错误做指数退避，参数/权限错误不重试。
- **预期效果**：提高临时故障恢复率，避免重复提交。
- **文件或模块**：`shared/types.ts`、`agent-server.ts`、`actions.ts`、`tools.ts`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：模拟断网只重试有限次数；表单提交和高危动作不自动重复。
- **状态**：未实施。

### EV-010 — 可恢复 Agent 任务状态

- **模块**：MCP 服务、工作流状态。
- **当前问题**：多步任务状态只在客户端和当前进程中存在，浏览器重启后无法恢复检查点。
- **依据**：当前 `AgentServer` 只维护 WebSocket 调用和 AbortController，没有任务持久化。
- **对标参考**：Skyvern workflow/state；BrowserGym 可重复任务。
- **参考实现方式**：为任务保存步骤、目标 tab、快照摘要、审批状态和最后错误。
- **改进方案**：增加可选本地任务存储，默认只保留最近任务并提供清理。
- **预期效果**：网络断开或应用重启后可从安全检查点继续。
- **文件或模块**：新增 `src/main/tasks.ts`、`shared/types.ts`、`agent-server.ts`。
- **难度**：高。
- **优先级**：P1。
- **验收标准**：中断后可恢复未提交步骤；敏感输入和高危动作不会自动重放。
- **状态**：未实施。

### EV-011 — 会话/profile 生命周期可视化

- **模块**：标签和隔离会话。
- **当前问题**：隔离分区能清理，但清理失败、占用和残留状态没有用户可见诊断。
- **依据**：`src/main/sessions.ts`、`tabs.ts` 的分区清理逻辑；审计已确认异常退出需要启动扫描。
- **对标参考**：Playwright MCP storage state 隔离；Zen/Floorp 的 workspace/session 组织。
- **参考实现方式**：显示会话 ID、创建时间、清理结果和残留目录大小。
- **改进方案**：设置面板增加会话管理与“一次性清理”操作。
- **预期效果**：降低登录态混用和磁盘残留排查成本。
- **文件或模块**：`sessions.ts`、`tabs.ts`、renderer settings。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：普通/隔离标签可识别；关闭后清理成功或显示可操作错误。
- **状态**：未实施。

### EV-012 — 工作空间/任务空间

- **模块**：浏览器外壳、标签管理。
- **当前问题**：多任务 Agent 只能依赖标签顺序，缺少按项目/站点/任务分组。
- **依据**：`TabInfo` 只有单层 tabs，当前没有 workspace 数据结构。
- **对标参考**：Zen Browser spaces、Floorp workspace/sidebery 思路。
- **参考实现方式**：workspace 持有标签集合、隔离策略、名称和恢复快照。
- **改进方案**：先实现本地轻量分组，不改变普通标签默认行为。
- **预期效果**：提高长任务、多站点和多 Agent 并行时的可控性。
- **文件或模块**：`shared/types.ts`、`tabs.ts`、renderer chrome、持久化。
- **难度**：高。
- **优先级**：P1。
- **验收标准**：创建、切换、关闭和重启恢复 workspace；Agent 能按 workspace 指定 tab。
- **状态**：未实施。

### EV-013 — 网络响应体上限与类型策略

- **模块**：网络抓包、响应体工具。
- **当前问题**：`Network.getResponseBody` 和文本截断需要更明确的二进制、压缩和大响应处理策略。
- **依据**：`network.ts` 只限制 HAR/文本输出，响应体按调用获取。
- **对标参考**：Chrome DevTools MCP/Puppeteer 的 network detail；Playwright 的响应大小保护。
- **参考实现方式**：按 MIME、编码和字节数返回摘要或截断标记。
- **改进方案**：引入最大字节数、base64 明确标记和可选落盘路径。
- **预期效果**：避免大响应阻塞 MCP 或占满内存。
- **文件或模块**：`network.ts`、`tools.ts`、`shared/types.ts`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：超限响应不被完整读入桥；文本/二进制结果可区分且有大小信息。
- **状态**：未实施。

### EV-014 — 抓包数据默认脱敏存储

- **模块**：NetworkCapture。
- **当前问题**：当前 MCP 输出默认脱敏，但原始请求/响应头仍保留在进程内存。
- **依据**：`src/main/network.ts` 的 `NetRequest` 保存原始 headers，`safeNetworkHeaders()` 在输出边界才处理。
- **对标参考**：Browser Use typed secret/redaction；Skyvern secret scrubbing。
- **参考实现方式**：捕获时按字段分级保存，敏感值只保留存在性/摘要，显式审批后再从 CDP 请求原值。
- **改进方案**：默认不保存 Cookie/Authorization/token；对调试需求提供短期、审批保护的原值读取。
- **预期效果**：减少内存转储和崩溃日志泄露风险。
- **文件或模块**：`network.ts`、`tools.ts`、`approvals.ts`。
- **难度**：高。
- **优先级**：P1。
- **验收标准**：默认内存条目不含敏感值；审批路径仍可按请求 ID 获取一次性数据。
- **状态**：未实施。

### EV-015 — Agent 敏感操作审计日志

- **模块**：审批、动作记录、诊断。
- **当前问题**：活动抽屉记录工具摘要，但没有统一记录审批者、结果、敏感披露和文件目标。
- **依据**：`ActionLogItem` 只有 tool/summary/ts/isError。
- **对标参考**：Chrome DevTools MCP 的诊断可见性；企业浏览器审计思路。
- **参考实现方式**：结构化记录动作 ID、tab、站点、风险等级、审批结果和脱敏路径。
- **改进方案**：增加本地可选审计文件和 UI 过滤，不记录正文秘密。
- **预期效果**：便于复盘 Agent 行为和定位误操作。
- **文件或模块**：`shared/types.ts`、`index.ts`、`approvals.ts`、renderer feed。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：审批、敏感披露、文件写入和失败动作可查询；日志不含秘密正文。
- **状态**：未实施。

### EV-016 — 客户端接入健康检查和修复

- **模块**：`cli/setup.mjs`、设置面板。
- **当前问题**：配置写入、客户端加载、bridge 认证和首次工具调用是不同状态，当前主要靠提示文字区分。
- **依据**：README 已明确写入不等于实际接通；`clients.ts` 负责检测和写入但缺少持续诊断。
- **对标参考**：Playwright MCP/Chrome DevTools MCP 的工具契约检查；WorkBuddy connector 验证脚本。
- **参考实现方式**：显示配置路径、备份、进程重启、握手、工具调用四阶段状态。
- **改进方案**：加入“重新生成/检查/复制诊断”按钮，保留其他 MCP 配置。
- **预期效果**：降低首次接入失败和错误归因。
- **文件或模块**：`clients.ts`、`renderer/src/chrome.ts`、`cli/setup.mjs`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：每个客户端显示明确阶段；配置损坏时不覆盖原文件并给出恢复路径。
- **状态**：未实施。

### EV-017 — 更新通道元数据与回滚检查

- **模块**：electron-updater、Release workflow。
- **当前问题**：稳定/Beta 设置存在，但单一 `latest.yml` 与 prerelease 资产关系没有真实 Release 验证。
- **依据**：`src/main/updater.ts`、`electron-builder.yml`、`docs/AUTO_UPDATE.md`。
- **对标参考**：Brave/Zen 的渠道化发布和更新修复节奏。
- **参考实现方式**：稳定和 Beta 使用明确 prerelease/channel 元数据，下载后检查版本、签名和安装结果。
- **改进方案**：增加本地元数据校验、旧版本回退说明和线上 prerelease 测试流程。
- **预期效果**：减少 Beta 误装稳定版或更新后无法启动的风险。
- **文件或模块**：`updater.ts`、`.github/workflows/ci.yml`、`docs/AUTO_UPDATE.md`。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：稳定/Beta 只选择对应 Release；失败更新保留旧版本并可恢复。
- **状态**：未实施，线上依赖未满足。

### EV-018 — 导航失败与离线状态页

- **模块**：页面视图、外壳 UI。
- **当前问题**：`did-fail-load` 主要写日志，Agent 和用户看到的页面反馈有限。
- **依据**：`src/main/tabs.ts` 的失败事件处理；没有统一错误页状态模型。
- **对标参考**：Chromium/Brave 的错误页面；Playwright 的导航错误分类。
- **参考实现方式**：区分 DNS、证书、拒绝、超时和用户取消，提供重试/复制错误/返回操作。
- **改进方案**：增加 tab error 状态与可访问错误面板，不覆盖真实 URL。
- **预期效果**：用户能理解失败原因，Agent 可稳定读取错误状态。
- **文件或模块**：`TabInfo`、`tabs.ts`、renderer chrome、tools。
- **难度**：中。
- **优先级**：P1。
- **验收标准**：模拟离线/拒绝/超时后 UI 和 MCP 返回不同错误码与重试入口。
- **状态**：未实施。

## P2：性能、诊断与规模化

### EV-019 — 页面性能摘要工具

- **模块**：CDP/诊断工具。
- **当前问题**：已有 console/network，但缺少导航耗时、DOMContentLoaded、LCP 等结构化摘要。
- **依据**：`tools.ts` 没有性能 trace/Lighthouse 类工具。
- **对标参考**：Chrome DevTools MCP 的 Lighthouse/performance 诊断。
- **参考实现方式**：通过 Performance/Tracing 域采集短窗口指标，返回摘要而非原始巨量 trace。
- **改进方案**：新增 `browser_performance` 只读工具和可选 trace 文件。
- **预期效果**：Agent 能判断页面慢在网络、脚本还是渲染。
- **文件或模块**：`network.ts` 或新增 `performance.ts`、`tools.ts`、README。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：本地夹具返回稳定指标；trace 超时和大小受限。
- **状态**：未实施。

### EV-020 — 导航瀑布和错误聚合

- **模块**：网络捕获、UI 诊断。
- **当前问题**：请求列表是平面数组，缺少按文档/子资源/失败原因聚合。
- **依据**：`NetworkCapture.requests()` 仅筛选列表。
- **对标参考**：Puppeteer/CDP network events；Chrome DevTools Network 面板。
- **参考实现方式**：按 navigationId、resourceType、域名和失败类型聚合。
- **改进方案**：增加摘要模式，不改变现有明细工具。
- **预期效果**：长页面诊断更快、更省 token。
- **文件或模块**：`network.ts`、`tools.ts`。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：相同夹具下返回请求总数、失败数、关键域名和耗时排序。
- **状态**：未实施。

### EV-021 — 版本化 Agent benchmark

- **模块**：scripts、CI。
- **当前问题**：有 smoke/desktop，但没有固定任务集、评分和跨版本比较。
- **依据**：当前测试脚本以断言通过为主，没有 benchmark result schema。
- **对标参考**：BrowserGym/AgentLab、Playwright fixtures。
- **参考实现方式**：本地 HTTP fixtures + 任务 JSON + 结果快照 + 版本化评分。
- **改进方案**：建立 10 个无外网 Agent 场景，记录成功率、步骤数、耗时和 token 近似值。
- **预期效果**：升级前后可比较行为和性能。
- **文件或模块**：新增 `benchmarks/`、`scripts/benchmark.mjs`、CI。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：同一 commit 可重复运行并生成机器可读报告；失败场景保留证据。
- **状态**：未实施。

### EV-022 — 多标签并发预算与队列

- **模块**：AgentServer、TabManager、网络抓包。
- **当前问题**：多个 MCP 调用可并行进入同一 tab，缺少每 tab/客户端并发上限。
- **依据**：`AgentServer.active` 按 WebSocket 保存 AbortController，但不限制同 tab 竞态。
- **对标参考**：chromedp context/任务取消；Browserless 浏览器池并发隔离。
- **参考实现方式**：按 tab 和工具类别设置并发槽位，动作互斥，读取可并发。
- **改进方案**：加入队列、排队超时和冲突错误。
- **预期效果**：减少双击、交错输入和 debugger 竞争。
- **文件或模块**：`agent-server.ts`、`tools.ts`、`tabs.ts`。
- **难度**：高。
- **优先级**：P2。
- **验收标准**：同 tab 并发动作按策略串行；取消排队调用不执行；不同 tab 可并行。
- **状态**：未实施。

### EV-023 — console/network/snapshot 内存预算

- **模块**：日志、网络和快照缓存。
- **当前问题**：各模块各自限制条目或文本，缺少总字节预算和长时间运行指标。
- **依据**：`network.ts` 的 MAX_ENTRIES、tab consoleBuf 和快照缓存分散。
- **对标参考**：Chrome DevTools 的 ring buffer；Browser Use 的成本/可观测性。
- **参考实现方式**：按字节和条目双重上限，淘汰时记录计数。
- **改进方案**：统一 `BoundedBuffer`，UI 显示当前占用和淘汰数。
- **预期效果**：多标签长时间运行不被诊断数据拖垮。
- **文件或模块**：新增 `bounded-buffer.ts`，修改 `network.ts`、`tabs.ts`、snapshot。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：压力夹具下内存占用保持在预算内，数据淘汰可观测。
- **状态**：未实施。

### EV-024 — 快照缓存和 patch 压缩

- **模块**：snapshot engine、MCP bridge。
- **当前问题**：增量快照已存在，但跨调用缓存生命周期和 patch 大小没有指标。
- **依据**：README 声称增量省 token，代码未提供成本/命中统计。
- **对标参考**：Playwright MCP 的结构化 snapshot；Stagehand 的 observe/extract。
- **参考实现方式**：缓存以 tab + document epoch 隔离，patch 只保留必要节点。
- **改进方案**：增加缓存命中、patch 字节数和完整回退原因。
- **预期效果**：降低重复快照成本并避免跨页面引用污染。
- **文件或模块**：`snapshot/engine.js`、`actions.ts`、`shared/types.ts`。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：导航后旧 ref 不可用；小 DOM 变化返回可重放 patch；大变化自动 full。
- **状态**：未实施。

### EV-025 — 上传/下载取消、校验和恢复

- **模块**：文件上传、下载追踪。
- **当前问题**：下载有进度和状态，但缺少用户取消、校验和、断点或失败恢复策略。
- **依据**：`downloads.ts` 记录状态，工具面主要提供查看/打开/显示。
- **对标参考**：Playwright MCP 文件上传错误恢复；Browser Use 下载上传能力。
- **参考实现方式**：下载 ID 绑定 cancel、hash、重试和临时文件重命名。
- **改进方案**：先增加取消和完成后原子 rename，再评估断点续传。
- **预期效果**：减少半文件和失控下载。
- **文件或模块**：`downloads.ts`、`tools.ts`、renderer download panel。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：取消不会留下可误用的最终文件；完成后 hash/大小可查询。
- **状态**：未实施。

### EV-026 — Cookie/Storage 最小权限和导出格式

- **模块**：cookies/storage 工具。
- **当前问题**：工具支持读写，但缺少按站点/字段的最小权限提示和结构化导出版本。
- **依据**：`tools.ts` 的 `browser_cookies`、`browser_storage` 具备读写动作。
- **对标参考**：Playwright storage state 隔离；Brave/LibreWolf 隐私设置。
- **参考实现方式**：读写分开注解、危险字段标记、按 origin 限定、导出 schema 版本化。
- **改进方案**：默认只读，写入和跨站导出接入审批与审计。
- **预期效果**：降低登录态误用和跨站数据泄露。
- **文件或模块**：`tools.ts`、`actions.ts`、`approvals.ts`、`shared/types.ts`。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：写入/清除/跨站导出显示风险并可审批；旧格式仍可读。
- **状态**：未实施。

### EV-027 — MCP 工具 registry 版本化

- **模块**：工具契约、bridge、README。
- **当前问题**：已有三方一致性检查，但没有工具 schema 版本和兼容窗口。
- **依据**：`check-tools.mjs` 检查名称/数量/README，协议没有 registry version。
- **对标参考**：Playwright MCP、Chrome DevTools MCP 的 changelog/release 约束。
- **参考实现方式**：工具清单带版本、弃用时间和 capability negotiation。
- **改进方案**：bridge 握手返回 registry version；未知工具给出兼容建议。
- **预期效果**：降低客户端缓存旧工具定义造成的失败。
- **文件或模块**：`tools.ts`、`agent-server.ts`、`cli/mcp.mjs`、README。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：旧 bridge 能获得明确不兼容错误；新增可选字段不破坏旧客户端。
- **状态**：未实施。

### EV-028 — 结构化错误码和 typed result

- **模块**：WS/MCP 协议。
- **当前问题**：错误主要是字符串，客户端无法稳定判断权限、过期 ref、超时、重试和用户拒绝。
- **依据**：`WsResponse.error?: string`、`ActionError`。
- **对标参考**：Browser Use typed result；Skyvern 错误码修复；Playwright locator errors。
- **参考实现方式**：保留 message，同时增加 code/details/retryable。
- **改进方案**：为导航、定位、审批、文件、调试器和协议错误定义有限枚举。
- **预期效果**：客户端能做安全的自动恢复和更清晰的用户提示。
- **文件或模块**：`shared/types.ts`、`agent-server.ts`、`actions.ts`、`tools.ts`。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：现有文本兼容；关键错误具有稳定 code，敏感数据不进入 details。
- **状态**：未实施。

### EV-029 — Agent 动作录制与回放

- **模块**：动作日志、测试脚本。
- **当前问题**：活动抽屉只显示摘要，无法把一次人工/Agent 操作重放为可审查脚本。
- **依据**：`ActionLogItem` 不保存参数、快照版本或结果摘要。
- **对标参考**：Playwright MCP 的录制为 Playwright code；Stagehand act/observe。
- **参考实现方式**：保存脱敏的工具调用、页面 URL、ref 标签和结果摘要。
- **改进方案**：提供“导出回归脚本”而非自动执行导入。
- **预期效果**：把一次成功任务沉淀为可回归的 fixture。
- **文件或模块**：`index.ts`、`tools.ts`、renderer feed、scripts。
- **难度**：高。
- **优先级**：P2。
- **验收标准**：敏感参数被替换；导出的脚本在本地 fixture 可人工确认后执行。
- **状态**：未实施。

### EV-030 — 表单动作 schema 和提交边界

- **模块**：`browser_fill_form`、敏感输入审批。
- **当前问题**：批量填表已有能力，但字段语义、提交按钮和站点变化的反馈还不统一。
- **依据**：`tools.ts`/`actions.ts` 的表单动作与提交逻辑分散。
- **对标参考**：Playwright locator/form APIs；Browser Use typed secrets。
- **参考实现方式**：返回每字段状态、失败原因和是否触发提交；敏感字段统一标记。
- **改进方案**：增加 dry-run/validate-only 模式，提交仍走审批策略。
- **预期效果**：减少部分填写成功却误以为提交成功的情况。
- **文件或模块**：`actions.ts`、`tools.ts`、`shared/types.ts`。
- **难度**：中。
- **优先级**：P2。
- **验收标准**：字段缺失、不可编辑、敏感和提交状态逐项返回。
- **状态**：未实施。

## P3：产品体验、生态与长期工程化

### EV-031 — 可访问性与键盘可达性审计

- **模块**：renderer chrome/newtab。
- **当前问题**：已有 focus-visible 和 reduced-motion，但没有系统化 keyboard/ARIA 检查。
- **依据**：`style.css` 有部分可访问性规则，缺少自动审计和焦点顺序报告。
- **对标参考**：qutebrowser 键盘优先；Playwright locator/accessibility。
- **参考实现方式**：为标签、状态胶囊、设置、审批、下载和更新面板定义焦点环路。
- **改进方案**：加入无鼠标桌面回归与可访问性 lint/检查。
- **预期效果**：键盘用户和 Agent 辅助操作更稳定。
- **文件或模块**：renderer HTML/CSS/TS、`scripts/test-desktop.mjs`。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：所有主流程可用 Tab/Enter/Escape 完成；焦点不会落入隐藏面板。
- **状态**：未实施。

### EV-032 — 命令面板和快捷键帮助

- **模块**：浏览器外壳。
- **当前问题**：快捷键存在但分散在代码和 tooltip，用户难以发现。
- **依据**：`index.ts`/`chrome.ts` 注册 Ctrl+L/T/W/F 等快捷键，没有命令面板。
- **对标参考**：qutebrowser command mode；Zen/Floorp 的生产力布局。
- **参考实现方式**：统一命令 registry、搜索、快捷键提示和冲突检测。
- **改进方案**：增加 Ctrl+Shift+P 命令面板，命令直接调用现有 IPC。
- **预期效果**：减少鼠标操作，提高桌面效率。
- **文件或模块**：新增 command registry、renderer chrome/style、preload。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：命令可搜索、可键盘执行、不可用状态明确，快捷键不与网页冲突。
- **状态**：未实施。

### EV-033 — 主题、高 DPI 和缩放持久化

- **模块**：renderer、窗口布局。
- **当前问题**：界面已有暗色 HUD 风格，但主题/缩放/高 DPI 主要依赖系统默认。
- **依据**：`style.css` 固定颜色与窗口尺寸，设置类型没有主题和 zoom 字段。
- **对标参考**：Brave/Floorp/Zen 的主题和 workspace 体验。
- **参考实现方式**：CSS variables + 每 profile zoom + 系统 DPI 适配。
- **改进方案**：加入亮/暗/跟随系统和每站点缩放设置。
- **预期效果**：提高长时间使用舒适度和不同显示器适配。
- **文件或模块**：`settings.ts`、`shared/types.ts`、renderer CSS/TS、窗口布局。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：重启后主题/缩放保持；高 DPI 下标签、弹窗和页面边界不重叠。
- **状态**：未实施。

### EV-034 — 多语言资源化

- **模块**：renderer、主进程错误文本、README。
- **当前问题**：界面和错误大量中英混用，文本直接散落在源码。
- **依据**：`src/renderer` 和 `src/main` 中存在内联中文/英文字符串。
- **对标参考**：Electron/Brave 多语言资源组织；Playwright 多语言错误语义。
- **参考实现方式**：UI 文本 key 化，工具错误保留稳定 code 与本地化 message。
- **改进方案**：先抽取简体中文和英文，不改变 MCP 字段名。
- **预期效果**：降低翻译成本，改善国际开源协作。
- **文件或模块**：新增 `i18n/`、renderer、tools、docs。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：语言切换不影响工具协议；缺失 key 有稳定回退。
- **状态**：未实施。

### EV-035 — 崩溃恢复和会话恢复

- **模块**：窗口、标签、持久化。
- **当前问题**：普通标签只在当前进程保存最近关闭 URL，崩溃后不能恢复完整标签和 workspace。
- **依据**：`tabs.ts` 只维护内存 `recentlyClosed`；没有崩溃前快照。
- **对标参考**：Brave/Zen 的会话恢复；BrowserGym 的可重复环境。
- **参考实现方式**：安全保存 URL/title/isolated 标志，不保存敏感正文和临时 token。
- **改进方案**：异常退出后显示恢复提示，由用户选择恢复。
- **预期效果**：降低浏览器或系统崩溃造成的工作损失。
- **文件或模块**：新增 `sessions-store.ts`、`tabs.ts`、renderer。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：模拟崩溃后可恢复允许的 HTTP(S) 标签；隔离会话不泄露旧数据。
- **状态**：未实施。

### EV-036 — macOS/Linux 打包矩阵

- **模块**：electron-builder、CI。
- **当前问题**：正式目标只有 Windows NSIS，其他平台没有构建/安装证据。
- **依据**：`electron-builder.yml` 只配置 win target，README 标注 Windows 安装包。
- **对标参考**：Electron、Brave、Zen 的多平台发布。
- **参考实现方式**：按平台分离证书、产物、更新 provider 和权限策略。
- **改进方案**：先建立 Linux AppImage/dir 和 macOS dmg 的构建 smoke，再评估发布。
- **预期效果**：扩大用户覆盖，提前发现平台特有的 WebContents/路径问题。
- **文件或模块**：`electron-builder.yml`、`.github/workflows/ci.yml`、docs。
- **难度**：高。
- **优先级**：P3。
- **验收标准**：每个平台至少有构建、启动、MCP bridge 和基础桌面回归证据。
- **状态**：未实施。

### EV-037 — SBOM、依赖审计和安全公告流程

- **模块**：依赖、CI、文档。
- **当前问题**：有 lockfile 和 overrides，但没有固定的 npm audit、SBOM 和漏洞响应门禁。
- **依据**：package scripts/CI 没有 dependency audit 或 SBOM 步骤。
- **对标参考**：LibreWolf 的 CI/KEY/CHANGELOG 分层；Chrome DevTools MCP 的 SECURITY/CHANGELOG。
- **参考实现方式**：生成 SPDX/CycloneDX，记录 Electron/Node 版本和高危漏洞例外。
- **改进方案**：CI 定期审计并维护 SECURITY.md/披露流程。
- **预期效果**：依赖升级和漏洞响应可追溯。
- **文件或模块**：`.github/workflows`、`package.json`、`SECURITY.md`、docs。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：每次发布有 SBOM；高危漏洞无审批例外时阻断发布。
- **状态**：未实施。

### EV-038 — Windows 版本与显示器回归矩阵

- **模块**：桌面测试、CI。
- **当前问题**：当前桌面回归主要在单一 Windows runner，缺少高 DPI、多显示器和 Windows 版本矩阵。
- **依据**：`.github/workflows/ci.yml` 只有 `windows-latest`；源码有窗口 bounds/overlay 逻辑。
- **对标参考**：Zen release notes 对跨 space/窗口问题的修复；Electron 桌面约束。
- **参考实现方式**：固定 fixture 测量窗口、DPI、焦点、弹窗和更新条高度。
- **改进方案**：增加可选 self-hosted/手工矩阵记录，不把不可用环境伪装成 CI 通过。
- **预期效果**：减少真实用户显示器差异导致的 UI 回归。
- **文件或模块**：`scripts/test-desktop.mjs`、CI、docs。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：至少记录 100%/125%/150% DPI 和双屏布局结果。
- **状态**：未实施。

### EV-039 — 插件与工具扩展契约

- **模块**：MCP 工具 registry、第三方扩展。
- **当前问题**：工具全部静态注册，无法安全增加站点或团队工具而不修改主进程。
- **依据**：`buildTools()` 直接 push 固定定义，缺少插件生命周期和权限声明。
- **对标参考**：WebdriverIO runner/service/plugin；Stagehand packages/changesets。
- **参考实现方式**：签名/本地白名单插件，声明工具 schema、权限、版本和卸载。
- **改进方案**：先做进程内只读诊断插件，再评估隔离 worker。
- **预期效果**：形成可控生态，避免把任意代码直接注入页面权限边界。
- **文件或模块**：新增 plugin registry、`tools.ts`、settings、docs。
- **难度**：高。
- **优先级**：P3。
- **验收标准**：未授权插件不加载；插件工具显示来源和权限；卸载后无残留。
- **状态**：未实施。

### EV-040 — 文档与故障排查自动生成

- **模块**：README、release docs、诊断脚本。
- **当前问题**：工具表、安装、更新、客户端接入和限制信息分布在多个文档，容易漂移。
- **依据**：已有 `check-tools.mjs` 只检查工具三方一致，未生成完整用户文档。
- **对标参考**：Chrome DevTools MCP/Playwright MCP 的 CHANGELOG、SECURITY、工具文档组织。
- **参考实现方式**：从工具 registry 生成 README 表格、schema 摘要和版本变更模板。
- **改进方案**：加入文档检查和故障排查命令输出，保留人工产品说明。
- **预期效果**：减少文档与实际能力不一致，缩短支持排障时间。
- **文件或模块**：`scripts/check-tools.mjs`、README、docs、release workflow。
- **难度**：中。
- **优先级**：P3。
- **验收标准**：工具增删会让 CI 文档检查失败；诊断输出不包含 token/秘密。
- **状态**：未实施。

## 执行顺序

1. 先完成 EV-001 至 EV-006 的安全边界、发布信任和文件路径策略。
2. 再完成 EV-007 至 EV-018 的 Agent 协议、任务恢复、会话和敏感数据治理。
3. 以 EV-019 至 EV-030 建立性能、并发、诊断和可回放能力。
4. 最后推进 EV-031 至 EV-040 的桌面体验、跨平台和生态工程化。

本轮实际变更状态与证据见 [`UPGRADE_REPORT.md`](./UPGRADE_REPORT.md)。
