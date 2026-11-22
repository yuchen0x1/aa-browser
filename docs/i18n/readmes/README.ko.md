# Aa Browser

**에이전트를 위한 데스크톱 브라우저 — 오픈 소스, MIT 라이선스.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <b>한국어</b> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> 사람은 사람처럼 브라우징하고, 에이전트는 엔지니어처럼 구동한다.

<p align="center">
  <img src="../../../site/assets/og-image.png" alt="Aa Browser — a browser built for agents" width="720" />
</p>

이 문서는 **요약 번역본**입니다. 완전하고 권위 있는 문서는 중국어로 작성되어 있습니다: [README.md](../../../README.md)와 [`docs/`](../../).

## 이것은 무엇인가

기존 브라우저는 "사람이 픽셀을 보는" 용도로 설계되었지만, AI 에이전트에게 필요한 것은 **구조화된 페이지 데이터**입니다. Aa Browser는 누구나 평범하게 사용할 수 있는 완전한 Chromium 데스크톱 브라우저(Electron)입니다 — 탭, 주소창, 방문 기록, 다운로드, 페이지 내 찾기, 로그인 상태 유지 — 그리고 로컬 stdio 브리지를 통해 어떤 [MCP](https://modelcontextprotocol.io) 에이전트에게든 페이지를 제공합니다. **구조화된 접근성 스냅샷**을 읽고 클릭, 입력, 선택, 드래그, 스크롤, 추출, 트래픽 캡처를 수행합니다. 스크린샷도, 좌표 추측도 없습니다.

스냅샷은 기본적으로 **증분** 방식입니다. 변하지 않은 페이지는 한 줄로 끝나고, 작은 변경은 차이만 반환하며, `ref` ID는 스냅샷 간에 안정적으로 유지됩니다. 브리지는 `127.0.0.1`에서만 수신하고, 실행할 때마다 생성되는 무작위 토큰을 `~/.aabrowser/connection.json`에 저장합니다.

## 하이라이트

- 🖥️ **진짜 브라우저**: Electron/Chromium 셸로 탭, 주소창, 뒤로/앞으로, 페이지 내 찾기, 다운로드 패널, 로그인 상태 유지를 갖춥니다.
- 🧠 **구조화된 스냅샷**: 페이지가 YAML 스타일 접근성 트리로 바뀌고, 모든 상호작용 요소가 `ref` ID를 가집니다(`- button "로그인" [ref=e5]`). Playwright MCP 형식에 맞춰져 있습니다.
- 💸 **증분 스냅샷으로 토큰 절약**: 변화 없음 → 한 줄, 작은 변화 → 변경된 블록만, 탐색이나 큰 변화는 전체 스냅샷으로 대체됩니다. 긴 작업에서는 보통 컨텍스트를 60%+ 절약합니다.
- 🎯 **실제 입력 경로**: 클릭은 신뢰된 입력 이벤트(`isTrusted=true`)를 사용하고, 입력은 `insertText` 파이프라인과 React 제어 입력을 위한 대체 경로를 사용하며, 실제 이벤트가 드물게 유실되는 경우 합성 이벤트로 보완합니다.
- 🤖 **MCP 네이티브**: 표준 stdio MCP 브리지로, Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code, WorkBuddy가 구동할 수 있습니다.
- 📊 **진단**: `browser_performance`는 DevTools를 열지 않고도 탐색 타이밍, 첫 페인트, 리소스 크기와 느린 리소스, JS 힙, DOM 규모를 반환합니다.
- 🌐 **이중 언어 UI**: 시스템 또는 브라우저 언어를 따르거나, 설정에서 중국어 간체／English를 고정할 수 있습니다.
- 🔒 **로컬 우선 보안**: 루프백 전용 WebSocket, 실행마다 무작위 토큰, 사이트 허용 목록, 격리 탭, 네트워크 데이터 마스킹, 고위험 작업의 브라우저 내 승인.
- 📦 **검증 가능한 릴리스**: Windows NSIS와 Linux AppImage를 동일 버전으로 배포하며 `SHA256SUMS.txt`, GitHub 불변 릴리스 증명, CycloneDX `sbom.cdx.json`을 함께 제공합니다.

## 스냅샷 예시

Bing 홈페이지에서 `browser_snapshot`을 호출하면 다음이 반환됩니다(실제 출력, 그대로 유지):

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

그다음 에이전트는 `ref`에 대해 동작합니다:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

동작 후에는 **증분 스냅샷**이 반환됩니다 — 변경된 블록만, 그리고 추가되거나 무효화된 `ref` ID입니다. `browser_snapshot { full: true }`는 전체 트리를 강제합니다.

## 설치

### 프롬프트 하나 (권장)

[PROMPT.md](../../../PROMPT.md)의 프롬프트를 로컬 명령을 실행할 수 있는 어떤 AI에게든 보내세요. Aa Browser가 아직 설치되지 않았다면 공식 설치 프로그램을 내려받아 SHA-256을 검증하고 설치, 실행, MCP 설정 작성을 수행한 뒤 `browser_tabs`를 실제로 호출해 검증합니다. 이미 실행 중이라면 설정만 작성하고 검증합니다.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

설치 프로그램은 대화형으로 질문하지 않습니다. `--clients zcode,cursor`는 설정할 클라이언트를 제한하고, `--dir <dir>`는 설치 디렉터리를 덮어쓰고, `--no-launch`는 실행을 건너뛰며, `--sha256 <hex>`는 예상 설치 프로그램 해시를 고정합니다. 다른 MCP 클라이언트는 `--print-config`의 출력을 사용할 수 있습니다.

### Windows

[GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest)에서 `aa-browser-setup-<version>.exe`를 내려받아 실행하세요. 설치 프로그램은 **코드 서명이 되어 있지 않습니다**: SmartScreen이 나타나면 "추가 정보 → 실행"을 선택하세요. 각 릴리스에는 `SHA256SUMS.txt`, `sbom.cdx.json`, 불변 릴리스 증명도 함께 제공되므로 파일을 직접 검증할 수 있습니다.

### Linux AppImage

`aa-browser-<version>-linux-x86_64.AppImage`를 내려받아 실행 권한을 부여하고 현재 데스크톱 세션에서 실행하세요. GTK 3, NSS, GBM, 오디오 라이브러리와 동작하는 Chromium 샌드박스가 필요하며, MCP 접속에는 시스템 Node.js 22.12 이상이 필요합니다.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

FUSE가 없다면 `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`로 실행하세요. 배포판별 상태와 복구 단계는 [플랫폼 가이드](../../../docs/PLATFORMS.md)를 참고하세요.

### 소스에서 실행

Node.js 22.12 이상이 필요합니다.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

렌더러가 핫 리로드되는 개발 모드는 `npm run dev`입니다. 별도의 `aa-browser-dev` 사용자 데이터 디렉터리를 사용하므로 설치 버전과 함께 실행할 수 있습니다.

## 에이전트 연결

사전 조건: Aa Browser가 실행 중이고(포트와 토큰을 `~/.aabrowser/connection.json`에 기록합니다), 클라이언트가 stdio MCP를 지원하며, 둘 다 같은 머신에서 같은 사용자로 실행되어야 합니다.

- **원클릭**: 설정 → AI 클라이언트 연결 → 클라이언트 선택 → 쓰기. 이후 클라이언트를 재시작하세요.
- **수동**: `node install.mjs --print-config`를 실행하고 출력된 `command` / `args` / `env`를 클라이언트 설정에 붙여 넣습니다. 기존 설정은 `<file>.aa-backup-<timestamp>`로 백업되며, `aa-browser` 항목만 수정되고 쓰기는 멱등적입니다.

### 상태와 검증

| 툴바 상태 | 의미 |
| --- | --- |
| AI 연결 대기 | MCP 브리지가 아직 연결되지 않았습니다: 설정 누락, 클라이언트 미재시작, 또는 브라우저 미실행 |
| AI 첫 호출 대기 | 브리지가 연결되어 인증되었지만 아직 성공한 도구 호출이 없습니다 |
| AI 연결됨 ×N | 최소 한 번의 `browser_tabs` 목록 호출이 성공했습니다. N은 검증된 브리지 수입니다 |

설정이 작성되었다고 해서 **동작하는 연결**은 아닙니다. `node install.mjs --verify-only`로 검증하거나 에이전트가 실제로 `browser_tabs`를 호출하게 하세요.

## MCP 도구

다섯 그룹에 걸쳐 **43개 도구**: 탐색과 스냅샷(5), 상호작용(9), 읽기와 상태(20), 네트워크와 Mock(6), 진단과 탭(3). 클라이언트의 도구 이름에는 `mcp__aa-browser__` 접두사가 붙을 수 있습니다.

| 그룹 | 도구 |
| --- | --- |
| 탐색과 스냅샷 | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| 상호작용 | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| 읽기와 상태 | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| 네트워크와 Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| 진단과 탭 | `browser_performance`, `browser_resize`, `browser_tabs` |

공통 동작: 대부분의 도구는 결과와 함께 스냅샷을 반환합니다(`snapshot: false`로 생략). `browser_resize`와 `browser_downloads`를 제외한 모든 도구는 `tabId`를 받으며, 단일 호출은 180초 후 시간 초과되고, 승인은 최대 120초 대기하며, 네트워크 세부 정보는 기본적으로 마스킹됩니다. 전체 도구 설명서는 [site/tools.html](../../../site/tools.html)에 있습니다.

## 보안

- 에이전트 서비스는 `127.0.0.1`에서만 수신하고, 실행마다 무작위 토큰을 사용하며, 비로컬 오리진을 거부합니다. 포트와 토큰은 `~/.aabrowser/connection.json`에 있으며 정상 종료 시 삭제됩니다.
- 페이지 뷰는 preload 스크립트 없이 동작하며, 스냅샷과 동작 스크립트는 메인 프로세스가 주입합니다. 탐색은 `http:` / `https:`만 허용하고 `file:`, `data:`, `devtools:` 같은 프로토콜은 거부됩니다.
- 민감한 입력 필드는 사용자가 직접 입력해야 합니다: 에이전트가 제공한 텍스트는 기록되거나 읽히거나 반환되지 않습니다. "고위험 작업 확인"을 켜면 폼 제출, 입력 후 Enter, 마스킹되지 않은 네트워크 접근은 브라우저 내 승인을 기다립니다(120초 후 거부로 처리).
- 네트워크 세부 정보와 HAR 내보내기는 기본적으로 인증 헤더와 자격 증명류 파라미터를 마스킹합니다.
- **사이트 허용 목록**: 탐색에만 적용되며, 비워 두면 해제됩니다. 비워 두더라도 `file:`, `data:`, `devtools:` 같은 비웹 프로토콜은 허용되지 않습니다.
- **에이전트 연결은 항목 하나만 수정**: 쓰기 전에 클라이언트의 기존 설정을 백업하고, `aa-browser` 항목만 수정하며, token이나 비밀번호는 기록하지 않습니다. 설치 프로그램 다운로드 시 Release의 SHA-256 digest와 파일 헤더를 검증합니다.
- 격리 탭은 별도 세션 파티션을 사용합니다: 쿠키와 로그인을 공유하지 않고, 닫으면 삭제되며, 전역 기록, 최근 닫은 항목 목록, 세션 복원에서 제외됩니다.
- **경계**: 에이전트는 쿠키, 스토리지, 헤더, 응답 본문을 포함한 페이지 내용과 트래픽을 볼 수 있습니다. 이러한 제어는 완화 수단이며 범용 DLP가 아닙니다 — 신뢰할 수 없는 에이전트를 고민감 사이트에 연결하지 마세요.

취약점은 [SECURITY.md](../../../SECURITY.md)의 비공개 제보로 보고하고, 공개 이슈에는 절대 작성하지 마세요.

## 플랫폼과 제한

| 플랫폼 | 공식 빌드 | 비고 |
| --- | --- | --- |
| Windows 11 x64 | NSIS 설치 프로그램 | 적극적으로 유지 관리되며 CI와 로컬 회귀 테스트로 검증됩니다 |
| Windows 10 x64 | 동일한 설치 프로그램 | Windows 11 빌드를 공유합니다. 실기기 업그레이드 검수는 아직 남아 있습니다 |
| Linux x86_64 (Ubuntu 데스크톱) | AppImage | 시스템 Node.js 22.12+가 필요합니다. 다른 배포판은 실기기 검증이 필요합니다 |
| Windows ARM64 / macOS / Android / iOS | 없음 | 설치 프로그램이 설치를 가장하지 않고 명시적으로 거부합니다 |

알려진 제한:

- Windows에서 **코드 서명 없음**: SmartScreen이 경고하며 "추가 정보 → 실행"이 필요합니다.
- **Chrome 대체품이 아닙니다**: 북마크, 확장 프로그램, 계정/다중 기기 동기화가 없습니다. 범위는 "브라우저 코어 + 에이전트 접근"입니다.
- **Linux의 MCP 접속에는 시스템 Node.js 22.12+가 필요**합니다. Windows에서는 시스템 Node가 없으면 내장 런타임을 사용합니다.
- **세션 복원에는 범위가 있습니다**: 일반 웹 탭만, 최대 20개, 격리 탭, 내부 페이지, 비 HTTP(S) URL은 복원하지 않습니다.
- **사용자 데이터 디렉터리당 하나의 인스턴스**; 개발 빌드는 자체 디렉터리를 사용하므로 둘을 함께 실행할 수 있습니다.
- **설치와 업데이트는 GitHub Releases에 의존**합니다. AppImage 자체 업데이트에는 쓰기 가능한 디렉터리가 필요합니다.

## 문서

상세 문서는 현재 중국어로 작성되어 있습니다:

| 문서 | 내용 |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | 플랫폼과 클라이언트 매트릭스, 설치 프로그램 플래그, 수동 단계, 문제 해결 |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | 릴리스 매트릭스, Linux 의존성, 제거와 데이터 복구 |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | 업데이트 확인, 다운로드, 재시작 설치, SHA-512와 롤백 |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | DeepSeek Harness 플러그인 설치와 검증 |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | 릴리스 증거, 회귀 기록, 유지 관리 경계 |
| [릴리스 노트](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | 버전별 변경 이력 |
| [site/tools.html](../../../site/tools.html) | 42개 도구 전체 설명서(로컬에서 열면 되고 배포는 필요 없음) |

## 기여와 라이선스

버그 보고, 기능 논의, 문서 수정, PR을 환영합니다 — 먼저 [CONTRIBUTING.md](../../../CONTRIBUTING.md)를 읽어 주세요. MCP 도구를 추가할 때는 `src/main/tools.ts`, `cli/mcp.mjs`, 이 README의 도구 표, `site/tools.html`을 함께 갱신하세요. `npm run check`가 앞의 세 가지가 동기화되었는지 검증합니다.

MIT licensed — 자세한 내용은 [LICENSE](../../../LICENSE) © Aa Browser contributors.

이 번역은 중국어 원문보다 늦을 수 있습니다. 이 README의 번역은 [README.md](../../../README.md)(简体中文)와 `docs/i18n/readmes/README.<language>.md`에서 관리되며, 전체 목록은 `../readme-languages.json`을 참고하세요.