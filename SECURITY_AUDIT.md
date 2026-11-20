# 安全审查记录

## 2026-11-21 · v0.6.9 候选的定向加固

### 1. 总览

- 本轮审阅本项目自有源码与构建输出，不分析第三方闭源产物。远程初查 CodeQL / Dependabot / secret-scanning 开放告警各 0；本地官方 npm 源 `npm audit --audit-level=high` 返回 0 漏洞。这些不是全仓无漏洞保证。
- 构建目录静态暴露扫描仅覆盖 7 文件、0 原生二进制，唯一信号是疑似未压缩 JS；它不能代表安装包 fuse、代码签名或运行时权限已检查。Aa 是 MIT 开源项目，源码可读是预期，不以混淆/反调试制造安全感；启发式 95/B 评分不作为产品安全评级。

### 2. 发现清单

| 边界 | 证据与处理 | 验证层级 |
| --- | --- | --- |
| 单调用取消 | 原 ID 只在连接内唯一；现使用 `(client,id)`，歧义/过期拒绝；同 socket 重复在途 ID 不覆盖控制器或竞争响应 | 真实回环 WebSocket、原生 HUD 单击、独立二审 |
| 敏感输入/求值审批 | `tools.ts` 的批量/iframe 输入绕开了普通敏感输入流程；现复用人工填写，输入值不回显；frame evaluate 遵循既有操作审批，保留表达式预览和允许后的语义 | 生产 handler + 页面/审批 mock、普通真实 MCP、独立复审 |
| 站点权限 | 原 pending 全局 origin/permission 去重；现绑定 Session/WC/文档/媒体子能力，导航/销毁/进程退出使旧结果失效 | 生产策略 12 组 mock 回调，另有真实通知授权桌面回归；非真实媒体硬件验收 |
| 证据清理 | 原路径删除可能删掉用户替换文件，失败仍扣配额；现验证身份/大小/hash、保守遗忘旧临时登记，失败保留重试资格 | 真实临时文件/Windows junction、故障注入、独立探针；符号链接用例在 Windows EPERM 跳过，交由 Linux CI |

### 3. 逐项证据与修复

- `src/main/agent-server.ts`、IPC/preload、HUD 和 `scripts/test-agent-cancellation.mjs`：保留 wire ID，不以全局编号冒充客户端身份；原重复执行红测转绿。
- `src/main/tools.ts` 与 `scripts/test-tools-approval-runtime.mjs`：敏感值不送往页面写入，拒绝时无动作；批量普通值也不回显；明确授权求值依然可用。不是试图将任意脚本求值改造成沙箱。
- `src/main/sessions.ts` 与 `scripts/test-session-permissions.mjs`：原策略对新增回归 10/12 失败，修复后 12/12 通过；保留原非提示权限集合政策，不虚称已默认拒绝所有未知权限。
- `src/main/evidence.ts` 与 `scripts/test-evidence.mjs`：旧产物身份是可选附加字段，无需用户迁移；旧临时记录不采用当前文件补身份删除。未修改的显式 PDF/HAR 仍按原 30/7 天 TTL，需长期保存应另存；文件身份核验不等于已完成用户输出目录隔离。
- 代码/构建、真实桌面/MCP与远程双平台结果分别记录，发布不以静态检查替代实际安装/启动。

### 4. 客户端无法解决的问题

- 认证 Agent 有意拥有页面表达式、登录态读取及部分本地证据能力；审批是选择性监督，不是抵御恶意 Agent 的沙箱。页面/下载内容仍不可信，站点导航规则不是出站网络防火墙。
- 本轮没有服务端订阅、计费最终裁决或内嵌长期服务密钥要搬迁；未来不得把这些秘密塞进客户端再用混淆包装。
- 证据登记并非认证的文件所有权；最终检查与按路径 unlink 的竞态仍存在，不能抵御同权限本机攻击者。中断也不能撤销已发生副作用。
- Windows 签名依然未配置，未声称完成 Authenticode；不改动桥需要的 Run-as-Node fuse，不牺牲正常接入来提升启发式评分。

### 5. 修复顺序与后续

- 本轮优先监督身份、审批/媒体作用域和数据丢失保护；保持工具与持久数据兼容。
- 下一轮优先桥单飞/旧连接归属、配置格式安全/原子幂等、应用管理证据与用户输出分离、逐动作取消后检查；再量化快照与写盘性能、补资源上限和平台覆盖。详见 [问题清单](AUTONOMOUS_ISSUES.md)。

## 2026-11-21 · v0.6.7 基线

- GitHub：开放 Dependabot 和 secret-scanning 告警各 0；CodeQL 开放中危 [#11](https://github.com/yuchen0x1/aa-browser/security/code-scanning/11) 与 [#12](https://github.com/yuchen0x1/aa-browser/security/code-scanning/12)，均为 `js/bad-code-sanitization`。
- 本地依赖审计：默认 npm 镜像不提供审计接口，改用 `npm audit --registry=https://registry.npmjs.org --audit-level=high` 后返回 0 漏洞。未为消除报告而更换依赖或降低扫描标准。
- 受影响边界是 Electron 页面脚本：用于固定 iframe 动作的选择器、文本和选项，以及对话框策略数据，统一通过已有 `jsLiteral` 编码。显式 `browser_frame evaluate` 仍执行请求的表达式，既有执行上下文和权限不变。
- 连接建立期间的取消占位也经复审加固：取消通知在桥尚未取得 WebSocket 时会记录状态，连接建立后不再发送已取消的浏览器调用；延迟握手回归确认浏览器端收到 0 次该调用。
- 验收：`v0.6.8` 合并（`afc27db`）后的新扫描判定 [#11](https://github.com/yuchen0x1/aa-browser/security/code-scanning/11) 与 [#12](https://github.com/yuchen0x1/aa-browser/security/code-scanning/12) 为 fixed（2026-11-20T18:52Z）。此前无手工忽略或降低扫描标准的操作；显式求值能力保留是产品契约。
- 这是针对告警和相邻数据边界的审查，不是对整个项目无漏洞的保证。
