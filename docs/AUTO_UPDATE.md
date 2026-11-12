# Aa Browser 自动更新

Aa Browser 使用 `electron-updater` 配合 `electron-builder` 的 GitHub Releases provider。正式安装版启动后默认在 15 秒后检查更新，之后每 6 小时检查一次；开发模式不会访问更新源。

## 用户侧行为

设置面板的「软件更新」区域提供：

- 稳定版和 Beta 通道选择。
- 自动检查开关。
- 手动检查更新。
- 真实下载进度。
- 下载完成后的重启安装。
- Release 日期、大小和更新日志（状态提示的悬停信息）。

下载由 `electron-updater` 处理。更新包在安装前会按 `latest.yml` 中的 SHA-512 元数据验证，校验失败或网络失败会保留当前版本并显示错误。

## 发布流程

仓库开发分支统一为 `main`：普通代码更新直接提交到 `main`，版本发布也从 `main` 创建 `v*` 标签。当前远程默认分支为 `main`，已清理其他远程开发分支；保留的 `archive/*` 仅作为历史归档标签，不参与后续开发。

1. 在 `package.json` 更新语义化版本，并创建 `release-notes-v<版本>.md`；同步追加 `docs/releases/release-notes.md`，刷新 README 的「最新更新」。
2. 在 `main` 提交并推送代码。
3. 创建并推送匹配版本的标签：

   ```powershell
   git tag v0.6.3
   git push origin main
   git push origin v0.6.3
   ```

4. `.github/workflows/ci.yml` 先运行类型检查、工具合约检查、构建和冒烟测试。
5. 标签构建通过后，Windows Release job 使用 `electron-builder --publish always` 创建 GitHub Release，并上传 NSIS 安装包、`latest.yml` 和 blockmap。
6. 同一 job 使用对应的 `release-notes-v<版本>.md` 设置 Release 标题和正文，并上传 `release/SHA256SUMS.txt`。

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
npm run dist
```

自动更新的在线验证需要一个已发布的、版本高于本地安装版本的 GitHub Release。没有该外部条件时，只能验证构建配置、工作流语法和本地状态处理，不能声称线上更新已验证。

## 失败处理

检查失败、下载失败、校验失败或 Release 元数据缺失时，更新器停留在错误状态，当前安装继续可用。更新不会先删除旧版本；安装只在 `update-downloaded` 事件之后由用户点击「重启并安装」触发。
