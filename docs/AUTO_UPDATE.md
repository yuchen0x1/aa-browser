# Aa Browser 自动更新

Aa Browser 使用 `electron-updater` 配合 `electron-builder` 的 GitHub Releases provider。从 v0.0.4 起，正式安装版默认在启动 5 秒后检查，此后每 15 分钟检查一次，并自动下载新版本；开发模式不会访问更新源。窗口激活、网络恢复及系统休眠恢复时按需补查，近期成功检查后有 2 分钟限流。

## 用户侧行为

设置面板的「软件更新」区域提供：

- 稳定版和 Beta 通道选择。
- 自动检查开关。
- 手动检查更新。
- 真实下载进度。
- 下载完成后的重启安装。
- Release 日期、大小和更新日志（状态提示的悬停信息）。
- 主界面提示条和工具栏入口，无需先打开设置就能看到下载、失败或待安装状态。
- 上次检查和下次自动重试时间（状态提示的悬停信息）。

重复保存设置会替换现有启动检查定时器，不会叠加检查任务；关闭自动检查也会取消尚未执行的启动检查。已有检查或下载进行时不会重复发起检查，下载完成后保留待安装状态，直到用户选择重启安装。

「自动检查并下载更新」关闭后，不再定时检查或启动后续自动下载，但已经开始的下载会继续；手动检查和下载仍然可用。更新下载完成不会自动重启或在退出时偷偷安装，需要点击「重启安装」。点击提示条的「稍后」会收起该阶段的提示，工具栏入口继续保留；下载完成时重新提示。

**0.0.2/0.0.3 首次升级**：旧版本不会自动获得新的界面代码。请先在「设置 → 软件更新」检查、下载并重启安装，或手动运行最新安装包。发布成功不等同于已经安装在用户电脑上。

下载由 `electron-updater` 处理。更新包在安装前会按 `latest.yml` 中的 SHA-512 元数据验证，校验失败或网络失败会保留当前版本并显示错误。

## 发布流程

仓库开发分支统一为 `main`：普通代码更新直接提交到 `main`，版本发布也从 `main` 创建 `v*` 标签。当前远程默认分支为 `main`，已清理其他远程开发分支；保留的 `archive/*` 仅作为历史归档标签，不参与后续开发。

1. 在 `package.json` 更新语义化版本，并创建 `release-notes-v<版本>.md`；同步追加 `docs/releases/release-notes.md`，刷新 README 的「最新更新」。
2. 在 `main` 提交并推送代码。
3. 创建并推送匹配版本的标签：

   ```powershell
   $version = "X.Y.Z"
   git tag "v$version"
   git push origin main
   git push origin "v$version"
   ```

4. `.github/workflows/ci.yml` 先运行类型与工具合约检查、客户端配置验证、构建、MCP 冒烟、原生桌面、持久化及更新状态回归。
5. 标签构建通过后，Windows Release job 使用 `npm run dist -- --publish never` 生成 NSIS 安装包、`latest.yml` 和 blockmap，再生成 `release/SHA256SUMS.txt`。
6. 同一 job 通过 GitHub API 创建草稿 Release，使用对应的 `release-notes-v<版本>.md` 设置正文，核对并上传完整资产集后再公开发布。更新元数据及公开草稿时显式携带版本标签，发布后按标签重新查询并核对 ID、标签和草稿状态；遇到提供方误关联临时标签时使任务失败。遇到同名已有资产会比较摘要，相同则跳过；不同则替换该版本的资产。

工作流只在 `v*` 标签触发发布，使用 GitHub Actions 内置 `GITHUB_TOKEN`，权限为 `contents: write`。不会把 Token 写入源码。

## 配置与限制

- GitHub 仓库必须能公开访问 Release 资产；没有可用 Release 时客户端会显示检查失败。
- 当前打包目标是 Windows NSIS；macOS/Linux 尚未配置构建矩阵和签名资产。
- 代码签名证书尚未配置，Windows SmartScreen 仍可能提示未签名。
- Release 资产由 GitHub Actions 生成；本地 `npm run dist` 只生成安装包，不会发布。
- 真实安装升级和回滚需要在已发布的 Windows 安装包之间验证；本地开发模式不会触发更新。

## 本地验证

```powershell
npm run check
npm run build
npm run smoke
npm run test:updater
npm run test:update-ui
npm run test:release
npm run dist
```

自动更新的在线验证需要一个已发布的、版本高于本地安装版本的 GitHub Release。没有该外部条件时，只能验证构建配置、工作流语法和本地状态处理，不能声称线上更新已验证。

`test:updater` 使用模拟 provider 和定时器验证状态与调度，不下载真实版本，不验证签名、安装或重启。

`test:release` 执行实际工作流中的发布脚本，使用模拟 GitHub API 覆盖新发布、已有草稿、已发布版本的资产修复及标签错配，不写入远程仓库。

## 失败处理

检查失败、下载失败、校验失败或 Release 元数据缺失时，更新器停留在错误状态，当前安装继续可用。更新不会先删除旧版本；安装只在 `update-downloaded` 事件之后由用户点击「重启并安装」触发。

自动更新开启时，同一连续失败流程最多安排 3 次退避重试，间隔为 1、5、15 分钟；正常周期检查会继续。主界面和设置中都可立即重试。下载失败使用已有更新元数据重试下载，不把重试错误当成“已是最新版”。关闭或退出会清理重试任务。
