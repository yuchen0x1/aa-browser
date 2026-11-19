# Changelog

产品版本摘要见 [`docs/releases/release-notes.md`](./docs/releases/release-notes.md)，与 GitHub Release 逐字同步的正文归档位于 [`docs/releases/bodies/`](./docs/releases/bodies/)；新版本使用 [`release-notes-template.md`](./docs/releases/release-notes-template.md)。

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
