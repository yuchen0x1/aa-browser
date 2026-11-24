# Changelog

产品版本摘要见 [`docs/releases/release-notes.md`](./docs/releases/release-notes.md)，与 GitHub Release 逐字同步的正文归档位于 [`docs/releases/bodies/`](./docs/releases/bodies/)；新版本使用 [`release-notes-template.md`](./docs/releases/release-notes-template.md)。

## v0.17.0 — 2026-11-24

- **GitHub Release 智能下载**：公开更新先走 GitHub 官方线路；连接失败、持续低速或传输中断后，按线路评分尝试 GH-Proxy 和备用线路。支持有界重试、退避、冷却和 HTTP Range 断点续传，继续使用现有更新进度界面。
- **可信完整性校验**：更新包只接受从 GitHub 官方主机取得的 `SHA256SUMS.txt`，并同时核对更新元数据的文件大小与 SHA-512；安装器通过 GitHub Release API 核对公开资产摘要和大小。TLS、受限主机重定向、临时文件及校验失败禁止安装均保持 fail closed，凭据和身份请求头不会发送给代理。
- **完整包下载**：为让线路切换、续传和最终校验经过同一下载路径，应用内更新关闭 blockmap 差分下载；更新会下载完整安装包，可能增加流量和等待时间。
- **验证范围**：自动化覆盖的是模拟线路和 Electron 请求适配器；没有中国大陆网络环境或完整 Release 大包下载实测，不据此宣称大陆速度提升。

## v0.16.0 — 2026-11-24

- **持久任务中心**：`TaskCenter` 已接入 `AgentServer`，任务状态、步骤、执行历史、客户端来源、活动标签、Renderer PID、错误和恢复次数写入版本化 `task-center.json`；采用原子写入、损坏备份和有界裁剪。任务 ID 含客户端、调用序号和启动时间，桥或应用重启后复用请求 ID 也不会与旧终态记录撞键；`task-history.json` 丢失时仍可从有效 TaskCenter 重建记录。进程重启后非终态任务统一转为 `interrupted`，绝不自动重放。
- **副作用幂等账本与会话所有权**：新增独立 `task-idempotency.json`，危险写操作在执行前持久化 key；缺 key、重复 key、账本损坏或不可写均拒绝执行。TaskCenter 损坏不会抹去防重记录；MCP 任务查询按会话身份隔离，避免客户端数字 ID 重用导致越权。
- **真实崩溃恢复验证**：新增真实 Electron 故障注入套件，覆盖 `forcefullyCrashRenderer()`、系统级强杀、正常标签关闭、页面导航中崩溃、执行中崩溃、多标签隔离、恢复中再次崩溃、旧 Ref 失效和恢复次数耗尽；不再使用普通函数模拟崩溃。
- **Ref 代际管理**：快照、导航和渲染进程分别计数；导航后、渲染进程重启后或快照过期时旧 Ref 被拒绝，并返回 `NAVIGATION_ERROR` / `RENDERER_CRASH` / `STALE_REF` 等可操作错误。
- **操作预检**：点击、输入、清空、下拉选择前检查元素存在、DOM 连接、可见性、尺寸、原生/ARIA 禁用、只读和可编辑性；点击前要求连续定位稳定，DOM 兜底失败不再返回假成功。输入前二次核验焦点，inert/模态框或焦点陷阱无法把文本重定向到先前输入框。后台 DOM 兜底与视觉遮挡继续区分处理。
- **统一错误与恢复**：所有 `ActionError` 携带机器可读分类前缀；页面关闭、导航、网络、超时、Ref 失效、Renderer 崩溃和任务冲突分别归类。任务终态写入幂等，MCP 断线后同一会话可重连并查询原任务；`browser_tasks` 展示来源、标签、恢复次数、当前步骤和持久任务 ID。
- **原子写入加固**：Windows 杀毒软件或索引器短暂占用目标文件时，JSON 原子替换对 `EPERM`/`EACCES`/`EBUSY` 做有界重试；最终失败仍保留旧文件并清理临时文件。
- **Linux CI 验证门禁**：桌面矩阵重新纳入 `ubuntu-24.04`，新增崩溃恢复与 Ref 生命周期套件；v0.16.0 正式版提供 Windows x64 与 Linux x86_64 资产，Linux 范围限 Ubuntu 24.04 CI/Xvfb，不代表所有桌面发行版。

