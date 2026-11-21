## 📢 版本概述

> 候选正文：尚未创建正式 Release；以下下载文件为计划资产，不代表已经上传或可下载。

本版修复 MCP 桥并发建立连接与旧连接清理的竞态，避免重连时错误清理其他调用；同时阻止跨域 iframe 元素枚举泄露已填写的密码、令牌和支付字段值，并提高冷启动回归的跨平台清理稳定性。MCP 工具保持 42 个，无用户数据迁移。

## 🔧 改进与优化

- **连接单飞与归属清理**：并发的 `tools/call` 共用同一个进行中的 WebSocket 握手；每个待决调用记录所属 socket，旧连接关闭时只结束自己的调用，不影响新连接。
- **发送失败回收**：发送前检查连接状态，WebSocket 同步异常或异步发送失败均回收待决调用、进度和 MCP 请求映射；连接在握手完成前关闭也会及时报错。客户端收到工具级错误，不再等待长调用超时。
- **回归与发布稳定性**：新增延迟握手并发与确定性连接生命周期回归并接入 CI；冷启动 Electron 回归在终止进程后重试释放 Chromium profile，避免成功的工具调用被异步文件锁误报为失败。
- **敏感值描述治理**：iframe 元素列表继续保留标签、类型和安全名称提示；按密码、令牌、API key、OTP、支付字段的已知元数据分类，覆盖中文提示、关联 label、data-testid 和信用卡 autocomplete。19 个敏感描述 fixture 验证不会读取控件 value/innerText；普通输入值展示保持不变。这不是对任意未标识字段的全量脱敏保证。

## 🐛 问题修复

- 修复多个 MCP 调用同时等待建连时可能各自创建 WebSocket，导致连接状态不确定的问题。
- 修复旧 WebSocket 的 `close` 回调使用全局清空逻辑，可能误拒绝新 WebSocket 上的待决调用的问题。
- 修复 `browser_frame action=elements` / 固定 iframe 点击描述可能回显密码或其他敏感输入值的问题。
- 修复 Linux 标签 CI 中 Aa Browser 已成功自动启动和完成 `browser_tabs` 后，Chromium profile 尚未释放导致 `ENOTEMPTY` 的测试失败。

## 🔒 安全与兼容性

- 工具名称、数量、MCP/WS 请求格式、请求 ID 和参数保持不变；设置、会话、历史、Cookie 与下载格式无需迁移。
- 这是受信任本地 Agent 的自动化工具，不是恶意 Agent 沙箱；中断只能阻止后续工作，不能撤销已完成的页面副作用。
- iframe 描述只减少已知敏感字段的值回显，显式页面文本读取和受用户授权的表达式能力保持原语义。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
| --- | --- | --- |
| `aa-browser-setup-0.6.10.exe` | Windows x64 | 首次安装或覆盖升级安装程序 |
| `aa-browser-setup-0.6.10.exe.blockmap` | Windows x64 | 增量更新分块信息 |
| `latest.yml` | Windows x64 | 自动更新版本与校验元数据 |
| `aa-browser-0.6.10-linux-x86_64.AppImage` | Linux x86_64 | 免安装可执行文件 |
| `latest-linux.yml` | Linux x86_64 | 自动更新版本与校验元数据 |
| `sbom.cdx.json` | 全平台 | CycloneDX 软件物料清单 |
| `SHA256SUMS.txt` | 全平台 | 发布文件 SHA-256 校验清单 |

- 首次安装：Windows 运行安装程序；Linux 为 AppImage 添加执行权限后启动，参阅[平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.6.10/docs/PLATFORMS.md)。
- 已安装用户：在「设置 → 软件更新」检查升级，或从本页下载安装文件覆盖安装。

## 🔄 升级与数据迁移

- 正式发行后可从 v0.6.8 或更早版本覆盖升级，无需卸载或数据迁移；重启浏览器后使用新版 MCP 桥。v0.6.9 仅有标签、未完成正式发行，本版同时包含其地址栏无损编辑、精确取消、审批/权限一致性及证据身份核验修复，详见 [CHANGELOG](https://github.com/yuchen0x1/aa-browser/blob/main/CHANGELOG.md)。
- Windows 回退需重新安装旧版安装包；Linux 可保留按版本命名的旧 AppImage。建议在回退前备份个人数据。

## 🧪 验证结果

- `npm run check`、TypeScript typecheck、生产 MCP 桥构建与桥产物同步通过。
- 新增延迟握手并发回归连续 5 次通过，确定性连接生命周期回归 10/10 通过；离线桥、连接取消、AgentServer 取消、工具契约、页面脚本和 iframe 敏感值描述回归通过。
- 冷启动自动启动回归连续 2 次通过；上一版标签 CI 的 Linux profile 清理失败已由可重试清理修复，最终 Windows/Linux 打包和安装验收以本标签 CI 为准。

## ⚠️ 已知问题

- 客户端 JSONC/TOML 编辑幂等性、分页快照传输、历史同步写盘和证据管理目录/用户输出分离仍在后续路线；本轮不把它们声称为已解决。
- Windows 未配置 Authenticode 代码签名，首次运行可能出现 SmartScreen 提示。
- 多物理显示器、真实打印输出和真实摄像头/麦克风硬件授权未在本地验收；macOS、ARM、Android、iOS 与 Web 浏览器产品版不在当前发行支持范围内。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.10
