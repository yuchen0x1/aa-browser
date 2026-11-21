# Changelog

产品版本摘要见 [`docs/releases/release-notes.md`](./docs/releases/release-notes.md)，与 GitHub Release 逐字同步的正文归档位于 [`docs/releases/bodies/`](./docs/releases/bodies/)；新版本使用 [`release-notes-template.md`](./docs/releases/release-notes-template.md)。

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