## v0.15.0 — 2026-11-24

- **Renderer recovery**: crashed or unresponsive tabs now expose a recovery state, perform bounded reload recovery, and report failure instead of silently remaining unusable.
- **Task state machine**: added a strict, auditable task lifecycle with recovery reasons, retry limits, and confirmation gates for high-risk retries.
- **Compatibility**: recovery metadata is optional in `TabInfo`, so existing MCP clients continue to work.
- **Windows-only release**: v0.15.0 publishes Windows x64 assets only. Linux packaging is temporarily held back after a Linux desktop regression failed in release CI.

## v0.14.0 — 2026-11-23

- **统一后台窗口策略**：新增 `visible`、`background`、`minimized`、`hidden` 和 `background-visual` 五种真实 Electron 模式；切换模式不重建标签、不破坏 Cookie、Storage 或登录态。
- **独立实时预览**：新增 `browser_window` 监控动作和工具栏预览面板，只捕获明确选择的标签页，限频传输并保留最近 20 张截图历史。
- **人工接管锁**：预览面板和 `browser_window takeover/release` 可暂停/交还 AI，暂停期间仅允许释放和任务管理控制调用，避免 AI 与人工输入竞态。
- **后台任务中心**：新增 `browser_tasks`，支持按 MCP 客户端列出并发调用、取消、暂停和恢复；原有按标签队列与渲染租约继续生效。
- **输入遥测与审计**：后台点击、拖拽、输入位置进入预览元数据；拖拽改用 Chromium `dragIntercepted` 返回的原生 DataTransfer 数据，不再发送合成文本。新增 `docs/BACKGROUND_CONTROL.md`，记录 15 项后台能力审计、特殊网站策略和竞品取舍。
- **回归覆盖**：真实 Electron + stdio MCP 后台套件 11 项通过，覆盖最小化 hover / 输入 / 滚动 / 原生拖放 / Enter 提交 / 截图、隐藏预览、窗口模式切换、审批唤醒、人工接管与释放、多客户端隔离、任务取消与队列释放、Windows 遮挡窗口；桌面回归 58/58、Windows 30 分钟 soak 和 DPI 100%–200% 矩阵均通过。物理多显示器、真实 DRM、第三方登录/2FA、生产签名、升级/回滚与崩溃注入恢复仍未验证。

### 工作流与 CI 修复

- **CI 拆分为 static / unit / desktop / release 四个 job**：静态检查与 Node-only 套件不再等待双平台 Electron，任一平台失败不再把其余套件直接标成 skipped。
- **隐藏窗口预览回归改为按平台断言**：Linux 无合成表面时报告可诊断错误；Windows 仍断言真实非空预览帧。
- **PR 触发收窄到 `main` 并取消过期运行**：同一 PR 的新推送会取消旧运行，`main` 推送与标签构建仍保持排队。
- **发布校验工作流**：使用 `release-verify.yml` 校验资产、摘要、元数据与正文归档，并由独立 `audit.yml` 执行依赖审计。

## v0.13.0 — 2026-11-23

- **Cloudflare 验证辅助**：新增 `browser_cloudflare`，可检查 `challenges.cloudflare.com` 跨域挑战 iframe、列出可见复选框，并等待验证稳定完成。
- **显式真实点击**：只有传入 `confirm:true` 才会对可见复选框发送一次真实鼠标事件；滑块、图片验证码和 Turnstile 仍由用户手动完成。
- **安全边界**：不读取、生成或注入 challenge token，不修改 Cookie、请求头或网络响应；普通跨域 iframe 不会被误判或点击。
- **回归与文档**：新增 Cloudflare 专项测试，工具契约、DSH 桥、README 和使用边界文档同步更新。

## v0.12.1 — 2026-11-23

