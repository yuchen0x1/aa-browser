# Aa Browser · 一键安装提示词

> **用法**：把下面代码块里的内容**整段复制**，粘贴给你的 AI 客户端（ZCode / Claude Code / Cursor / Cline / Qwen…）发送即可。AI 会自动完成：下载 → 静默安装 → 启动 → 把 MCP 配置写入你本机检测到的 AI 客户端。
>
> **发布者注意**：把提示词里的 `https://github.com/yuchen0x1/aa-browser/releases/latest/download` 换成你的实际发布地址（GitHub Releases 直链、网盘直链均可；也可以只给本地文件路径）。

## 复制这段给 AI

```text
请帮我在这台电脑上安装并接入 Aa Browser（一款 AI 原生浏览器，装好后你就能用浏览器工具替我上网、点击、填表、抓接口）。请严格执行以下步骤，任何一步失败就停下来告诉我原因，不要跳过或猜测：

1. 环境检查：Windows 64 位；Node.js ≥ 20（没有就用 winget install OpenJS.NodeJS.LTS 安装）。

2. 获取安装器（两种方式任选）：
   a. 下载这两个文件到同一个临时目录：
      - 安装脚本：https://github.com/yuchen0x1/aa-browser/releases/latest/download/install.mjs
      - 安装包：https://github.com/yuchen0x1/aa-browser/releases/latest/download/aa-browser-setup-0.3.1.exe
   b. 或者只下载 install.mjs，之后用 --repo 参数让它自己从 GitHub Releases 取最新安装包。

3. 执行安装（在临时目录运行）：
   node install.mjs --url <安装包文件路径或直链> --clients zcode,claude,cursor
   说明：
   - 如果只有 install.mjs 没有安装包，改用：node install.mjs --repo yuchen0x1/aa-browser
   - --clients 是可选的客户端白名单，可选 id：zcode / claude / cursor / windsurf / cline / vscode / gemini / qwen；
     不传 --clients 表示接入所有检测到的客户端。
   - 脚本会自动：静默安装 → 启动 Aa Browser → 等待就绪 → 把 MCP 配置写入所选客户端
     （原配置文件会自动备份为 *.aa-backup-*，重复执行是安全的）。

4. 验证：确认 ~/.aabrowser/connection.json 已生成且脚本输出显示"已写入/已配置"；安装器最后会打印 🎉。

5. 向我汇报：安装位置、接入了哪些客户端、以及如何卸载（系统"设置 → 应用"里卸载 Aa Browser）。

注意：MCP 配置写入后需要重启对应 AI 客户端才会加载 aa-browser 工具。配置写入操作只改 aa-browser 一个键，绝不碰其他内容。
```

## 等效的手动一条命令（不用 AI，自己粘贴到终端）

```powershell
# PowerShell（Windows）——把 <URL> 换成发布地址
irm <URL>/install.mjs -OutFile install.mjs
node install.mjs --url <URL>/aa-browser-setup-0.3.1.exe
```

```bash
# macOS / Linux 用户暂无安装包，走源码：
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser && cd aa-browser && npm install && npm run build && node cli/setup.mjs --yes
```

## 给发布者：如何让提示词里的链接生效

1. 把仓库推到 GitHub；
2. `npm run dist` 产出 `release/aa-browser-setup-0.3.1.exe`；
3. GitHub → Releases → Draft a new release → 上传该 exe（及可选的 install.mjs）→ Publish；
4. 把提示词里的 `https://github.com/yuchen0x1/aa-browser/releases/latest/download` 替换为仓库 Releases 直链，或让用户用 `--repo yuchen0x1/aa-browser` 自动拉取。
