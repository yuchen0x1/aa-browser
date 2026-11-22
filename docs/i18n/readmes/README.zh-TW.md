# Aa Browser

**為 AI Agent 而生的桌面瀏覽器 —— 開源、MIT 授權。**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <b>繁體中文</b> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> 人像人一樣瀏覽網頁，Agent 像工程師一樣驅動它。

<p align="center">
  <img src="../../../site/assets/og-image.png" alt="Aa Browser — a browser built for agents" width="720" />
</p>

這是**精簡導讀**。完整、權威的文件以中文撰寫：[README.md](../../../README.md) 與 [`docs/`](../../)。

## 這是什麼

傳統瀏覽器是為「人眼看像素」而設計的；AI Agent 需要的是**結構化頁面資料**。Aa Browser 是一個完整的 Chromium 桌面瀏覽器（Electron），任何人都可以正常使用它上網 —— 分頁、網址列、歷史紀錄、下載、頁面內尋找、登入狀態持久保存 —— 同時它透過本機 stdio 橋，把頁面能力開放給任何 [MCP](https://modelcontextprotocol.io) Agent：讀取**結構化無障礙快照**，然後點擊、輸入、選取、拖曳、捲動、擷取與抓取流量。不看截圖，不猜座標。

快照預設是**增量**的：頁面沒變只花一行，小幅變更只回傳差異，而 `ref` 編號跨快照保持穩定。橋只監聽 `127.0.0.1`，每次啟動產生隨機 token，存放於 `~/.aabrowser/connection.json`。

## 特色

- 🖥️ **真正的瀏覽器**：Electron/Chromium 外殼，具備分頁、網址列、上一頁／下一頁、頁面內尋找、下載面板與登入狀態持久保存。
- 🧠 **結構化快照**：頁面被轉換成 YAML 風格的無障礙樹，每個可互動元素都帶 `ref` 編號（`- button "登入" [ref=e5]`），格式對齊 Playwright MCP。
- 💸 **增量快照節省 token**：內容沒變 → 一行；小幅變更 → 只回傳變更的區塊；跳轉或大幅變更則回退成完整快照。長時間任務通常可省下 60%+ 上下文。
- 🎯 **真實輸入路徑**：點擊使用受信任的輸入事件（`isTrusted=true`），輸入走 `insertText` 管線並為 React 受控輸入提供備援，合成事件則覆蓋真實事件偶發遺失的罕見情況。
- 🤖 **MCP 原生**：標準 stdio MCP 橋；Codex、ZCode、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code 與 WorkBuddy 都能驅動它。
- 📊 **診斷能力**：`browser_performance` 無須開啟 DevTools，即可回傳導航耗時、首次繪製、資源大小與慢速資源、JS 堆積與 DOM 規模。
- 🌐 **雙語介面**：跟隨系統或瀏覽器語言，也可在設定中固定簡體中文／English。
- 🔒 **本機優先的安全性**：WebSocket 僅限回環位址、每次啟動隨機 token、站點允許清單、隔離分頁、網路資料脫敏，以及高風險操作在瀏覽器內核准。
- 📦 **可驗證的發行**：Windows NSIS 與 Linux AppImage 同版本發佈，附 `SHA256SUMS.txt`、GitHub 不可變發行證明與 CycloneDX `sbom.cdx.json`。

## 快照範例

在必應首頁呼叫 `browser_snapshot` 會得到（真實輸出，逐字保留）：

```text
页面快照 url: https://www.bing.com/
title: 搜索 - Microsoft 必应
元素数: 19

- banner "登录 Rewards 手机版"
  - img "必应"
  - navigation
    - menuitem "图片" [ref=e1]
    - menuitem "视频" [ref=e3]
- search
  - combobox "搜索网页" [ref=e15]
  - button "语音搜索" [ref=e16]
```

Agent 隨後對某個 `ref` 執行動作：

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

動作之後你會拿到一份**增量快照** —— 只有變更的區塊，以及哪些 `ref` 編號被新增或失效。`browser_snapshot { full: true }` 會強制回傳完整樹。

## 安裝

### 一句提示詞（建議）

把 [PROMPT.md](../../../PROMPT.md) 中的提示詞送給任何能執行本機指令的 AI。若 Aa Browser 尚未安裝，它會下載官方安裝程式、驗證 SHA-256、安裝、啟動、寫入 MCP 設定，並實際呼叫 `browser_tabs` 驗證。若 Aa Browser 已在執行，則只寫入設定並驗證。

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

安裝程式從不互動提問。`--clients zcode,cursor` 限制要設定哪些用戶端，`--dir <dir>` 覆寫安裝目錄，`--no-launch` 跳過啟動，`--sha256 <hex>` 指定預期的安裝程式雜湊值。任何其他 MCP 用戶端都可使用 `--print-config` 的輸出。

### Windows

從 [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) 下載 `aa-browser-setup-<version>.exe` 並執行。安裝程式**未做程式碼簽章**：出現 SmartScreen 時選擇「更多資訊 → 仍要執行」。每個版本也附上 `SHA256SUMS.txt`、`sbom.cdx.json` 與不可變發行證明，讓你自行核對檔案。

### Linux AppImage

下載 `aa-browser-<version>-linux-x86_64.AppImage`，賦予執行權限並從目前的桌面工作階段啟動。需要 GTK 3、NSS、GBM、音訊函式庫與可用的 Chromium 沙箱；MCP 存取需要系統 Node.js 22.12 或更新版本。

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

沒有 FUSE 時，改用 `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage` 啟動。各發行版的支援狀態與修復步驟見[平台指南](../../../docs/PLATFORMS.md)。

### 從原始碼建置

需要 Node.js 22.12 或更新版本。

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

附熱重載渲染層的開發模式是 `npm run dev`；它使用獨立的 `aa-browser-dev` 使用者資料目錄，因此可與已安裝版本同時執行。

## 連接你的 Agent

前置條件：Aa Browser 正在執行（它會把連接埠與 token 寫入 `~/.aabrowser/connection.json`）、用戶端支援 stdio MCP，且兩者以同一使用者身分在同一台機器上執行。

- **一鍵完成**：設定 → 連接 AI 用戶端 → 勾選用戶端 → 寫入。之後請重新啟動用戶端。
- **手動**：執行 `node install.mjs --print-config`，把印出的 `command` / `args` / `env` 貼進用戶端設定。既有設定會備份為 `<file>.aa-backup-<timestamp>`；只會修改 `aa-browser` 這一個項目，且寫入具備冪等性。

### 狀態與驗證

| 工具列狀態 | 含義 |
| --- | --- |
| 等待 AI 連線 | 還沒有 MCP 橋連上：設定未寫入、用戶端未重新啟動，或瀏覽器未執行 |
| 等待 AI 首次呼叫 | 橋已連上並完成驗證，但尚未有任何工具呼叫成功 |
| AI 已連線 ×N | 至少一次 `browser_tabs` 列表呼叫成功；N 為已驗證的橋數量 |

寫好的設定**不等於**可用的連線。請用 `node install.mjs --verify-only` 驗證，或讓 Agent 實際呼叫 `browser_tabs`。

## MCP 工具

共 **43 個工具**，分為五組：導航與快照（5）、互動（9）、讀取與狀態（20）、網路與 Mock（6）、診斷與分頁（3）。用戶端的工具名稱可能帶有 `mcp__aa-browser__` 前綴。

| 分組 | 工具 |
| --- | --- |
| 導航與快照 | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| 互動 | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| 讀取與狀態 | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| 網路與 Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| 診斷與分頁 | `browser_performance`, `browser_resize`, `browser_tabs` |

共用行為：多數工具會隨結果回傳一份快照（`snapshot: false` 可跳過），除 `browser_resize` 與 `browser_downloads` 外所有工具都接受 `tabId`，單次呼叫 180 秒後逾時，審批最多等待 120 秒，網路詳情預設脫敏。完整的工具手冊見 [site/tools.html](../../../site/tools.html)。

## 安全性

- Agent 服務只監聽 `127.0.0.1`，每次啟動使用隨機 token，並拒絕非本機來源；連接埠與 token 存放於 `~/.aabrowser/connection.json`，正常結束時刪除。
- 頁面檢視不掛載 preload 腳本；快照與動作腳本由主行程注入。導航只允許 `http:` / `https:` —— `file:`、`data:`、`devtools:` 等協定會被拒絕。
- 敏感輸入欄位必須由使用者親自填寫：Agent 提供的文字永遠不會被寫入、讀取或回傳。啟用「高風險操作人工確認」後，表單送出、輸入後按 Enter 以及未脫敏的網路存取都會在瀏覽器中等待核准（120 秒後視為拒絕）。
- 網路詳情與 HAR 匯出預設會脫敏認證標頭與類憑證參數。
- **站點允許清單**：只作用於導航，留空表示關閉；即使留空，`file:`、`data:`、`devtools:` 等非網頁協定仍不會被放行。
- **接入只改一個條目**：寫入前先備份用戶端原設定，只修改 `aa-browser` 一個條目，不寫入任何 token 或密碼；安裝包下載時會校驗 Release 的 SHA-256 digest 與檔案標頭。
- 隔離分頁使用獨立的 session 分割區：不共用 Cookie 與登入狀態，關閉時清除，且不計入全域歷史、最近關閉清單與工作階段還原。
- **邊界**：Agent 能看到頁面內容與流量，包括 Cookie、儲存空間、標頭與回應內容。這些控制是緩解措施，不是通用 DLP —— 不要讓不受信任的 Agent 造訪高敏感站點。

請透過 [SECURITY.md](../../../SECURITY.md) 的私密回報管道通報漏洞，切勿在公開 issue 中提出。

## 平台與限制

| 平台 | 官方組建 | 說明 |
| --- | --- | --- |
| Windows 11 x64 | NSIS 安裝程式 | 持續維護，由 CI 與本機回歸測試覆蓋 |
| Windows 10 x64 | 相同安裝程式 | 共用 Windows 11 組建；實機升級驗收仍在進行中 |
| Linux x86_64（Ubuntu 桌面） | AppImage | 需要系統 Node.js 22.12+；其他發行版仍需實機驗證 |
| Windows ARM64 / macOS / Android / iOS | 無 | 安裝程式會明確拒絕，不會假裝安裝 |

已知限制：

- Windows 上**沒有程式碼簽章**：SmartScreen 會警告，需要選擇「更多資訊 → 仍要執行」。
- **不是 Chrome 的替代品**：沒有書籤、擴充功能或帳號／多裝置同步。範圍是「瀏覽器核心 + Agent 存取」。
- **Linux 的 MCP 存取需要系統 Node.js 22.12+**；Windows 上若找不到系統 Node，則使用內建的執行環境。
- **工作階段還原的範圍有限**：只還原一般網頁分頁，最多 20 筆，永不包含隔離分頁、內部頁面或非 HTTP(S) 網址。
- **每個使用者資料目錄只能有一個實例**；開發版使用自己的目錄，因此兩者可以同時執行。
- **安裝與更新依賴 GitHub Releases**；AppImage 自我更新需要可寫入的目錄。

## 文件

詳細文件目前以中文撰寫：

| 文件 | 內容 |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | 平台與用戶端矩陣、安裝程式參數、手動步驟、疑難排解 |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | 發行矩陣、Linux 相依套件、解除安裝與資料還原 |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | 更新檢查、下載、重新啟動安裝、SHA-512 與回滾 |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | DeepSeek Harness 外掛安裝與驗證 |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | 發行證據、回歸紀錄與維護邊界 |
| [版本說明](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | 各版本的變更歷史 |
| [site/tools.html](../../../site/tools.html) | 完整的 42 工具手冊（本機開啟，無須部署） |

## 參與貢獻與授權

歡迎回報 bug、討論功能、修正文件與提交 PR —— 開始前請先讀 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。新增 MCP 工具時，請一併更新 `src/main/tools.ts`、`cli/mcp.mjs`、本 README 的工具表以及 `site/tools.html`；`npm run check` 會檢查前三者是否保持一致。

MIT licensed —— 詳見 [LICENSE](../../../LICENSE) © Aa Browser contributors。

本譯文可能落後於中文原文。本 README 的翻譯維護於 [README.md](../../../README.md)（简体中文）與 `docs/i18n/readmes/README.<language>.md`；完整清單見 `../readme-languages.json`。