- **网络响应体边界**：`browser_network_detail` 获取响应体时在主进程侧限制为最多 1 MiB，并明确区分文本、二进制和截断结果，避免超大响应完整穿过 MCP 桥。
- **响应体默认脱敏**：JSON 对象中的 token、密码、Cookie、授权、支付字段等敏感键，以及表单 / Bearer / Basic 文本凭据默认替换为 `[redacted]`；只有显式 `includeSensitive:true` 并通过既有审批后才返回原文。
- **回归覆盖**：新增网络响应体大小、UTF-8 截断、二进制摘要和内容级脱敏测试，并继续通过真实 Electron/MCP 抓包冒烟。

## v0.12.0 — 2026-11-23

- **加载已解压扩展**：设置中新增等价于 Chrome「加载已解压的扩展程序」的目录选择器，支持 MV2 / MV3 扩展并显示名称、版本和清单版本。
- **Agent 扩展管理**：新增 `browser_extensions`，可列出、加载和移除扩展；加载目录会校验 `manifest.json`，并在共享会话中对之后打开或刷新的页面生效。
- **跨重启恢复**：扩展目录写入 `~/.aabrowser/extensions.json`，启动时自动恢复；缺失目录会从恢复列表移除，隔离标签不装载共享扩展。
- **内部地址兼容**：地址栏输入 `chrome://extensions` 会直接打开 Aa Browser 设置中的扩展管理区；既有工具、客户端入口和用户数据格式保持兼容。

## v0.11.0 — 2026-11-22

- **等待与网络结果更可靠**：`browser_wait` 支持出现/消失条件的 OR 等待并返回实际满足项；网络请求/详情提供结构化状态、大小、耗时和重定向信息；Mock 支持 CORS 预检。
- **导出与快照更安全准确**：PDF/HAR 路径拒绝越界和符号链接；敏感 URL/请求头继续脱敏；快照区分节点、深度、文本和选项裁剪原因，不再把长文本误报为节点树截断。
- **后台与界面体验**：修复最小化视口恢复、下载打开/重试状态、客户端缺失桥提示、标签切换焦点、审批可访问性、首帧主题/语言闪烁、更新错误详情和打印取消反馈。
- 修复表单写入失败继续执行、对话框 once 类型串用、滚动/查找异步结果竞态、证据登记表损坏覆盖，以及桥无效帧无响应等问题；用户数据无需迁移。

## v0.10.0 — 2026-11-22

- **滚动结果可验证**：`browser_scroll` 返回真实前后位置、`didScroll`、`atLimit`、`visibilityState` 与未滚动原因；主文档不动时按请求方向尝试最大滚动容器并再次校验，不再把静默无操作报告为「已滚动」。
- **新增 `browser_page_state`**：一次返回 URL / 标题 / `readyState` / 可见性与焦点 / 滚动高度 / 可见弹窗与被拦截的原生对话框 / Cloudflare 验证 / 限流提示，并附带浏览器实例、标签 id 与创建时间。
- **标签与窗口控制**：`browser_tabs list` 显示实例 id、PID、版本、启动时间、标签创建时间与恢复标记；`select` 支持 `bringToFront: true` 恢复窗口并聚焦页面；未知 action 的错误列出可用值。
- **SPA 导航等待**：`browser_navigate` 支持 `waitFor: { selector | text | urlContains, timeoutMs }`，超时返回 `isError` 并附当前快照。
- **evaluate 序列化诊断**：循环引用 / BigInt / undefined / function 返回 `EVALUATE_RESULT_SERIALIZATION_FAILED` 的结构化类型、消息与预览，而不是只回字符串。
- 修复 `browser_get_selector` 中模板字符串吞掉反斜杠导致文本压缩正则与 `CSS.escape` 兜底失效的问题。
- MCP 工具数由 42 增至 43；README 与静态工具手册已同步。

## v0.9.1 — 2026-11-22

