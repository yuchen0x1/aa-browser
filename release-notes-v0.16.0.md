## 📢 版本概述

Aa Browser v0.16.0 将发布治理推进到核心运行时：任务中心现在真正落盘，Renderer 崩溃恢复用真实 Electron 故障注入验证，元素引用具备快照代际和失效原因，点击与输入在动作前执行可靠性预检。Linux 桌面 CI 同步恢复，v0.16.0 重新提供 Windows 与 Linux 资产（Linux 仅通过 Ubuntu 24.04 CI/Xvfb/AppImage 冒烟验证）。

## ✅ 主要变更

- **持久任务中心**：`TaskCenter` 接入 `AgentServer`，把任务状态、步骤、执行历史、客户端来源、活动标签、Renderer PID、错误和恢复次数写入版本化 `task-center.json`。原子写入、损坏文件备份、有界裁剪；任务 ID 含客户端、调用序号和启动时间，桥或应用重启后复用请求 ID 也不会与旧终态记录撞键。若任务历史文件丢失，可从有效 TaskCenter 重建记录；进程重启后非终态任务统一标记为 `interrupted`，不会把历史任务当成正在运行，也不会自动重放。
- **副作用防重账本**：独立 `task-idempotency.json` 在危险处理器运行前先记录调用 key；缺 key、重复 key、账本损坏或写入失败时 fail closed。任务记录损坏不会消除防重保护，任务历史查询按 MCP session 隔离。
- **真实 Renderer 崩溃恢复**：使用 `webContents.forcefullyCrashRenderer()` 与系统级强杀注入真实进程退出，验证正常关闭、标签身份与 URL 保留、多标签隔离、执行中崩溃、导航中崩溃、恢复中再次崩溃、旧 Ref 失效和恢复次数上限。恢复失败返回明确错误，不再静默卡住。
- **Ref 生命周期**：快照、导航和渲染进程分别记录代际。导航后、Renderer 重启后或快照过期时，旧 Ref 返回 `NAVIGATION_ERROR`、`RENDERER_CRASH` 或 `STALE_REF`；元素脱离返回 `ELEMENT_NOT_FOUND`，跨域 Frame 返回 `FRAME_ERROR`，标签关闭返回 `TARGET_CLOSED`。不会把旧 Ref 自动映射到相似元素。
- **操作预检**：点击、输入、清空和下拉选择前检查元素存在、DOM 连接、可见性、尺寸、原生/ARIA 禁用、只读和可编辑状态；禁用 `<option>` 单独拒绝。点击前要求定位稳定，输入前二次核验焦点，避免 inert/焦点陷阱把文本写入错误字段；DOM 兜底失败不再返回假成功。后台 DOM/CDP 操作与屏幕坐标点击保持区分。
- **统一错误与恢复**：`ActionError` 带机器可读 `[CODE]` 前缀，并区分导航、网络、Ref、Frame、Target、Renderer、超时和任务冲突；任务终态写入幂等，暂停/断线不会被迟到的取消回调覆盖。MCP 客户端断开后，同一会话可重连并查询原任务的步骤和错误；写操作仍禁止无条件重放。
- **原子写入加固**：任务、历史和设置共用的 JSON 原子替换在 Windows 短暂文件锁下进行有界重试；持续失败时保留旧文件并清理临时文件。
- **Linux CI 恢复**：桌面矩阵重新加入 `ubuntu-24.04`，CI 覆盖 Renderer 崩溃、Ref 生命周期、AppImage 打包与桥连接冒烟。

## ⚠️ 验证边界

- Windows 与 Linux 桌面套件、Node/WebSocket 套件和真实 Electron 崩溃注入均在本版本门禁中执行；Linux 证据仅限 Ubuntu 24.04 + Xvfb CI，不代表所有发行版、显示服务器或桌面环境。
- 真实 `unresponsive` 事件没有公开、确定性的注入 API，因此未纳入必过套件，也不声称所有平台的无响应恢复均已验证。
- Windows 安装包仍未 Authenticode 签名，首次安装可能出现 SmartScreen 提示。
- 任务开始时记录活动标签与 `rendererPid` 作为关联证据；Renderer 恢复后旧 PID 不再代表当前进程，恢复尝试单独写入上下文和步骤。

## 🔗 项目链接

- 项目主页：https://github.com/yuchen0x1/aa-browser
- Release：https://github.com/yuchen0x1/aa-browser/releases/tag/v0.16.0

## 📦 发布资产

- `aa-browser-setup-0.16.0.exe`（Windows x64，未签名）
- `aa-browser-setup-0.16.0.exe.blockmap`
- `latest.yml`
- `aa-browser-0.16.0-linux-x86_64.AppImage`（Linux x86_64）
- `latest-linux.yml`
- `sbom.cdx.json`
- `SHA256SUMS.txt`
