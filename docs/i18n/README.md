# README 多语言

仓库根目录的 `README.md` 是简体中文主文，也是所有语言版本的**事实来源**。11 份精简译本集中放在 `docs/i18n/readmes/`，不再占用仓库根目录文件列表。其他语言是精简导读（概述、特性、安装、接入、工具一览、安全、平台、文档索引），权威细节以中文主文与 `docs/` 为准。

## 当前语言

语言清单在 [`readme-languages.json`](./readme-languages.json)，共 12 种：

| 代码 | 语言 | 文件 |
| --- | --- | --- |
| `zh-CN` | 简体中文（主文） | [`README.md`](../../README.md) |
| `en` | English | [readmes/README.en.md](./readmes/README.en.md) |
| `zh-TW` | 繁體中文 | [readmes/README.zh-TW.md](./readmes/README.zh-TW.md) |
| `ja` | 日本語 | [readmes/README.ja.md](./readmes/README.ja.md) |
| `ko` | 한국어 | [readmes/README.ko.md](./readmes/README.ko.md) |
| `es` | Español | [readmes/README.es.md](./readmes/README.es.md) |
| `pt-BR` | Português (Brasil) | [readmes/README.pt-BR.md](./readmes/README.pt-BR.md) |
| `fr` | Français | [readmes/README.fr.md](./readmes/README.fr.md) |
| `de` | Deutsch | [readmes/README.de.md](./readmes/README.de.md) |
| `ru` | Русский | [readmes/README.ru.md](./readmes/README.ru.md) |
| `ar` | العربية | [readmes/README.ar.md](./readmes/README.ar.md) |
| `hi` | हिन्दी | [readmes/README.hi.md](./readmes/README.hi.md) |

`en` 版 `readmes/README.en.md` 同时充当其他语言的**结构基准**：章节顺序、代码块、表格、链接与它逐项对应。

## 新增一种语言

1. 在 `readme-languages.json` 的 `languages` 追加一项（`code` / `nativeName` / `file` / `dir`）。
2. 以 `readmes/README.en.md` 为结构基准，在 `readmes/` 下新建 `README.<code>.md`：
   - 首行是 H1；
   - H1 与徽章之间放语言栏，复制任意现有版本，**只把你这一版改成 `<b>原生名</b>`**，其余 11 项保持链接；
   - 代码块、命令、工具名、路径、关键数字（44 工具、5/9/20/6/4 分组、`127.0.0.1`、180 秒、120 秒、20 条、Node.js 22.12+）保持原样；
   - 必留链接：`../../../PROMPT.md`、`../../CONNECT.md`、`../../PLATFORMS.md`、`../../../LICENSE`、`../../../SECURITY.md`、`../../../CONTRIBUTING.md`。
3. 把语言栏同步加进 `README.md` 与其他语言文件（索引是双向的，缺一项检查就会失败）。
4. 运行 `npm run check:readme-i18n`，通过后提交。

## 校验

`npm run check:readme-i18n`（已并入 `npm run check`，CI 会跑）检查四件事：

- 清单与语言栏逐项对应，当前语言为加粗非链接，语言栏不含清单外链接；
- 每个语言文件存在、以 H1 开头、没有 `TODO` / `{{…}}` 之类占位内容；
- 安装命令、工具名、端口、工具数量与必备文档链接没有在翻译中丢失；
- 所有相对链接与图片路径真实存在；磁盘上不存在清单未登记的 README 文件。

## 维护约定

- 中文主文改动（新增工具、改参数、改端口）后，若涉及**精简版里的那几项事实**，同步更新各语言版本；只改细节章节时可以不动翻译版，但要在 PR 里说明。
- 翻译版结尾都保留了「翻译可能滞后于中文原文」的说明，用于兜底。
- 欢迎以 PR 补充其他语言：只需按上面的步骤新增一组文件，不必改动脚本。