- **更新不再打断 AI 任务**：更新重启导致 WebSocket 断开时，只读且幂等的在途调用（快照、提取、截图、控制台、网络记录、断言等，以及 `browser_tabs` 的 `list`）会挂起并在新实例就绪后自动重发，AI 当前步骤继续拿到结果；点击、输入、提交等写操作不重放，只返回明确的「请重新读取页面状态」错误。
- **安装期间不抢启动**：退出安装前写入 `update-restart.json`，桥看到标记只等待新实例（默认 120 秒），不会与安装器争抢启动；新实例启动后清除标记。
- **标签 id 跨重启稳定**：会话记录升级到 v2，保存并复用标签 id，Agent 缓存的 `tabId` 在更新后继续有效；v1 记录仍可读取。MCP 服务在恢复页面完成首载后才开放，避免重放的快照读到 `about:blank`。
- **安装前确认**：AI 正在调用或等待审批时点击「重启安装」会先说明当前步骤将被中断，确认后才继续。
- **连接状态**：任意一次成功工具调用都会把客户端标记为已验证，重放恢复后不再停留在「等待 AI 首次调用」。
- 标签 CI 双平台与发布作业成功，7 项不可变资产核验通过；MCP 保持 42 个工具，无新增运行依赖或数据迁移。

## v0.9.0

- **最小化后台运行**：窗口最小化后 MCP 仍可导航、点击、输入、按键、滚动、快照、元素/整页截图与视觉基线对比；不显示、不恢复、不抢焦点，任务栏点击即可回到原标签。只有新增人工确认请求会唤起窗口。
- **静默冷启动**：MCP 桥冷启动以隐藏方式运行；用户手动启动应用会显示已在运行的同一窗口，不产生第二个实例。
- **后台视口与截图**：用 CDP 设备度量覆盖修复最小化后渲染视口为 0×0 导致的空快照；后台整页截图改为「临时扩展视口 + capturePage」并在结束后恢复，避免 `Page.captureScreenshot` 在最小化时永久挂起。视觉基线保存/对比走同一策略。
- 修复独立 DevTools 获得焦点后 F12 无法收起调试器，以及后台/非活动页误弹原生右键菜单；新增真实 Electron + stdio MCP 的后台回归并接入双平台 CI。
- 保持 42 个 MCP 工具与既有客户端入口；没有新增运行依赖或要求用户迁移配置。

## v0.8.0

- **同标签并发协调**：为受保护的 MCP 页面操作增加独立标签队列，补充排队取消边界与多项目接入说明。队列不是项目身份隔离或跨调用事务；各项目应始终显式使用自己的 `tabId`，不同登录态使用隔离标签，窗口和普通会话级资源仍共享。
- **标题栏拖动区**：保留系统原生拖动，新增不会被标签挤占的 72px 固定空白区域，不增加窗口移动 IPC。
- **开发者工具**：新增 F12，并统一 Ctrl+Shift+I 对当前网页 DevTools 的切换；焦点在地址栏或标签条时作用于活动网页，设置模态期间不打开。
- 保持 42 个 MCP 工具与既有客户端入口；没有新增运行依赖。

## v0.7.0

- 新增可共享的 AI 连接诊断，区分未连接、已认证及首调用已验证；本机详情保留端口和发现路径，复制文本不包含它们或令牌。
- MCP 快照的内部传输不再重复返回整份结构化元素数组，保留文本、分页和全树引用。状态更新和仅切换活动标签时保留标签 DOM 节点。
- 手动指定路径的 PDF/HAR、右键截图与未标记的历史证据不进入自动清理；自动产物继续受 TTL 与配额管理。Cookie 工具拒绝缺失或无效操作，写入与清除仍遵循原审批设置。
- Linux MCP 桥识别安装器的默认 AppImage 路径；SBOM 使用锁定的 Electron 精确版本。
- 保持 42 个 MCP 工具，不新增运行依赖或要求用户迁移配置。

## v0.6.12 — 2026-11-21

