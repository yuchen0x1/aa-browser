# v0.0.3 发布前产物检查

## 1. 总览

2026-11-13，对本地 Windows x64 NSIS 安装包及对应 `win-unpacked` 目录进行了只读暴露面检查，另运行类型、契约、配置、构建及应用回归。远端 Release 由标签工作流重新构建；本报告不是远端二进制或真实安装升级的验收证明。

扫描器观察到 80 个外部文件、7 个原生二进制、4 个外部 Web/脚本文件，并读取 app.asar。启发式原始分数为 16/100、等级 D；该值包含公开依赖源码映射、本地通信地址与第三方二进制命中，不作为产品安全评分。主 EXE 因体积上限未被通用扫描覆盖，另使用专用 API 读取 fuse 和安装包签名状态。

源码及 ASAR 文件名检查未发现 `.env`、私钥/签名证书文件或典型 GitHub/OpenAI 长期凭证模式。这里只代表所列静态检查未命中，不证明产物内不存在任何敏感信息。

## 2. 发现清单

| 编号 | 级别 | 证据与判定 |
|---|---|---|
| SIGN-01 | 高 | `Get-AuthenticodeSignature` 返回安装包 NotSigned；沿用项目现有未签名发布方式，发布说明明确提示 |
| FUSE-01 | 中 | RunAsNode、NodeOptions、Node CLI inspect 启用；OnlyLoadAppFromAsar 和 EmbeddedAsarIntegrityValidation 未启用 |
| MAP-01 | 低 | app.asar 中有 50 个依赖 `.map` 文件，示例为 `node_modules/builder-util-runtime/out/CancellationToken.js.map`；项目和依赖均公开源码，无专有业务算法保护诉求 |
| UNPACK-01 | 信息 | `cli/` 与 `out/bridge/` 解包分发，是外部 MCP 客户端执行桥接脚本所需 |
| SIGN-02 | 信息 | Electron 随附的一部分 DLL/辅助程序未签名；不是本轮引入的自研原生代码 |

## 3. 逐项证据与处理

- **SIGN-01**：本地安装包 `aa-browser-setup-0.0.3.exe` 无 Authenticode 签名。没有证书可用，不伪造签名成功；后续应配置受信任代码签名并验证修改后的更新认证链。
- **FUSE-01**：使用已安装 `@electron/fuses.getCurrentFuseWire()` 直接读取 `Aa Browser.exe`。RunAsNode 必须与现有 `src/main/clients.ts`、`cli/setup.mjs`、`install.mjs` 的 `ELECTRON_RUN_AS_NODE=1` 后备运行时一起设计，不能直接关闭，否则没有系统 Node 的 MCP 用户会失去连接能力。本轮不临时切换这些运行模式；NodeOptions/inspect 与 ASAR 完整性可作为独立加固增量。
- **MAP-01 / UNPACK-01**：实际枚举 app.asar，50 个 map 为运行时依赖源码映射，CLI/bridge 明文交付符合开源产品定位。混淆或删除桥接文件不会形成可靠的安全边界，因此本轮不以隐藏源码为发布目标。可在后续打包优化中剔除不需要的依赖 map。
- **已排除的启发式误报**：`http://127.0.0.1` 是用户本机 Agent 通信地址，不是内网基础设施凭证或隐藏服务。PDB 命中示例为第三方 DLL 的文件名，没有证明泄漏本项目开发机目录。`d3dcompiler_47.dll` 虽含 BSJB 字节串，但 PE CLR 数据目录 RVA/Size 均为 0，不能据此判为本项目的 .NET 程序。

不修改第三方已构建 DLL，不增加压缩壳或反调试措施。没有为本次检查复制技能扫描器或其他第三方源码到仓库。

## 4. 客户端无法解决的问题

Aa Browser 是公开源码的本地浏览器，不存在需要隐藏的客户端订阅判定。ASAR 是归档格式，不能保护长期凭证。后续如接入付费授权或服务端 API，最终授权仍须由相应服务端验证。

当前本地 WebSocket 的随机令牌用于本机连接鉴权，不是随安装包固定下发的长期密钥。`latest.yml` 的内容哈希用于完整性检查，不能替代可信发布渠道或代码签名。真实旧版→新版升级仍需另行验收。

## 5. 修复顺序与发布结论

1. P0：若发现长期凭证必须先移除和轮换；本轮所列静态检查未发现此类命中。
2. P1：后续建立 Windows 签名及旧版本更新验收，完善产物认证证据。
3. P2：在兼容 MCP 后备运行时的前提下收紧 fuse，裁剪依赖映射，建立发布产物专项回归。

本地质量检查：类型/33 项工具契约、Codex/WorkBuddy 配置、构建、91 项 MCP 冒烟、18 项桌面、8 项持久化和 5 项模拟更新状态检查均通过；NSIS 安装包、blockmap 与 `latest.yml` 已生成。上述签名和 fuse 限制明确保留，不把启发式扫描结果包装为“软件已安全”。
