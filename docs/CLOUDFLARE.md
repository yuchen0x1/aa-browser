# Cloudflare 验证辅助

Aa Browser 提供了原生的 `browser_cloudflare` MCP 工具，用来处理普通页面快照无法看到的 Cloudflare 跨域验证 iframe。它借鉴了 [Cloudflare-Faker](https://github.com/onlyGuo/Cloudflare-Faker) 的实用流程：识别挑战、等待页面稳定，并在需要时通过浏览器真实鼠标管线点击可见复选框。

## 使用流程

1. `browser_cloudflare` 使用 `action=inspect`，确认当前标签是否存在挑战，并记录返回的 `frameId` 与 `control.index`。
2. 如果返回 `requiresUserAction=true`，确认页面属于预期站点，再使用 `action=click`、`confirm=true`；可选地传入上一步的 `frameId` 与 `candidateIndex`。
3. 使用 `action=wait` 等待挑战消失。若页面出现滑块、图片题或其他交互挑战，请直接在浏览器页面中完成，再重新调用 `wait`。

示例：

```json
{"action":"inspect","tabId":"t..."}
{"action":"click","confirm":true,"frameId":"f...","candidateIndex":0,"tabId":"t..."}
{"action":"wait","timeoutMs":30000,"tabId":"t..."}
```

## 边界与安全

- `click` 只允许对 `challenges.cloudflare.com` 的可见 iframe 发送一次真实鼠标事件；默认拒绝没有 `confirm:true` 的调用。
- 不读取、生成或注入 Cloudflare challenge token，不导出 Cookie，也不修改请求头或网络响应。
- 不尝试绕过 Turnstile、滑块、图片验证码或站点的风控策略；验证结果仍由 Cloudflare 和用户完成。
- 当设置中的“高危操作人工确认”打开时，`click` 还会经过 Aa Browser 的审批面板。

上游 Cloudflare-Faker 需要独立的 GPL-3 Java 服务、Chrome 扩展和屏幕识别机器人。Aa Browser 没有复制或打包这些组件，避免额外的服务进程、远程 WebSocket 和 GPL 代码耦合；这里仅实现与 Electron 会话和 MCP 工具模型相匹配的、显式确认的浏览器内辅助流程。