- 完善批量填表、点击/输入、选择、iframe 和 HAR 的取消检查，防止异步等待结束后继续分派下一步副作用；不回滚已完成动作。
- App/CLI 成功写配置后保留五份有效备份，固定保护本次恢复点，排除同前缀用户文件与链接；CLI 保持零依赖。
- JSONC 仅格式化新值，保留同行兄弟配置、空格/Tab 和特殊美元序列路径；TOML 更新对 EOF 换行与空白保持幂等。
- POSIX 只收紧自有非符号链接发现目录，保护已有自定义共享目录和路径别名；令牌文件继续 0600 原子替换。
- 新增 20 组取消回归（17 组真中途取消）、配置字节保真与备份边界回归；量化生产快照分页和历史同步写盘成本，未擅自改策略或宣称性能提升。
- 标签 CI 双平台、发布作业和不可变 Release 证明核验通过；MCP 仍为 42 个，无新增运行依赖或数据迁移。完整正文见 `docs/releases/bodies/v0.6.12.md`。

## v0.6.10 — 2026-11-21

- 修复 MCP 桥并发建立 WebSocket 与旧连接清理的竞态：握手单飞、pending 绑定 socket，旧连接关闭不会影响新连接调用；发送失败立即回收请求状态。
- 修复 iframe 元素枚举可能回显已填写的密码、令牌、API key、OTP 和支付字段值；保留安全标签与控件类型。
- 修复冷启动自动启动回归在 Chromium 异步释放 profile 锁期间过早清理导致的 Linux `ENOTEMPTY` 假失败。
- 新增桥连接并发、确定性连接生命周期与 `frameElements()` 敏感值三项回归并接入 CI；敏感描述覆盖中文标签、关联 label、data-testid 和支付 autocomplete。MCP 工具保持 42 个，无新增运行依赖或用户数据迁移。

## v0.6.9 — 2026-11-21

- 地址栏编辑与缩略显示分离，保留协议、编码参数和 hash 路由；重复 Ctrl/Cmd+L 全选、草稿取消和切换标签状态均有真实 Electron 回归。失焦只更新地址，保留停止/审批按钮的一次点击。
- 单调用停止按客户端与请求 ID 精确定位；歧义、无效和过期目标安全拒绝。同连接重复在途 ID 不覆盖原调用、不产生竞争响应，外部 MCP/WS 契约不变。
- 批量/iframe 输入补齐敏感字段人工填写流程并去掉值回显；iframe 求值遵循既有操作审批设置。权限待决审批绑定 Session、WebContents、文档及媒体子能力，旧文档审批失效。
- 证据清理增加文件身份/hash 核验，失败删除不虚减配额；旧临时登记保守遗忘但不删文件，保护被替换或修改的文件。未修改的显式输出仍沿用原 TTL。新增并发取消、审批一致性与权限专项测试及双平台 CI 门槛，桥自动启动也接入 CI。
- 保持 42 个 MCP 工具、现有数据和运行依赖；完整盘点、七项目开源对照、已知边界与后续优先级见 `docs/project-review-20261121.md`。正式发行与跨平台结果以标签 CI 为准。

## v0.6.8 — 2026-11-21

- 修复关闭原生窗口时会话文件被空标签覆盖的问题，保留普通标签顺序和活动标签。
- 修复 MCP stdio 请求含 Unicode 行、段落分隔符时被误拆而超时的问题；响应也兼容逐行读取客户端。
- 对话框策略和固定 iframe 动作复用脚本字面量编码，保持显式求值语义与 42 个 MCP 工具不变。用户数据无需迁移。
- 增加真实 Electron 关窗和 Unicode 数据往返回归；正式发行资产以标签 CI 验证为准。

## v0.6.7 — 2026-11-21

- 新标签接入教程全量中英双语，后端可见诊断（客户端接入结果、下载重试原因）按已保存语言输出；路径、命令与原始异常逐字保留，生成提示词保持原文。
- 新增 Ctrl/Cmd+P 打印快捷键与打印失败/取消的可见双语反馈；修复右键打印失败完全无反馈的问题。
- 修复新标签慢导航窗口内主题/语言同步脚本可能注入外站的竞态；冒烟测试隔离实例固定简体中文，修复 en-US 区域 CI 下向导断言超时。
- 新增 `test:newtab-i18n`、`test:app-i18n`、`test:main-diagnostics`（114 项）、`test:printing`（14 项）回归并接入 CI；本地 Windows、WSLg 真实 Linux renderer 与远程 CI 双平台通过。
- MCP 工具保持 42 个，既有设置、历史、Cookie、下载及会话数据无需迁移。

