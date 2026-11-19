# Aa Browser v0.3.0

## 版本概述

本版本改善日常使用的观感与安全边界：设置面板从窄单列改成宽版分区布局；应用图标重做为透明满幅，桌面快捷方式不再出现白边；Agent 注入脚本里的数据字面量统一加固，特殊字符不会再截断脚本。功能面与工具集（34 个 MCP 工具）保持不变。

## 界面与体验

- **设置面板改版**：卡片宽度从 560px 提升到 960px，改为左侧分区导航（通用 / 浏览与快照 / 数据与下载 / AI 集成 / 软件更新）+ 右侧内容区。导航与滚动联动自动高亮，点击可跳到对应分区；设置项统一为「左侧标题与说明、右侧控件」两栏，同类设置合并进卡片并用分隔线区分。
- **控件与排版**：原生复选框换成开关（保留原生 `input` 语义，可键盘操作）；保存按钮改为底部常驻栏，状态提示在左、主按钮在右；滚动条改为细窄深色样式；说明文字对比度提升到 6:1 以上。
- **窗口自适应**：窗口宽度小于 1000px（应用最小宽度约 960px）时自动收起左侧分区导航，控件换行到标签下方，保存栏仍在视口内。
- **中英文同步**：新增 13 条界面文案，英文下导航与分区说明完整，无截断。
- **应用图标重做**：图标源改为透明背景的满幅「方窗」，四角完全透明，修复桌面快捷方式、任务栏和网页 favicon 四周的白边；加入石墨渐变、内描边和品牌蓝圆环，字标按墨迹光学居中。`npm run icon` 现在用 Canvas 直接导出 PNG（不再截窗口），一次生成 `build/icon.png`、`site/assets/icon.png` 与 DSH 插件市场的 `icon-180.png`，产物可重复。

## 安全与修复

- **注入脚本字面量加固**：Agent 注入页面执行的脚本，其数据部分统一走 `jsLiteral()` / `refLiteral()`：补转 `<` `>` `/` 与 U+2028/U+2029，`ref` 只放行 `^e\d+$`。避免 `</script>` 或行分隔符把注入脚本截断（对应 CodeQL `js/bad-code-sanitization` 的清理要求）。
- **注入脚本构建器集中**：`click`、`fingerprint`、`checkedState`、`tagName` 等页面侧探针统一收敛到 `@snapshot/scripts`，主进程不再内联拼脚本；`browser_evaluate` 的错误文案不再把 `ref` 拼进源码。

## 工程与测试

- 新增 `npm run test:page-scripts` 并并入 `npm run check`：编译 `src/snapshot/scripts.ts` 后在 vm 沙箱里执行真实注入脚本，断言 `</script>`、U+2028/U+2029 不会截断脚本、`ref` 白名单生效、文本/选择器/上传文件名能原样还原。
- 本地回归全部通过：`check`（类型、工具契约、提示词、DSH 包、页面脚本）、`test:tools`、`test:stores` 11/11、`test:security`、`test:updater` 13/13、`test:release` 5/5、`test:installer` 4/4、`test:bridge`、`smoke`（18 组）、`test:desktop` 26/26、`test:update-ui` 6/6。

## 下载与更新

- Windows x64 使用 `aa-browser-setup-0.3.0.exe`。v0.2.0 及更早版本可在「设置 → 软件更新」中检查升级。
- Linux x86_64 使用 `aa-browser-0.3.0-linux-x86_64.AppImage`。添加执行权限后从桌面会话启动；安装要求和回退说明见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.3.0/docs/PLATFORMS.md)。
- 两端资产可以用 `SHA256SUMS.txt` 检查。使用 `gh release verify-asset v0.3.0 <文件路径> --repo yuchen0x1/aa-browser` 验证 GitHub 发行证明。
- `sbom.cdx.json` 可用任意 CycloneDX 1.5 工具读取，用于依赖审计与许可证清点。
- Windows 安装器的 Authenticode 签名状态以文件属性为准；当前仓库仍未配置签名证书。

## 已知限制

- macOS、Android、iOS 和 Web 版不在本版本支持范围内，原因见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.3.0/docs/PLATFORMS.md)。
- 真实旧版升级/回滚与签名安装链路仍需在有证书和发布历史的环境中单独验收；本版本不宣称已完成这些验证。