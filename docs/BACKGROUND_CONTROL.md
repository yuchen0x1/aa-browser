# 后台浏览器控制

Aa Browser 的后台控制分为三层：页面渲染租约、可信输入通道和窗口/预览策略。它们不会伪造
`document.visibilityState`，也不会修改站点的 Cookie、Storage 或登录态。

## 统一窗口策略

`browser_window` 和设置中的「后台运行模式」使用真实 Electron 窗口 API：

| 模式 | 实际行为 | 适用场景 |
| --- | --- | --- |
| `visible` | 显示并聚焦窗口 | 人工浏览 |
| `background` | 显示窗口但使用 `showInactive`，不主动抢焦点 | 用户同时使用其它软件 |
| `minimized` | `restore`/`minimize` 到任务栏 | 长时间后台任务 |
| `hidden` | `hide` 窗口，页面 WebContents 仍保留 | 无界面自动化 |
| `background-visual` | `background` + 受限频率的独立预览 | 需要观察但不打断用户 |

所有模式共用同一个持久化会话分区。切换模式只改变窗口状态，不重建标签页。

## 实时预览与人工接管

- `browser_window action=monitor` 只捕获明确选择的 `tabId`，最多约 2fps，画面缩放到 960px 宽。
- 预览帧通过外壳 IPC 发送，不经过网页页面；截图历史保留最近 20 张并写入
  `AA_BROWSER_MONITOR_DIR`（默认 `~/.aabrowser/monitor`）。
- 预览不读取其它标签页，历史文件登记到证据清理器并受 TTL/配额约束。
- `action=takeover` 会先锁定监控状态，再暂停 Agent 调用；`action=release` 是暂停期间唯一允许的
  控制调用之一，释放后才恢复 AI。这样不会出现 AI 与人工同时输入。

## 后台输入与渲染

- 活动页且窗口前台时沿用 Electron window input；其它情况使用同一 WebContents 的 CDP
  `Input.dispatchMouseEvent`、`Input.dispatchKeyEvent` 和 `Input.insertText`。
- 每个标签的操作锁和渲染租约都在 `finally` 释放；截图/视觉预览也持有短期租约，避免后台节流。
- 最小化窗口使用记忆尺寸的 `Emulation.setDeviceMetricsOverride`；恢复前台或工具收尾时清除/恢复覆盖。
- 点击仍优先使用结构化 `ref`，只在元素被遮挡或命中回验失败时才使用页面内兜底；视觉截图不是默认坐标定位。

## 任务中心

`browser_tasks` 提供当前 MCP 客户端、调用 id、工具名、进度/状态和暂停/取消入口。多个标签仍通过
`tabId` 明确寻址；不同标签的队列彼此独立，同一标签保持串行。人工接管和全局暂停只允许显式的
`browser_window release` / `browser_tasks resume` 解除。

## 15 项后台能力审计（v0.14 阶段）

| 项目 | 代码与自动化证据 | Windows 外部证据 | 结论 |
| --- | --- | --- | --- |
| 最小化导航 | `src/main/index.ts` 虚拟视口；`scripts/test-background.mjs` | CI/本机真实 Electron 已通过 | 已覆盖 |
| 其它窗口遮挡 | CDP/`capturePage({stayHidden:true})` | Windows cover window 回归（仅 Windows） | 已覆盖（CI Linux 跳过） |
| 隐藏截图 | `BrowserMonitor` + `captureVisual` | 隐藏模式 PNG 非空回归 | 已覆盖 |
| 可信后台点击 | `Input.dispatchMouseEvent` + click probe | 最小化可信点击回归 | 已覆盖 |
| 后台键盘/输入 | `Input.dispatchKeyEvent` / `Input.insertText` | 最小化输入与 Enter 回归 | 已覆盖 |
| 后台拖拽 | `Input.setInterceptDrags` + `dragIntercepted` + `Input.dispatchDragEvent` | 最小化原生 `dragstart`/`drop` 数据回归 | 已覆盖 |
| 后台滚动 | 页面滚动脚本 + 操作锁 | 最小化下滚动前后位置与恢复回归；无限滚动另列为站点专项 | 已覆盖上下滚动；无限滚动仅站点专项，未纳入固定回归 |
| 多标签独立 | `tabId` + 每标签队列 | 并发 smoke 回归 | 已覆盖 |
| 多 MCP 并发 | AgentServer 按 WebSocket/客户端编号管理 | 并发 smoke 回归 | 已覆盖 |
| 渲染节流 | `backgroundThrottling` + `keepRendering` | 后台截图/预览持续持租约 | 已覆盖 |
| 虚拟视口恢复 | `syncBackgroundViewports` 与视觉工具 finally | 最小化截图后尺寸回归 | 已覆盖 |
| 恢复前台清理覆盖 | restore/clear metrics 路径 | 最小化→恢复回归 | 已覆盖 |
| 审批显示窗口 | `ApprovalManager.onRequest` → `revealWindow` | 真实审批唤起/拒绝回归 | 已覆盖 |
| 取消释放租约 | `withTabLock`/`drainTabOperations` finally | 取消侧效应回归 | 已覆盖 |
| 崩溃资源释放 | `render-process-gone`、`closeTab`、监控停止 | 30 分钟 Windows soak 通过（`timerDelta` 1802、预览 3531 帧、内存末次低于首次）；未做渲染进程崩溃注入 | 部分覆盖（长期运行无泄漏；崩溃恢复未验证） |

## 特殊网站策略

SPA、iframe、Shadow DOM、WebSocket、SSE、懒加载和无限滚动继续通过 DOM/Accessibility 快照、frame
工具和真实页面状态等待处理。需要持续可见的站点应明确选择 `visible` 或 `background`；本项目不伪造
页面可见状态绕过站点安全限制。DPI 100% / 125% / 150% / 200% 已通过本机显示矩阵；当前环境只有一个
物理显示器，多物理显示器遍历、真实 DRM、跨域登录/2FA 与复杂视频页面仍不能宣称已验证，不以内部
变量代替外部证据。

30 分钟 Windows soak 已验证长期运行、预览限频、截图配额与内存稳定性；渲染进程崩溃注入恢复仍是
下一阶段专项，不能用 soak 结果替代。

## 回归命令

```powershell
npm run typecheck
npm run build
npm run test:background
```

`npm run test:background -- --soak=30m` 运行 Windows 长期 soak；`-- --live` 可选地验证真实公网页面。
公网内容和登录/DRM 结果不作为 CI 的确定性证据。

## 竞品取舍

本阶段只吸收公开产品层设计，没有复制代码：

- [anomalyco/browse](https://github.com/anomalyco/browse)：把 tab id 作为 Agent 句柄、默认后台打开、禁止 Agent 把窗口带到前台，并在交接登录/2FA 时暂停自动化。Aa Browser 已采用显式 `tabId`、`browser_window takeover/release` 和真实窗口焦点保护；标签分组/借出用户标签仍是后续阶段。
- [smouj/agent-browser](https://github.com/smouj/agent-browser)：独立会话、实时 Dashboard、DOM/Accessibility/视觉快照与动作日志。Aa Browser 本阶段实现了只捕获单标签的实时预览、有限历史和 `browser_tasks`；完整多会话数据库和远程 Dashboard 尚未引入，以免泄漏本机配置。
- [JIRBOY/Agent-Browser](https://github.com/JIRBOY/Agent-Browser)：强调后台浏览器任务与故障记录。Aa Browser 复用现有 MCP 调用日志、客户端编号和取消协议，不复制其实现；30 分钟 Windows soak 已通过，崩溃注入与恢复仍列为下一阶段证据。

