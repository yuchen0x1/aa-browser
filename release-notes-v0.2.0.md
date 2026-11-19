# Aa Browser v0.2.0

## 版本概述

本版本集中在长期使用体验与发行可信度：重启后可以恢复上次的普通标签页；Agent 新增页面性能摘要工具，无需打开 DevTools 即可定位慢页面；每个正式发行都附 CycloneDX SBOM，并纳入 SHA-256 清单。

## 新功能

- **跨会话标签恢复**：默认开启。正常退出或异常退出后重新启动，会按上次顺序恢复普通网页标签并回到活动标签。设置面板可关闭；隔离标签、内部页以及 `file:` / `data:` 等地址不会恢复。恢复记录使用原子写入，地址中的账号密码会被剥离，最多保存 20 个不同地址。
- **`browser_performance` 工具**（第 34 个 MCP 工具）：返回导航耗时（TTFB / DOMContentLoaded / load）、First Contentful Paint、资源数量与传输/解码体积、最慢资源、JS 堆用量以及 DOM 规模。只读、幂等，适合在 Agent 任务中先诊断再优化。
- **CycloneDX SBOM**：`sbom.cdx.json` 随每个正式 Release 发布，列出应用组件与完整 npm 依赖树（区分 required/optional），并写入 `SHA256SUMS.txt`。

## 工程与测试

- 冒烟测试启动 Electron 时清理继承的 `ELECTRON_RUN_AS_NODE`，避免部分 CI/agent shell 把桌面进程变成纯 Node 进程导致启动失败。
- 持久化回归扩展到 11 项；桌面回归扩展到 26 项，新增跨会话恢复与「会话记录不含隔离标签」检查；MCP 工具契约更新到 34 个。
- 发布脚本在 v0.2.0 及以后强制要求 SBOM 存在，缺失时拒绝生成清单；公开发行校验会解析 SBOM 并核对版本。

## 下载与更新

- Windows x64 使用 `aa-browser-setup-0.2.0.exe`。v0.1.0 及更早版本可在「设置 → 软件更新」中检查升级。
- Linux x86_64 使用 `aa-browser-0.2.0-linux-x86_64.AppImage`。添加执行权限后从桌面会话启动；安装要求和回退说明见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.2.0/docs/PLATFORMS.md)。
- 两端资产可以用 `SHA256SUMS.txt` 检查。使用 `gh release verify-asset v0.2.0 <文件路径> --repo yuchen0x1/aa-browser` 验证 GitHub 发行证明。
- `sbom.cdx.json` 可用任意 CycloneDX 1.5 工具读取，用于依赖审计与许可证清点。
- Windows 安装器的 Authenticode 签名状态以文件属性为准；当前仓库仍未配置签名证书。

## 已知限制

- macOS、Android、iOS 和 Web 版不在本版本支持范围内，原因见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.2.0/docs/PLATFORMS.md)。
- 真实旧版升级/回滚与签名安装链路仍需在有证书和发布历史的环境中单独验收；本版本不宣称已完成这些验证。
