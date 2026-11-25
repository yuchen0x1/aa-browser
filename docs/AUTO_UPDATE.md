# Aa Browser 自动更新

v0.17.0 的 Windows NSIS 和 Linux AppImage 都使用 [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases) 和 `electron-updater`。公开更新默认使用 GitHub 官方线路，遇到超时、持续低速或中断时才回退到代理线路；安装前校验受信任摘要与文件大小。没有中国大陆网络或完整 Release 大包下载实测。Linux 验证范围是 Ubuntu 24.04 CI/Xvfb、AppImage 启动和 MCP 桥连接；其他发行版仍需实机确认。开发版和 Linux 解包后二进制模式关闭应用内更新；AppImage 只有在当前文件目录可写时才可原地替换。

## 查找和安装

打开「设置 → 软件更新」手动检查或开启自动检查和下载。自动模式约在启动 5 秒后检查，此后每 15 分钟补查，窗口恢复和网络恢复会触发限流补查。失败时按 1、5、15 分钟退避。设置提供稳定版/Beta 通道，Beta 资产由实际发布决定。

主界面显示可用版本、下载进度、速度和失败状态。详细版本、日期、大小及变更日志在更新状态提示中。点击「稍后」会收起当前阶段的提示。下载完成后只有用户确认「重启安装」才交给系统安装器。安装失败需用户重新确认。若 AI 正在操作浏览器或等待人工审批，点击「重启安装」会先提示当前步骤会被中断，确认后才继续。

## 更新期间的 AI 任务

安装更新必须重启进程，端口、令牌和页面会话都会重建。为了不让一次更新把正在进行的长任务打断：

- **只读调用自动续接**：`readOnlyHint` 与 `idempotentHint` 都为真的工具（快照、提取、截图、控制台、网络记录、断言等）以及 `browser_tabs` 的 `list` 在连接断开后进入挂起状态；新实例写入 `connection.json` 后，桥会主动重连并用新的请求 id 重发。AI 客户端收到的是这次调用的真实结果，不需要重发请求。
- **写操作不重放**：点击、输入、拖拽、表单提交、按键等可能已经部分执行，重放会造成第二次副作用。桥只返回一次明确错误，提示浏览器已重启、需要重新读取页面状态。是否重试由 Agent 根据页面现状决定。
- **安装期间不抢启动**：旧实例在退出前写入 `update-restart.json`，新实例就绪后清除。桥看到该标记时只等待新实例（默认最多 120 秒），不会在安装器替换文件时自动启动旧/半装版本；普通退出不会留下该标记。
- **标签与身份一起恢复**：v0.18.0 的会话记录 v3 保存标签 id 和 `profileId`。恢复时复用有效标签 id，并在原 Profile 的持久化 Session 中打开网页；不同 Profile 的相同 URL 不会合并。旧 v1/v2 记录仍可读取，缺失的 `profileId` 归属原始 `default` 身份，保存时升级为 v3。原始身份继续使用 `persist:aa-main`，新 Profile 使用独立 `persist:aa-profile-<id>`，不会把旧登录态迁到新身份。已删除或无法打开的 Profile 标签跳过，不改用其他身份打开。
- **恢复范围有限**：最多恢复 20 个普通 HTTP(S) 标签，隔离标签按设计不恢复；关闭「重启后恢复上次标签页」时也不会保留标签。会话文件不包含 Cookie、Storage、请求头或密码；地址中的账号密码及常见敏感参数会被移除。SessionStorage、会话 Cookie 和页面内存不承诺跨重启恢复。MCP 服务会等恢复页面结束首次加载后再写入 `connection.json`，避免重放的快照落在 `about:blank`；加载失败不阻塞后续连接。
- **工作流使用检查点恢复**：持久化步骤与原 Profile 绑定，已完成步骤不重放；异常退出时状态不确定的写操作不能随普通继续重复执行。定向重试需要重新检查页面并通过原生审批；失联所有者的桌面接管和无法解密输入的重录见 [工作流指南](WORKFLOWS.md)。更新重启本身不授予新权限，也不自动恢复客户端的敏感授权。
- 可用 `AA_BROWSER_RETRY_ON_RECONNECT=0` 关闭只读调用重发，或用 `AA_BROWSER_RESTART_TIMEOUT_MS` 调整更新等待上限。

更新包仍由 `electron-updater` 检查、报告进度并交给原有安装/回滚流程。Aa Browser 的公开 GitHub Release 安装包下载先从该版本的 GitHub 官方地址读取 `SHA256SUMS.txt`，只接受清单中与精确文件名唯一匹配的 SHA-256；更新元数据中的可信文件大小与 SHA-512 也必须匹配。下载先尝试 GitHub 官方线路，超时、持续低速或传输中断后才尝试 GH-Proxy 和备用线路。所有请求仅允许 HTTPS 和受限主机重定向，不向代理发送 Token、Cookie 或身份请求头；下载按可信大小与 SHA-256/SHA-512 校验后才交回安装器。不同线路可用 HTTP Range 续传，进度仍由现有更新界面显示。

