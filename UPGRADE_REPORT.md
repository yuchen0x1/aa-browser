# Aa Browser 升级交付报告

> 交付日期：2026-11-16（Asia/Shanghai）
> 工作区基线：`main` / `d0741ff` / `v0.0.5`

## 1. 交付结论

本轮完成了项目现状审计、19 个公开开源项目研究、40 项可验收升级路线图，并实施了 3 项 P0 安全修复和 1 项发布工程化部分改进：

1. 导航策略拒绝非 HTTP(S) 外部协议，避免空白站点白名单放行本地文件、数据页和调试协议。
2. GitHub Release 安装器对远程安装包执行 fail-closed SHA-256 digest 校验。
3. 高危审批开启时，未脱敏网络详情和 HAR 导出需要用户确认。
4. CI 增加 workflow/ref 并发控制、默认只读仓库权限和安全回归脚本；供应链来源固定、签名和 provenance 仍未完成。

本轮没有把模拟更新器、模拟 GitHub API 或本地构建描述成真实线上发布、签名或端到端升级证据。

## 2. 竞品研究

### 2.1 研究数量与范围

- **实际研究：19 个**公开开源项目。
- 覆盖：Chromium、Electron、Brave、Zen Browser、Floorp、LibreWolf、qutebrowser、Playwright、Puppeteer、Selenium、WebdriverIO、chromedp、Browser Use、Skyvern、Stagehand、BrowserGym、Playwright MCP、Chrome DevTools MCP、Browserless。
- 每个项目检查了公开仓库、README/目录、许可证和 Releases；重点项目进一步检查了源码布局、近期 release notes、CI/安全文件或许可证说明。
- 没有复制第三方代码；路线图优先采用 Apache-2.0/MIT 项目的接口和工程原则。GPL/AGPL/MPL 项目仅作为设计或流程参考，后续代码引入仍需单独许可证审查。

详细仓库链接、证据边界、对比矩阵和借鉴决策见 [`COMPETITOR_ANALYSIS.md`](./COMPETITOR_ANALYSIS.md)。

### 2.2 对 Aa Browser 最有价值的参考

| 参考项目 | 可借鉴内容 | 当前取舍 |
| --- | --- | --- |
| Playwright MCP | 可访问性快照、ref 交互、文件边界、录制和工具契约 | 保留 Aa Browser 自己的 Electron/本地会话实现，吸收契约和边界原则 |
| Chrome DevTools MCP | CDP 网络/console/性能诊断、发布检查和安全文档 | 继续复用 Electron debugger，补性能摘要、错误码和发布门禁 |
| Browser Use | typed result、域名策略、秘密脱敏、任务状态 | 只重实现本地化方案，不默认引入云服务或 telemetry |
| Stagehand | observe/act/extract 分层、结构化抽取和 changeset 发布 | 作为后续工具 API 与发布流程参考 |
| Skyvern | workflow state、错误分类、secret scrubbing、依赖告警 | 只借鉴设计；AGPL 代码不直接嵌入 |
| BrowserGym | 固定任务、可重复环境和版本化评测 | 形成本地 HTTP fixture benchmark，不把研究依赖带入运行时 |
| Brave / Zen / Floorp / LibreWolf | 隐私默认值、workspace、跨平台发布、签名与补丁流水线 | 概念重实现；当前仍是 Windows 优先 |

Aa Browser 的优势是本地可见浏览器、用户可接管、MCP 原生、增量快照、稳定 ref、真实输入路径、共享/隔离会话和抓包/Mock 组合。短板是任务恢复、工作空间、性能基线、跨平台打包、代码签名和真实更新安装证据不足。

## 3. 升级数量与状态

- 发现并形成路线图：**40 项**（EV-001 至 EV-040）。
- 完成：**3 项**（EV-001、EV-002、EV-003）。
- 部分完成：**1 项**（EV-005：CI 权限/并发已改善，来源固定、provenance、SBOM 尚未完成）。
- 未完成：**36 项**。
- 每项均记录了问题依据、参考项目、方案、文件范围、难度、优先级和验收标准；没有用拆分小任务凑数。

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| EV-001 | 完成 | 非 HTTP(S) 外部导航拒绝；桌面回归覆盖 |
| EV-002 | 完成 | Release digest 缺失/格式错误/哈希错误均 fail-closed；安全脚本覆盖 |
| EV-003 | 完成 | `includeSensitive:true` 在高危审批开启时需用户确认；桌面回归覆盖拒绝路径 |
| EV-004 | 未完成 | 需要 Authenticode 证书、CI secret 和签名验证 |
| EV-005 | 部分完成 | CI 并发组、默认只读权限和安全测试已加入；来源固定/provenance/SBOM 未完成 |
| EV-006 | 未完成 | 需要统一路径策略并覆盖符号链接和文件边界 |
| EV-007–EV-018 | 未完成 | 协议版本、取消/重试、任务恢复、会话可视化、响应体治理、客户端健康和真实更新通道仍需实施 |
| EV-019–EV-030 | 未完成 | 性能诊断、benchmark、并发预算、内存预算、回放和 typed error 未实施 |
| EV-031–EV-040 | 未完成 | 可访问性、命令面板、主题/高 DPI、多语言、恢复、跨平台、SBOM、矩阵、插件和文档生成未实施 |

