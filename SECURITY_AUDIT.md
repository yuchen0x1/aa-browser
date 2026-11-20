# 安全审查记录

## 2026-11-21 · v0.6.7 基线

- GitHub：开放 Dependabot 和 secret-scanning 告警各 0；CodeQL 开放中危 [#11](https://github.com/yuchen0x1/aa-browser/security/code-scanning/11) 与 [#12](https://github.com/yuchen0x1/aa-browser/security/code-scanning/12)，均为 `js/bad-code-sanitization`。
- 本地依赖审计：默认 npm 镜像不提供审计接口，改用 `npm audit --registry=https://registry.npmjs.org --audit-level=high` 后返回 0 漏洞。未为消除报告而更换依赖或降低扫描标准。
- 受影响边界是 Electron 页面脚本：用于固定 iframe 动作的选择器、文本和选项，以及对话框策略数据，统一通过已有 `jsLiteral` 编码。显式 `browser_frame evaluate` 仍执行请求的表达式，既有执行上下文和权限不变。
- 连接建立期间的取消占位也经复审加固：取消通知在桥尚未取得 WebSocket 时会记录状态，连接建立后不再发送已取消的浏览器调用；延迟握手回归确认浏览器端收到 0 次该调用。
- 验收：`v0.6.8` 合并（`afc27db`）后的新扫描判定 [#11](https://github.com/yuchen0x1/aa-browser/security/code-scanning/11) 与 [#12](https://github.com/yuchen0x1/aa-browser/security/code-scanning/12) 为 fixed（2026-11-20T18:52Z）。此前无手工忽略或降低扫描标准的操作；显式求值能力保留是产品契约。
- 这是针对告警和相邻数据边界的审查，不是对整个项目无漏洞的保证。
