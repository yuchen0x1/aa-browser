# 2026-11-23 网络响应体安全硬化

## 结论

本轮从实际 `main` / v0.12.0 源码继续推进 P1 网络治理，不改变 Electron、MCP 或用户数据架构。确认的缺口是：`Network.getResponseBody` 原先把完整响应交给工具层，`clipBody()` 只按字符截断，JSON、表单和授权文本可能在默认网络详情中原样进入 Agent。

本轮交付 v0.12.1 候选修复：

- `NetworkCapture.getResponseBody()` 在主进程边界按 1 MiB 字节上限截断；文本使用 UTF-8 安全边界，base64 响应按编码边界截断并保留原始大小估算。
- `clipBody()` 区分文本、二进制和截断结果；默认对 JSON 敏感键、表单键值以及 Bearer / Basic 凭据做内容级脱敏。
- `includeSensitive:true` 继续复用已有 `opGate()` 审批，不改变显式授权后的原文诊断能力。
- 新增 `scripts/test-network-security.mjs`，覆盖 JSON/表单/Bearer 脱敏、普通值保留、UTF-8 1 MiB 截断、二进制摘要和显式敏感通道。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:network-security` | PASS |
| `npm run build` | PASS；main/preload/renderer/MCP bridge 构建成功 |
| `npm run check` | PASS；既有 Biome 提示保持为非阻断信息 |
| `npm run smoke` | PASS；真实 Electron + stdio MCP 抓包与 HAR 回归通过 |
| `npm run test:desktop` | PASS；58 项桌面回归通过 |

## 边界与未完成项

- Chromium CDP 返回原始响应到主进程时，原文仍可能短暂存在；本轮只保证不把超限/未脱敏原文继续穿过 MCP 边界。
- `NetRequest` 的原始请求/响应头仍在进程内存保留；EV-014 的捕获阶段敏感值分级存储和审批后一次性取回尚未宣称完成。
- 未在本机宣称 Authenticode、真实 Linux 安装升级、旧版回滚或公开 Release 已成功；这些证据仍需标签 CI / GitHub Release 核对。

## 研究依据

本轮延续仓库既有的 Playwright MCP、Chrome DevTools MCP、Browser Use、Stagehand、agent-browser 与 Skyvern 对照，采用其“结构化结果、大小上限、secret scrubbing、显式能力边界”设计原则；未复制代码、品牌或新增运行依赖。许可证边界仍按仓库 `docs/internal/COMPETITOR_ANALYSIS.md` 的记录执行。