完整字段版清单见 [`UPGRADE_ROADMAP.md`](./UPGRADE_ROADMAP.md)。

## 4. 代码和配置变更

### 4.1 源码与测试

- `src/main/tabs.ts`：非 HTTP(S) scheme 默认拒绝，仅精确的新标签页内部 URL 可通过。
- `src/main/tools.ts`：敏感网络详情和 HAR 导出在高危审批开启时进入 `ApprovalManager`。
- `scripts/test-desktop.mjs`：增加非 HTTP(S) 导航拒绝和敏感网络披露拒绝回归；桌面检查从 19 项增加到 20 项。
- `scripts/smoke.mjs`：本地页面 fixture 改为 `127.0.0.1` HTTP 服务，避免冒烟测试依赖被禁止的 `file:` 外部导航。
- `scripts/test-security.mjs`：新增安装器 digest 安全回归，模拟 GitHub Release 缺失/格式错误 digest 和无效显式 `--sha256`。
- `package.json`：新增 `npm run test:security`。

### 4.2 安装、CI 与文档

- `install.mjs`：`--repo` 远程资产要求有效 `sha256:<64 hex>`；显式 `--sha256` 严格校验；本地路径仍兼容格式检查。
- `.github/workflows/ci.yml`：增加 workflow/ref 并发组、默认 `contents: read` 和安全回归步骤；Release job 仍单独声明写权限。
- `README.md`、`docs/releases/release-notes.md`、`docs/AUTO_UPDATE.md`、`CHANGELOG.md`：同步安全变化和验证边界。
- `PROJECT_AUDIT.md`：新增事实基线、架构、能力、风险和验证记录。
- `COMPETITOR_ANALYSIS.md`：新增 19 项目对标报告。
- `UPGRADE_ROADMAP.md`：新增 EV-001 至 EV-040 路线图。

### 4.3 删除和数据迁移

- 本轮没有主动删除源代码、用户数据或配置。
- `build/icon.png` 的删除是任务开始前已存在的未提交工作区变更；本轮保留，没有恢复、覆盖或纳入升级提交。
- 没有数据库 schema 或持久化格式迁移。

## 5. 验证结果

| 命令 | 结果 | 证据/限制 |
| --- | --- | --- |
| `npm run check` | PASS | TypeScript + 33 工具一致性 |
| `npm run build` | PASS | main/preload/renderer/bridge 构建成功 |
| `node --check install.mjs` | PASS | 安装器语法检查 |
| `npm run test:security` | PASS | 缺失、格式错误和无效显式 digest 均被拒绝 |
| `npm run test:tools` | PASS | 33 个工具契约与注解 |
| `npm run test:stores` | PASS | 8/8 持久化检查 |
| `npm run test:updater` | PASS | 12/12，模拟 provider，不是线上更新 |
| `npm run test:release` | PASS | 4/4，模拟 GitHub API，不是公开 Release |
| `npm run validate:codex` | PASS | 配置备份、保留无关段和幂等 |
| `npm run validate:workbuddy` | PASS | connector schema 和隔离配置 |
| `npm run smoke` | PASS | 隔离 Electron + MCP + HTTP fixture 的端到端流程 |
| `npm run test:desktop` | PASS | 20 项原生桌面回归，包含本轮两个安全场景 |
| `npm run test:update-ui` | PASS | 5 项模拟更新 UI 回归 |
| `npm run dist -- --publish never` | PASS | 产出 Windows NSIS、blockmap、latest.yml；日志明确显示未配置代码签名且使用 Electron 默认图标 |
| 真实旧版发现并安装新版 | BLOCKED/未验证 | 需要公开高版本 Release、签名证书和独立安装环境 |
| Windows Authenticode/SmartScreen | BLOCKED/未配置 | 仓库当前没有签名证书配置 |
| macOS/Linux 构建 | NOT APPLICABLE（当前版本） | builder 仅配置 Windows NSIS |
| 性能/长时间/并发基线 | NOT APPLICABLE（本轮未实施） | 没有统一硬件和场景基准，未编造数值 |

## 6. 遗留问题和下一阶段

1. EV-004/EV-005/EV-006：代码签名、可信构建来源、SBOM 和文件路径策略。
2. EV-007–EV-018：统一错误码、取消/重试、任务恢复、会话生命周期和敏感数据内存治理。
3. EV-019–EV-030：性能摘要、并发/内存预算、benchmark、录制回放和 typed result。
4. EV-031–EV-040：工作空间、命令面板、可访问性、高 DPI、跨平台、插件和文档自动化。

在签名、真实 Release、旧版客户端、安装/重启/回滚和多平台证据补齐前，项目不应标记为全平台生产级。