v0.18.0 保留原有「设置 → 软件更新」入口、`com.aa.browser` 应用标识和 GitHub provider。Windows 继续读取 `latest.yml`，Linux AppImage 继续读取 `latest-linux.yml`；发布校验要求 `files` 中的文件名、大小、SHA-512 与实际安装包一致，并保留旧更新器使用的顶层 `path` 和 `sha512`。安装包、兼容更新描述和 `SHA256SUMS.txt` 必须来自同一版本并一同上传；仅增加版本号或 Release 标题不能让旧版用户收到提示。公开资产、旧版检测和实际安装的最终结果以该版本发布记录为准。

为确保分块续传、线路切换与最终校验都经过同一安全下载路径，应用内更新关闭了 electron-updater 的 blockmap 差分下载；更新将下载完整安装包，可能比旧版增量更新消耗更多流量和时间。代理是尽力而为的公开第三方服务，没有可依赖的 SLA；当官方及所有备用线路均失败时，当前安装版本保持不变，界面显示失败并按既有策略重试。`install.mjs --repo yuchen0x1/aa-browser` 使用 GitHub API 提供的 Release digest 和大小验证同一组公开线路；手动 `--url` / `--from` 路径保持原行为。

每个 Release 也附 CycloneDX `sbom.cdx.json`，并计入 SHA-256 清单。从 v0.1.0 起，GitHub 不可变 Release 会对标签、提交及资产生成密码学发行证明，可以独立验证任意下载文件。

```sh
gh release verify v0.1.0 --repo yuchen0x1/aa-browser
gh release verify-asset v0.1.0 ./aa-browser-0.1.0-linux-x86_64.AppImage --repo yuchen0x1/aa-browser
```

应用内 SHA-512 比对和 `gh` 发行证明验证是两个流程。Windows Authenticode 签名需要配置证书，目前无证书。未来启用 Windows 签名时，应在 `WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD` 配置发行证书，在首次签名安装包及后续签名更新之间验证发布者校验。代码签名与首次信任建立需单独验收。

旧版 AppImage 更新安装前会将运行中的版本保存至 Electron 用户数据的 `previous-versions/<版本>.AppImage`。运行旧文件、Windows 重新安装旧版以及数据兼容检查见 [恢复步骤](PLATFORMS.md#安装卸载与恢复)。恢复由用户发起。退回旧版本时可以先暂停自动检查。

## 发布

1. 在短期分支同步更新 `package.json`、lockfile、`release-notes-vX.Y.Z.md`、版本历史和 README。
2. 本地跑 `npm run check`、相关回归和 `npm run build`，然后推送 `main`。`main` 推送只跑静态检查与测试；正式打包和安装验收只在标签或手动触发时执行，避免每次推送都重复几分钟的构建。v0.17.0 的标签门禁覆盖 Windows x64 和 Linux x86_64。
3. 确认仓库的不可变 Release 已启用后，从通过本地门禁的 `main` 提交创建并推送 `vX.Y.Z` 标签。标签 CI 会重新构建并打包当前支持平台的产物，验证安装包/更新描述的版本、文件名、大小和 SHA-512，构建 SHA-256 清单。仅当所有声明平台均通过时才在 `release` 环境上传草稿资产。v0.17.0 声明 Windows x64 与 Linux x86_64；Linux 证据仅限 Ubuntu 24.04 CI。标签 CI 是发行的权威门禁，可与 `main` CI 并行。
4. 草稿资产经 GitHub API 摘要检查后公开。正式版本的标签及资产由 GitHub 锁定。草稿中已有资产若摘要不同，应从原通过的 run 恢复已验证产物或排查草稿，原公开版本始终保留。SBOM 在发布 job 内由同一提交的 lockfile 生成，并进入 `SHA256SUMS.txt` 与资源集校验。
5. Release verification 检查公开链接、版本元数据、摘要和发行证明。
6. 发布后归档正文和索引的提交只改文档，提交信息带 `[skip ci]`，避免为已由标签 CI 验证过的同一代码 SHA 再跑一遍完整测试与打包。

建议在发版前保存老版本安装包，并在独立测试 profile 上完成一次升级和恢复。CI 的更新 UI 用模拟 provider 验证交互。打包冒烟会启动当前支持平台的实际安装目录或历史 AppImage 并调用 MCP。完整的已验证证据见 [维护状态](MAINTENANCE.md)。
