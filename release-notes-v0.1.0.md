# Aa Browser v0.1.0

## 版本概述

新增 Linux x86_64 AppImage。可在 Linux 桌面浏览网页、使用标签页和查找，并通过系统 Node.js 接入 MCP。应用在替换 AppImage 前会保存当前版本，安装出错时可以手动启动旧版。

## 下载与更新

- Windows x64 使用 `aa-browser-setup-0.1.0.exe`。旧版可在「设置 → 软件更新」中检查升级。
- Linux x86_64 使用 `aa-browser-0.1.0-linux-x86_64.AppImage`。添加执行权限后从桌面会话启动。安装要求和回退说明见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.1.0/docs/PLATFORMS.md)。
- 两端资产可以用 `SHA256SUMS.txt` 检查。使用 `gh release verify-asset v0.1.0 <文件路径> --repo yuchen0x1/aa-browser` 验证 GitHub 发行证明。
- Windows 安装器的 Authenticode 签名状态以文件属性为准。
