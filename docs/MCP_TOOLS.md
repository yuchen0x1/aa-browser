# MCP 工具与调用示例

当前源码共有 53 个工具：原有 47 个加 6 个平台管理入口。完整工具表见 [README](../README.md#mcp-工具)，准确的 schema、枚举和必填字段见 `src/shared/tool-defs.mjs`；客户端可能增加 `mcp__aa-browser__` 前缀。

## 连接与兼容

安装后在「设置 → AI 集成」接入客户端，或执行 `node install.mjs --print-config` 获取稳定桥配置。第一次实际调用 `browser_tabs action=list` 验证浏览器是否可控；配置写入、WebSocket 鉴权和工具成功是不同状态。安装和客户端位置见 [CONNECT.md](CONNECT.md)。

每个工具增加可选 `profileId`，选择优先级为显式参数、当前客户端绑定、默认 Profile。没有传新参数的旧调用继续可用。原有 `browser_tasks resume` 仍是恢复客户端接收新调用，不将它改为重放旧任务。跨步骤恢复使用新的 `browser_workflows`。

```json
{"name":"browser_tabs","arguments":{"action":"new","profileId":"default","url":"https://example.com"}}
```

后续操作尽量显式传该客户端返回的 `tabId`。不同 Profile 的标签与文件不可混用。工作流占用 Profile 时，外部 Agent 调用可能返回 `PROFILE_BUSY`，应等待或由桌面用户处理。

## 新增入口

| 工具 | 动作 |
| --- | --- |
| `browser_profiles` | `list/get/create/update/remove/start/stop/default/bind/clone/export/import` |
| `browser_workflows` | `list/get/templates/create/run/pause/resume/cancel/retry/input` |
| `browser_network` | `get/set/apply/test/resolve/diagnose` |
| `browser_visual` | `capture/click/drag/crop` |
| `browser_permissions` | `list/audit/request/revoke` |
| `browser_diagnostics` | `get/repair` |

`export/import` 名称保留在 Profile 枚举中，但当前只允许在桌面 Profile 面板使用密码输入与原生文件选择器；MCP 调用会明确拒绝，不能把密码或归档内容放在工具参数与日志里。复制同样必须满足离线条件。各参数以实际 schema 为准，不要添加不存在的授权布尔值。

## Profile 与工作流

```json
{"name":"browser_profiles","arguments":{"action":"list"}}
```

```json
{"name":"browser_profiles","arguments":{"action":"bind","profileId":"从列表返回的ID"}}
```

```json
{"name":"browser_workflows","arguments":{"action":"create","name":"多页面采集","templateId":"multi-page","profileId":"default","params":{"urls":["https://example.com","https://example.org"]}}}
```

流程创建和运行分开；用真实返回的 `id` 调用 `run`，再 `get` 查询。需要自定义步骤、检查点、重试或重新输入参数时见 [工作流指南](WORKFLOWS.md)。

## 代理与网络

```json
{"name":"browser_network","arguments":{"action":"set","profileId":"default","config":{"enabled":true,"mode":"proxy","protocol":"http","host":"127.0.0.1","port":8080,"bypass":["localhost"],"rules":[]}}}
```

```json
{"name":"browser_network","arguments":{"action":"resolve","profileId":"default","url":"https://example.com"}}
```

```json
{"name":"browser_network","arguments":{"action":"diagnose","profileId":"default","url":"https://example.com"}}
```

配置需要人工批准，并真正调用 Session 代理 API。切换关闭旧连接，可能中断当前请求。支持 HTTP、HTTPS、SOCKS5，以及精确主机或 `*.example.com` 规则；规则不是任意 URL/路径匹配。代理认证必须使用 OS 加密，不支持 SOCKS5 密码认证或带认证的按网站路由。出口 IP 检测会访问外部服务；本机 DNS 诊断不能证明远端代理使用哪台 DNS。

## 视觉操作

先用快照/ref 操作；确实需要处理 Canvas 或图片按钮时获取真实截图：

```json
{"name":"browser_visual","arguments":{"action":"capture","profileId":"default","tabId":"实际标签ID"}}
```

使用返回的 `captureId` 和截图判断 CSS 视口坐标，然后发起操作：

```json
{"name":"browser_visual","arguments":{"action":"click","profileId":"default","tabId":"实际标签ID","captureId":"从截图返回的ID","x":120,"y":80}}
```

坐标不是截图位图的物理像素。文档、像素、滚动、视口或缩放变化后会拒绝旧凭据，必须重新截图。修改操作每次原生审批，记录前后截图与坐标；返回的 `visualChanged` 只表示图像变化，需要另外检查业务状态。没有内置 OCR 或“按图片找到按钮”的语义搜索 API。

## 权限与诊断

```json
{"name":"browser_permissions","arguments":{"action":"request","profileId":"default","level":"sensitive","operation":"读取 Cookie 凭据","once":true,"reason":"检查测试账号的会话状态"}}
```

```json
{"name":"browser_permissions","arguments":{"action":"audit","profileId":"default"}}
```

```json
{"name":"browser_diagnostics","arguments":{"action":"get","profileId":"default"}}
```

```json
{"name":"browser_diagnostics","arguments":{"action":"repair","profileId":"default","repair":"reload","tabId":"实际标签ID"}}
```

诊断读取当前实际状态；网络/控制台故障只包含已有捕获记录，不能推断未记录的历史。修复需要人批准，刷新可能丢失表单，`clear-cache` 仅清 HTTP 缓存，不清 Cookie、Storage 或登录状态。

敏感或高危权限申请还需指定准确的 `operation`，与具体操作审批名称匹配；例如 Cookie 敏感读取是 `读取 Cookie 凭据`。范围授权用于审计并单次消费，不能预先证明具体页面对象或脚本安全；即使已有匹配授权，具体高危或敏感操作仍会触发原生人工审批。通用“敏感权限”不会授权所有后续操作。

## 错误与恢复

参数类型、依赖或坐标不合法会在执行前拒绝。错误信息携带对应错误代码；Profile 忙、页面失效、审批拒绝和检查点失败都不是“可以立即无条件重试”的信号。`TASK_STATE_CONFLICT` 表示请求或审计状态有冲突，先读取真实页面，尤其不能重复支付、发布、发送或删除。

读操作被应用升级打断时，桥只自动重发 readOnly 且 idempotent 的调用；写操作明确失败并要求检查状态。浏览器重启后同一桥会话可以查看自己的历史，新桥会话不能仅凭旧任务 ID 取得所有权。
