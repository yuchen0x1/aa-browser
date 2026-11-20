# Aa Browser 静态宣传站

零依赖（无构建步骤、无 CDN、无追踪脚本）的产品宣传站。品牌视觉取自桌面版 `src/renderer/src/style.css`：石墨黑底 + 海玻璃青强调色。

## 本地预览

任选一种静态服务器，然后打开 <http://127.0.0.1:4321/>：

```bash
# Node.js
npx --yes serve site -l 4321

# 或 Python
python -m http.server 4321 --directory site
```

直接双击 `index.html` 也能看，但复制按钮在 `file://` 下会退化为 `execCommand` 兜底。

## 目录

```text
site/
├── index.html            落地页（单页 8 个区块）
├── tools.html            42 个 MCP 工具手册（搜索 + 分类过滤）
├── 404.html              自定义 404
├── assets/
│   ├── site.css          设计系统与全部布局
│   ├── site.js           导航 / 演示切换 / 搜索 / 复制
│   ├── icon.png          应用图标（来自 build/icon.png）
│   ├── og-image.png      社交分享图 1200×630（由 og-source.html 截图生成）
│   └── og-source.html    分享图源文件
├── robots.txt
├── sitemap.xml
└── .nojekyll             GitHub Pages 不启用 Jekyll
```

## 部署

### GitHub Pages

1. 把 `site/` 内容推到 `gh-pages` 分支，或在仓库 Settings → Pages 选「GitHub Actions」。
2. 若使用官方 Pages 工作流，把 `site/` 作为 artifact 上传：

```yaml
- uses: actions/upload-pages-artifact@v3
  with:
    path: site
```

3. 自定义域名时，把 `robots.txt`、`sitemap.xml`、`index.html` 里的
   `https://yuchen0x1.github.io/aa-browser/` 替换为实际域名，并补充 CNAME。

### 任意静态托管（Netlify / Vercel / OSS / Nginx）

把 `site/` 整个目录作为发布根目录即可，无需构建命令。Nginx 示例：

```nginx
location / {
  root /var/www/aa-browser-site;
  try_files $uri $uri/ =404;
}
error_page 404 /404.html;
```

## 内容来源与更新点

页面的功能描述、版本号、下载文件名、安全边界均来自仓库内 `README.md`、`docs/CONNECT.md`、
`docs/PLATFORMS.md` 与 v0.2.0 发行说明。升级版本时同步修改：

- `index.html`：hero 徽章 `v0.2.0`、统计数字、下载卡文件名（`aa-browser-setup-0.2.0.exe` /
  `aa-browser-0.2.0-linux-x86_64.AppImage`）、发行条日期与链接、JSON-LD `softwareVersion`。
- `tools.html`：工具总数（当前 42）与新增工具条目；侧栏与筛选器里的分类计数。
- CSS / JS 引用上的 `?v=0.2.0`：与产品版本一同递增，避免静态托管缓存旧样式。
- 本文件与 `sitemap.xml` 的 `lastmod`。

## 设计约定

- 颜色全部走 `:root` token，强调色 `--mint: #78cbb9`（与桌面端一致）。
- 断点：1080（导航折叠为全屏菜单）/ 860（单列内容）/ 620（手机）。
- 移动端菜单用原生按钮 + `aria-expanded`，展开时锁定页面滚动，底部固定下载入口。
- 动画全部尊重 `prefers-reduced-motion`；演示卡在用户交互后停止自动轮播。
- 无外部字体与图片请求；系统字体栈覆盖中英文与等宽代码。
- 无 JS 时仍可读：`<noscript>` 样式会解除滚动入场动画的透明度，FAQ 使用原生 `<details>`，演示首屏显示第一步，导航锚点可用。
- 工具搜索会自动把分类切回「全部」，避免工具名被旧分类过滤成空结果。

## 已验证

在当前版本上检查过：

- 42 个工具条目与 `src/main` 中的 MCP 工具名一一对应；分类计数 5 / 9 / 19 / 6 / 3。
- 本地链接、跨页锚点、`<symbol>` 引用静态检查 0 问题（3 个页面、85 个 id、13 个外链）。
- 390 / 768 / 900 / 1440 宽度下无横向溢出；导航在 900 及以下折叠为菜单。
- 演示切换、工具分类过滤 + 搜索、复制按钮（含真实点击）与 404 页面均正常；控制台无报错。
- 下载链接与 GitHub Release 资产名已对照 v0.2.0 实际发布结果。

## 重新生成分享图

`og-source.html` 按 1200×630 固定排版。截图时若系统缩放不是 100%，浏览器实际视口可能是
1200×630 的整数倍（例如 1.2×）；截取页面左上角对应区域后缩放到 1200×630 即可：

```bash
# 1. 启动静态服务
python -m http.server 4321 --directory site

# 2. 打开 /assets/og-source.html，按页面宽度截图（页面本身固定 1200×630）
# 3. 用 Pillow 裁掉视口多余部分并压到 1200×630
python -c "from PIL import Image; Image.open('shot.png').crop((0,0,1440,756)).resize((1200,630), Image.LANCZOS).save('assets/og-image.png', optimize=True)"
```

`og-source.html` 只用于出图，带 `noindex`，不参与页面导航。

## 视觉预览

- 首屏：左侧主张 + 右侧「人看到的页面 / Agent 看到的结构」分栏示意。
- 主色 `#0b0f11`，面板 `#12191c`，强调色 `#78cbb9`；圆角 10–22px，1px 边框，无重阴影。
- 版式：等宽小标签 + 大字号中文标题 + 大面积留白；代码块与结构化快照是主要视觉元素。

