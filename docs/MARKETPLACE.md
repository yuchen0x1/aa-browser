# 插件市场接入（DeepSeek Harness）

Aa Browser 通过一个独立的 DeepSeek Harness 插件出现在 **设置 → 插件市场** 中。插件只负责把 Aa Browser 已经自带的 MCP 桥交给 DSH，不重复打包浏览器，也不下载或启动浏览器。

插件包位置：[packages/dsh/](../packages/dsh)（npm 包名 `aa-browser-dsh`，v0.1.0）。放在 `packages/` 下是为了符合 awesome-dsh-plugin 对 monorepo 子包的收录约定。

## 它做什么

安装并启用后，bundle 向 DSH 注入两行：

| 行 | 包 | 作用 |
| --- | --- | --- |
| `aa-browser-dsh` | `aa-browser-dsh`（本包 Host 插件） | 把随包的 `bridge.cjs` 原子复制到 `~/.aabrowser/dsh-bridge.cjs` |
| `aa-browser-mcp` | DSH 自带的 `@deepseek-ai/dsh-mcp-client` | 用 DSH 自身运行时启动该桥，`serverName: aa-browser` |

- 不需要系统 Node.js：`command` 使用 `process.execPath`；Electron 桌面版配合 `ELECTRON_RUN_AS_NODE=1` 以 Node 方式运行。
- 工具以 `mcp__aa-browser__*` 出现，数量与 Aa Browser 版本一致（当前 34 个）。
- 浏览器未启动时 MCP 条目仍会连接，调用工具会快速返回明确错误；启动 Aa Browser 后无需重载 DSH（桥每 5 秒重试连接）。
- 更新：Aa Browser 本体自动更新；插件通过插件市场/重新安装更新，重新激活时覆盖桥文件，MCP 配置路径不变。

## 安装方式

已经在当前 DSH profile 中本地安装并启用（可在 **设置 → 插件市场 → 已安装** 看到）。其他方式：

```sh
# npm（发布后）
dsh plugin --profile web add aa-browser-dsh

# GitHub monorepo 子目录（固定 40 位 commit 便于后续升级）
dsh plugin --profile web add "github:yuchen0x1/aa-browser#<commit>&path:/packages/dsh"

# 本地目录
dsh plugin --profile web add "<仓库绝对路径>/packages/dsh"
```

DSH Desktop 也可以用 **Plugins → Add plugin** 选择本地 `packages/dsh/` 目录。安装后如未自动加载，重启 DSH 或重新加载 profile。

验证：确认 `~/.aabrowser/dsh-bridge.cjs` 存在，且日志出现 `aa-browser-dsh: staged Aa Browser MCP bridge v0.2.0 ...`；然后让 Agent 实际调用一次 `mcp__aa-browser__browser_tabs`。工具出现在列表里只证明桥启动成功，不能证明浏览器可达。

## 上架插件市场

插件市场目录由 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护，DSH 通过 CDN 索引读取。上架需要三步：

1. **发布 npm 包**（目录会把 npm 包映射为可安装版本）：
   ```sh
   cd packages/dsh
   npm run sync      # 从仓库 out/bridge/mcp.cjs 同步桥
   npm pack --dry-run
   npm publish --access public
   ```
   需要 npm 账号与 `aa-browser-dsh` 包名权限。当前包名在 npm registry 上可用（404）。

2. **给仓库加 topic**：在 GitHub 仓库 Settings → Topics 添加 `dsh-plugin`。

3. **提交收录 PR**：把 [packages/dsh/marketplace-entry.yml](../packages/dsh/marketplace-entry.yml) 复制为
   `data/plugins/yuchen0x1__aa-browser--packages-dsh.yml`，向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR。文件内容：
   ```yaml
   url: https://github.com/yuchen0x1/aa-browser/tree/main/packages/dsh
   name: yuchen0x1/aa-browser#packages/dsh
   category: browser
   description:
     en: Connects a running Aa Browser so DeepSeek Harness can drive the browser through its MCP tools.
     zh: 把正在运行的 Aa 浏览器接入 DeepSeek Harness，让 Agent 通过 MCP 工具驱动浏览器。
   icon: https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/packages/dsh/assets/icon-180.png
   ```
   收录要求（来自其 contributing.md）：仓库声明 `dsh.bundle`、有真实可用代码、仓库创建满 1 天、活跃维护、描述属实且不带营销词。条目合并后目录按日刷新。

4. 用户侧：DSH 0.2.1+ 在 **插件 → 发现 → 索引源** 添加 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，即可在发现页和市场看到该插件。

> 上架不是自动的：npm 发布和 PR 都需要仓库/账号凭据。本轮已完成插件包、本地安装验证和 PR 条目，未代填 npm 凭据或提交外部仓库 PR。

## 本地验证记录

- 插件包结构化检查：`npm run check:dsh`（清单、patch 行、桥版本、locale/detail、图标、marketplace 条目）。
- 本地安装：通过 `plugin_manager install_bundle` 安装到当前 DSH profile，插件行启用；当前会话已暴露 `mcp__aa-browser__*` 34 个工具。
- 桥启动路径：以 DSH 自身运行时启动 `~/.aabrowser/dsh-bridge.cjs`，MCP 握手返回 34 个工具。
- 离线回归：`npm run test:bridge` 覆盖「浏览器未运行」时工具调用必须返回 isError 而不是挂起。
- 未验证：marketplace 目录收录后的真实安装/升级链路（依赖 npm 发布与 PR 合并）。

## 限制

- 仅 Windows x64 与 Linux x64；没有 macOS/Android 版本。
- 工具名带 `mcp__aa-browser__` 前缀。
- 浏览器未运行时工具调用会失败，直到启动 Aa Browser。
- 某些页面动作会等待 Aa Browser 审批面板；MCP 调用超时设为 180 秒。
- Agent 能读取页面内容与抓包数据（Cookie、Storage、响应体等），与 Aa Browser 的安全边界一致。