## v0.6.6 — 2026-11-20

- 修复设置禁用控件造成 Tab 焦点卡住、状态刷新丢失按钮焦点，以及方向键切换标签后焦点进入网页的问题；补齐 Left / Right / Home / End 与边界切换。
- 修复浅色下载完成状态、深色新标签提示及官网代码文字对比度；完善设置控件标签、焦点可见性和历史建议自动滚动。
- 修复最小窗口多提示条叠加时抽屉裁切，以及官网 390px 首屏横溢和移动导航断点不一致。
- 补齐基础尺寸、字体、动效 Token；新增桌面 UI/UX 38 项、官网 UI 44 项回归并接入 CI，DPI 矩阵扩展为 100% / 125% / 150% / 200%。
- MCP 工具保持 42 个，既有设置、历史、Cookie、下载及会话数据无需迁移；跨平台打包验证以本次 CI 结果为准。

## v0.6.5 — 2026-11-20

- 统一外壳与新标签页主题、完善英文文案和键盘焦点；发行说明与错误详情标明来源语言。
- 新增 Biome 独立 lint 并接入 check，新增 125% / 150% / 200% DPI 与显示器工作区回归。
- 清理 Electron 事件接口、初始化加载取消、favicon CSP、预期设置校验及 smoke 主动退出噪声。
- MCP 工具保持 42 个；本机三档 DPI 与单显示器边界已通过，多物理显示器遍历尚未实测。

## v0.6.4 — 2026-11-20

- 新增视觉评审闭环：`browser_visual_diff`（基线 / 逐像素 diff / 差异图 / 视觉断言）、`browser_contrast_audit`（WCAG AA/AAA 对比度审计）、`browser_viewport_matrix`（320/480/768/桌面 + 2x 高 DPI，CDP 设备指标模拟）。
- 长操作按 MCP 规范回传 `notifications/progress`；多客户端并发时 HUD 逐条展示调用与进度，支持只停止其中一个；全局「中断」保留。
- 工具 schema 单源化：新增 `src/shared/tool-defs.mjs`，主进程只保留 `name + handler`，桥直接导入；检查脚本升级为唯一来源 + 主进程 + 桥 + README 四方一致。
- 补齐长期限制：快照分页（`maxNodes/cursor`）、下载取消/重试（重试重新校验站点白名单）、摄像头/定位/通知走人工审批、证据文件生命周期（sha256/TTL/配额 + `browser_evidence`）、closed shadow DOM 可见可点击、原生右键菜单跟随语言并增加图片项与打印。
- 修复浅色主题下原生标题栏覆盖层仍为深色的问题；中断不再让长操作跑完；新增 `browser_frame` 跨域 iframe 操作与 `browser_screenshot fullPage` 整页截图。
- MCP 工具 34 → 42（新增 assert、dialog_respond、frame、visual_diff、contrast_audit、viewport_matrix、evidence 等）；新增 `npm run test:evidence` 并并入 `npm run check`。
- 本地回归：check、build、test:tools、test:bridge、test:bridge-autolaunch、smoke、test:desktop（34 项）全部通过。

## v0.3.0 — 2026-11-19

