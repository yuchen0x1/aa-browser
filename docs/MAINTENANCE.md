# Aa Browser 维护状态

基线审核于 2026-11-19（v0.2.0），当前发行状态更新于 2026-11-24（v0.17.0）。GitHub 的 [CI](https://github.com/yuchen0x1/aa-browser/actions/workflows/ci.yml)、[发行校验](https://github.com/yuchen0x1/aa-browser/actions/workflows/release-verify.yml)、[依赖审计](https://github.com/yuchen0x1/aa-browser/actions/workflows/audit.yml)、[CodeQL](https://github.com/yuchen0x1/aa-browser/actions/workflows/codeql.yml)、[最新发行](https://github.com/yuchen0x1/aa-browser/releases/latest) 提供实时状态。产品目标版本由 `package.json` 和 tag 共同确定；正式发布状态以已合并的 main 提交、标签 CI 和公开 Release 核验为准。

## 原项目

Aa Browser 使用 Electron 45、TypeScript、electron-vite 和 npm。原有窗口壳层由本地 HTML/CSS/TypeScript 提供，预加载仅为壳层暴露限定 IPC。站点页使用独立 WebContentsView 和分区。主进程管理标签、历史、设置、会话恢复记录、下载、审批、网络诊断及更新。页面快照由自包含脚本提取。34 个 MCP 工具通过 stdio 桥与带 token 的本机 WebSocket 通信；`browser_performance` 提供只读性能摘要。

```text
src/renderer  →  src/preload  →  src/main  →  Chromium WebContentsView
MCP 客户端    →  cli/mcp      →  src/main/agent-server →  tools / actions / snapshot
持久化        →  Electron profile 与 ~/.aabrowser 的设置、历史、连接和下载
发行          →  electron-builder → NSIS / AppImage → GitHub Releases
```

功能基线含标签与前后退、页面查找、语言和搜索设置、登录态、隔离标签、站点白名单、操作确认、历史、下载、MCP 客户端接入，以及快照和网页交互、文档导出、控制台与网络诊断。没有远程服务端、业务数据库或 schema 迁移。设置和历史用 JSON 容错及原子写入，Chromium 管理站点数据。此次 Linux 适配复用这一结构，MCP 路径独立于 AppImage 临时挂载目录。

基线 `06e2bf9` 对应 v0.0.8。保留历史标签，其中一些历史版本号高于正式发行版本。历史基线 v0.2.0 新增跨会话标签恢复、`browser_performance` 工具和随发行附带的 CycloneDX SBOM。最新已发布版本 v0.17.0 于 2026-11-24 发布，提供 Windows x64 与 Linux x86_64 共 7 项资产，并加入公开 Release 下载线路回退、续传和可信校验。用户升级来源是 GitHub Releases；没有中国大陆网络速度或完整大包实测。原流水线只有 Windows，写入 README 与未来分支保护冲突，重跑还可替换同名公开资产。v0.1.0 使用版本文档随 PR 提交和只读周期检查，跨平台构建通过后上传草稿，GitHub 锁定公开资产；v0.2.0 沿用同一流程并把 SBOM 纳入资产集与 SHA-256 清单。

## 验证与留档

| 检查 | 基线及证据来源 |
| --- | --- |
| v0.17.0 正式状态 | PR #20 合并提交 `cdea12d`；标签 CI run `45421349555` 的 Windows/Linux 与发布作业成功。发布后核验 run `45424988340` 和 `gh release verify` 均通过，Latest 不可变 Release 的 7 项资产已核验；没有中国大陆网络或完整大包下载实测。 |
| v0.16.0 正式状态 | v0.17.0 发布前的 Latest Release；标签 CI run `45402036248` 成功，Windows/Linux 7 项资产齐全。 |
| v0.15.0 正式状态 | 标签 `v0.15.0` 指向 `c3368bf`；GitHub Latest Release 为不可变公开版本，5 项资产（Windows 安装包、blockmap、`latest.yml`、SBOM、SHA-256 清单）齐全。Windows 桌面回归与安装包冒烟已在标签 CI 中通过；真实渲染进程崩溃注入恢复与 Windows Authenticode 签名仍未验证。 |
| v0.14.0 正式状态 | v0.15.0 仅提供 Windows 资产前的双平台版本；Linux AppImage 与 `latest-linux.yml` 可从其 Release 获取，v0.16.0 起恢复双平台发行。 || Windows v0.0.8 本地回归 | 12 项命令通过。包括 check、build、test:tools、test:stores、test:security、test:updater、test:release、validate:workbuddy、validate:codex、smoke、test:desktop、test:update-ui |
| Windows v0.2.0 本地回归 | check（34 工具 + 提示词一致）、test:tools、test:stores 11/11、test:security、test:updater 13/13、test:release 5/5、test:installer 4/4、test:connect（打包产物 connect-only + browser_tabs 验证）、build、smoke（含性能摘要与会话记录断言）、test:desktop 26/26、test:update-ui 6/6、`npm run dist` 产出 NSIS + blockmap + latest.yml、`release-assets prepare windows-x64` 校验通过、SBOM 生成与发布脚本回归 |
| Windows v0.3.0 本地回归 | check（类型、34 工具契约、提示词、DSH 包、页面脚本转义）、test:tools、test:stores 11/11、test:security、test:updater 13/13、test:release 5/5、test:installer 4/4、test:bridge、build（含 MCP 桥与 DSH 桥同步）、smoke 18 组、test:desktop 26/26、test:update-ui 6/6；图标产物用 electron-builder 自带 icons 工具转 .ico 校验 16/24/32/48/64/128/256 七帧四角 alpha 全为 0 |
| v0.3.0 正式发布 | 标签 `v0.3.0`（提交 `5b5730c`）的 CI #113 双平台测试（windows-x64 / linux-x64，含打包产物安装与 MCP 校验）与「Publish tested release」全部成功；发布不可变 Release（Immutable），7 个资产（两平台安装包、blockmap、两平台更新描述、SBOM、SHA256SUMS）齐全；`SHA256SUMS.txt` 与 Release 资产 digest 逐项一致，`latest.yml` 版本为 0.3.0；发布后 `release-verify` 校验工作流成功 |
| Windows 安装包实测 | `aa-browser-setup-0.2.0.exe` 静默安装到临时目录成功；对安装后的 `Aa Browser.exe` 运行完整 smoke（34 工具、性能摘要、会话记录、抓包、上传下载）通过；卸载程序返回 0 且主程序文件已移除 |
| v0.2.0 正式发布 | PR #10 双平台 CI/CodeQL/依赖审查通过后合并为 `ebec652`；标签 `v0.2.0` 的 CI #63 成功并发布不可变 Release（Immutable/Verified）；7 个资产（两平台安装包、更新描述、SBOM、SHA256SUMS）齐全；实际下载核验 SHA-256、版本与 SBOM 一致 |
| 通用接入提示词 | `installer/install-prompt.md` 与 `connect-prompt.md` 单一来源生成 `PROMPT.md` 和新标签页，`check:prompt` 校验一致；冒烟测试断言启动页渲染通用接入提示词与复制按钮 |
| 安装器与 connect-only | 纯函数 4/4（平台资产、稳定路径、digest、PE/ELF 文件头）；对 `release/win-unpacked` 执行 `--connect-only --dir ... --verify --json` 通过，`--print-config` 输出可用的 MCP 命令；Linux 由 CI 在 AppImage 上执行同一测试 |
| MCP 桥离线行为 | `npm run test:bridge`：浏览器未运行时 `tools/call` 在 8 秒内返回工具级 `isError`，不再挂到客户端超时 |
| 注入脚本转义 | `npm run test:page-scripts`（已并入 `npm run check`）：编译 `src/snapshot/scripts.ts` 后在 vm 沙箱里跑真实注入脚本，断言 `</script>`、U+2028/U+2029 不会截断脚本，`ref` 只放行 `^e\d+$`，文本/选择器/上传文件名能原样还原。对应 CodeQL `js/bad-code-sanitization`（安全严重度 6.1，中等）的清理要求：数据进脚本一律走 `refLiteral()` / `jsLiteral()` |
| README 多语言 | 主文 `README.md`（简体中文，完整 663 行）+ 11 种精简导读（en / zh-TW / ja / ko / es / pt-BR / fr / de / ru / ar / hi，各 203 行）；清单在 `docs/i18n/readme-languages.json`，说明见 `docs/i18n/README.md`。`npm run check:readme-i18n`（已并入 `npm run check`）校验清单 ↔ 语言栏 ↔ 文件 ↔ 相对链接一致，并断言安装命令、34 个工具名、`127.0.0.1`、180/120 秒、Node.js 22.12 与必应真实快照示例未在翻译中丢失；翻译为精简导读，权威细节以中文主文为准 |
| DSH 插件 | `npm run check:dsh` 校验清单/patch 两行/桥版本/locale/detail/图标/市场条目；已通过 `plugin_manager install_bundle` 安装到当前 profile（`aa-browser-dsh@0.1.0`，两行启用），当前会话已暴露 34 个 `mcp__aa-browser__*` 工具；插件市场收录尚未提交（需 npm 发布与外部仓库 PR） |
| 跨会话恢复 | 持久化单测覆盖凭据剥离、去重、上限、损坏/未来版本；桌面回归覆盖种子会话恢复、活动标签恢复和「隔离标签不入记录」 |
| 性能摘要 | 冒烟测试在真实页面调用 `browser_performance`，断言导航/资源/DOM 字段和当前 URL |
| SBOM | `npm run sbom` 从 lockfile 生成 CycloneDX 1.5；发布清单要求 SBOM 存在，公开校验解析并核对版本 |
| Windows/Linux 新版本 | Windows 本地已实测；Linux 由 CI 在 Ubuntu 构建 AppImage 并运行打包后 MCP 冒烟，结果以运行日志为准 |
| Windows 10、其他 Linux 发行版、Wayland 实机 | 待验证，当前按 [平台指南](PLATFORMS.md) 标出边界 |
| 升级与回退 | 模拟测试覆盖下载、重试、稍后、安装触发和 Linux 旧包副本。连续版本间的安装、迁移、回退依赖发布后的真实验收 |
| 签名 | 不可变 Release 的发行证明独立验证。Windows 尚缺 Authenticode 证书 |
| 依赖 | 生产 npm audit 0 项。开发链存在上游 Picomatch [告警](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)，定期审计报告保留该结果 |
| 绩效 | 现有 smoke 有部分延时断言。无长期内存、多显示器和批量标签压力数据 |

## 发布前暴露面检查

### 总览

对 v0.0.8 Windows 解包目录和编译输出执行静态逆向暴露检查。扫描器对 76 个文件报告评分 25/100（D）。高项包括依赖 source map、无 Authenticode，另有第三方二进制模式命中待核实。分数反映暴露度。

### 发现清单

- 高。ASAR 中有 50 个 source map，辅助还原依赖代码。
- 高。Windows 未签名，系统缺少发布者证书校验。
- 中。ASAR unpacked 包含 stdio 桥，第三方 PE 中带构建时 PDB 路径。
- 待核实。内网字符串和 .NET 签名由扫描器按字节模式匹配，未通过语义证据确认自有敏感信息。

### 证据与修复

`electron-builder.yml` 排除 map，禁用打包程序的 Node options 和 inspector，限制入口为 ASAR。保持 MCP 使用已存在的 Node fallback，Linux 用固定用户数据路径。再次打包后按 `@electron/fuses` 与 ASAR 文件列表复验。OS 签名后续由 release 构建输入合法证书。

### 客户端边界

本地连接 token 由运行时生成并写入本机发现文件。该文件和浏览历史应留在用户机器。没有远程授权服务或仓库写入 token 随包发行。MCP 桥属于发布的开源程序，ASAR 是代码归档，使用进程隔离和访问控制保护运行态。

### 修复顺序

优先清除打包调试材料和校验发行元数据，再由合法证书配置 Windows 发布者签名。后续验证客户端内置的独立签名校验与自动健康回退。

v0.2.0 复核：新增的 `session.json` 只保存普通网页 URL 与标题，账号密码在归一化时剥离，写入使用 0600 原子文件；SBOM 只包含公开 npm 包元数据和版本，不写入本机路径、凭据或内网信息。

## 维护节奏

- PR 说明平台、数据与更新影响。功能和修复合并前运行双平台 CI，依赖变更由 Dependency review 和 Dependabot 提示。高危运行时告警通过优先修复 PR 处理。
- CI 只给发布 job 仓库写权限。release 环境只接受版本标签。正式发行流程及恢复规则见 [自动更新](AUTO_UPDATE.md)。
- 每周的维护工作流检查下载链接、摘要、平台更新元数据和依赖漏洞。GitHub Actions 运行结果提供失败记录。
- 每次发行前运行 `npm run sbom`，确认 SBOM 版本与 `package.json` 一致并进入 `SHA256SUMS.txt`；依赖变更后复核新增组件的许可证。
- 每月复查 [32 个相关项目](RESEARCH.md) 的版本、Issue 和平台差异，每次大版本前复核重要源码与许可证。研究变更通过 PR 更新本项目文档。
- 每次扩展后同步更新 [平台功能矩阵](PLATFORMS.md) 与 release notes，保留真实系统验收和未覆盖条件。