- 设置面板改版：960px 宽卡片 + 左侧分区导航（通用 / 浏览与快照 / 数据与下载 / AI 集成 / 软件更新），导航随滚动高亮并可点击跳转；设置项改为「左说明、右控件」两栏，原生复选框换成开关，保存栏吸底；窗口不足 1000px 时自动收起导航；中英文新增 13 条文案。
- 应用图标重做：透明满幅「方窗」，修复桌面快捷方式、任务栏与 favicon 四周白边；`npm run icon` 改用 Canvas 直接导出 PNG，一次生成应用图标、官网图标与 DSH 市场图标，且产物可重复。
- 安全：注入脚本的数据字面量统一走 `jsLiteral()` / `refLiteral()`（转义 `<` `>` `/` 与 U+2028/U+2029，`ref` 只放行 `^e\d+$`），避免 `</script>` 或行分隔符截断脚本；页面侧探针脚本集中到 `@snapshot/scripts`，`browser_evaluate` 错误文案不再拼接 `ref` 进源码。
- 新增 `npm run test:page-scripts` 并并入 `npm run check`；本地回归 check、test:tools、test:stores 11/11、test:security、test:updater 13/13、test:release 5/5、test:installer 4/4、test:bridge、smoke 18 组、test:desktop 26/26、test:update-ui 6/6 全部通过。

## v0.2.0 — 2026-11-19

- 新增通用安装/接入提示词：一段提示词发给任意具备本机执行能力的 AI，自动下载、校验、安装（Windows NSIS / Linux AppImage）、写入 MCP 配置并实际调用 `browser_tabs` 验证；已安装时用 `--connect-only` 只接入不重装。
- 新增 DeepSeek Harness 插件包 `packages/dsh/`（`aa-browser-dsh`）：插件市场安装后把随包 MCP 桥放到稳定路径，工具以 `mcp__aa-browser__*` 提供，无需系统 Node；配套 `check:dsh` 与市场条目。
- 安装器新增 `--connect-only`、`--verify`、`--verify-only`、`--print-config`、`--json` 与 Linux AppImage 安装；Windows/Linux 均校验 Release SHA-256 与文件头。提示词由 `installer/*.md` 单一来源生成，`check:prompt` 防漂移。
- 新增跨会话标签恢复（默认开启、可关闭）：恢复普通网页标签和活动标签，跳过隔离标签、内部页与非 HTTP(S) 地址，剥离 URL 凭据，原子写入且限制 20 条。
- 新增 `browser_performance` MCP 工具：导航/绘制/资源/堆/DOM 性能摘要，只读幂等；MCP 工具总数 34。
- 正式发行新增 CycloneDX SBOM 并纳入 `SHA256SUMS.txt`；发布与公开校验脚本强制核对 SBOM。
- 修复冒烟测试在继承 `ELECTRON_RUN_AS_NODE=1` 的 shell 中无法启动 Electron 的问题。
- 修复 Aa Browser 未运行时 MCP `tools/call` 无响应、客户端挂到超时的问题；桥始终返回 `isError` 工具结果，并新增离线回归测试。
- 持久化回归 11 项、桌面回归 26 项、更新 UI 回归 6 项、安装器纯函数 4 项，并新增打包产物 `--connect-only --verify` 端到端测试。

## v0.1.0 — 2026-11-18

- 新增 Linux x86_64 AppImage、MCP 桥稳定路径、安装阶段错误反馈与 AppImage 手动回退副本。
- 两平台打包后运行 MCP 端到端检查，发布包含平台更新描述、SHA-256 和 GitHub 不可变发行证明。
- 开启依赖更新检查、PR 依赖评审、CodeQL、私密漏洞报告和定期发行检查。

## v0.0.8 — 2026-11-18

- 修复 MCP 导航对重定向和实际加载失败的判定。
- 修复新标签历史中的初始化空白页、未保存语言预览的恢复，以及英文设置中的部分中文控件。

## v0.0.7 — 2026-11-17

- 新增界面语言设置，支持自动跟随系统或浏览器语言，并可手动选择简体中文或 English；选择会持久化并立即应用到核心浏览器壳层。

## v0.0.6 — 2026-11-16

- 安全：拒绝非 HTTP(S) 的外部导航协议，避免空白站点白名单放行本地或调试内容。
- 安全：GitHub Release 安装器对远程安装包执行 fail-closed SHA-256 digest 校验。
- 安全：高危审批开启时，`includeSensitive:true` 的网络详情和 HAR 导出需要人工确认。
- 工程：CI 增加按 workflow/ref 的并发控制、默认只读仓库权限和安全回归脚本。
- 文档：新增项目审计、19 个开源项目对标、40 项升级路线图和升级交付报告。

\n
