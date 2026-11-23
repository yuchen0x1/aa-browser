# Aa Browser

**Der agent-native Desktop-Browser — Open Source, MIT-lizenziert.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <b>Deutsch</b> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> Ein Browser, den du wie ein Mensch benutzt und den ein Agent wie ein Ingenieur steuert.

<p align="center">
  <img src="../../../docs/media/aa-browser-demo.webp" alt="Aa Browser — a browser built for agents" width="720" />
</p>

Dies ist eine **gekürzte Übersetzung**. Die vollständige, maßgebliche Dokumentation ist auf Chinesisch verfasst: [README.md](../../../README.md) und [`docs/`](../../).

## Was es ist

Herkömmliche Browser sind für menschliche Augen und Pixel ausgelegt; ein KI-Agent braucht **strukturierte Seitendaten**. Aa Browser ist ein vollständiger Chromium-Desktop-Browser (Electron), den jeder normal benutzen kann — Tabs, Omnibox, Verlauf, Downloads, Seitensuche, dauerhafte Anmeldungen — und er stellt die Seite jedem [MCP](https://modelcontextprotocol.io)-Agenten über eine lokale stdio-Brücke bereit: einen **strukturierten Accessibility-Snapshot** lesen und dann klicken, tippen, auswählen, ziehen, scrollen, extrahieren und den Datenverkehr mitschneiden. Keine Screenshots, keine geratenen Koordinaten.

Snapshots sind standardmäßig **inkrementell**: Eine unveränderte Seite kostet eine Zeile, kleine Änderungen liefern nur das Diff, und `ref`-IDs bleiben über Snapshots hinweg stabil. Die Brücke lauscht auf `127.0.0.1` mit einem Token pro Start, das in `~/.aabrowser/connection.json` liegt.

## Highlights

- 🖥️ **Ein echter Browser**: Electron/Chromium-Hülle mit Tabs, Omnibox, Vor/Zurück, Seitensuche, Download-Panel und dauerhaften Anmeldungen.
- 🧠 **Strukturierte Snapshots**: Die Seite wird zu einem Accessibility-Baum im YAML-Stil, in dem jedes interaktive Element eine `ref`-ID trägt (`- button "Sign in" [ref=e5]`), ausgerichtet am Format von Playwright MCP.
- 💸 **Inkrementelle Snapshots sparen Tokens**: keine Änderung → eine Zeile; kleine Änderung → nur die geänderten Blöcke; Navigation oder große Änderungen fallen auf einen vollständigen Snapshot zurück. Lange Aufgaben sparen typischerweise 60%+ Kontext.
- 🎯 **Echter Eingabepfad**: Klicks nutzen vertrauenswürdige Eingabeereignisse (`isTrusted=true`), Tippen nutzt die `insertText`-Pipeline mit einem Fallback für React-kontrollierte Eingaben, und synthetische Ereignisse decken den seltenen Fall ab, dass ein echtes Ereignis verloren geht.
- 🤖 **MCP-nativ**: eine standardmäßige stdio-MCP-Brücke; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code und WorkBuddy können sie steuern.
- 📊 **Diagnose**: `browser_performance` liefert Navigationszeiten, First Paint, Ressourcengrößen und langsame Ressourcen, JS-Heap und DOM-Größe, ohne DevTools zu öffnen.
- 🌐 **Zweisprachige Oberfläche**: folgt der System- oder Browsersprache oder legt in den Einstellungen vereinfachtes Chinesisch / Englisch fest.
- 🔒 **Sicherheit mit Local-First-Ansatz**: WebSocket nur auf Loopback, zufälliges Token pro Start, Site-Allowlist, isolierte Tabs, redigierte Netzwerkdaten und Freigabe im Browser für riskante Vorgänge.
- 📦 **Verifizierbare Releases**: Windows NSIS und Linux AppImage erscheinen in derselben Version mit `SHA256SUMS.txt`, unveränderlichen GitHub-Release-Attestierungen und einem CycloneDX-`sbom.cdx.json`.

## Snapshot-Beispiel

Der Aufruf von `browser_snapshot` auf der Bing-Startseite liefert (echte Ausgabe, wortwörtlich übernommen):

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

Der Agent arbeitet dann mit einer `ref`:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

Nach einer Aktion erhältst du einen **inkrementellen Snapshot** — nur die geänderten Blöcke, plus welche `ref`-IDs hinzugefügt oder ungültig wurden. `browser_snapshot { full: true }` erzwingt den vollständigen Baum.

## Installation

### Ein Prompt (empfohlen)

Sende den Prompt aus [PROMPT.md](../../../PROMPT.md) an jede KI, die lokale Befehle ausführen kann. Ist Aa Browser noch nicht installiert, lädt sie das offizielle Installationsprogramm herunter, prüft die SHA-256-Summe, installiert, startet, schreibt die MCP-Konfiguration und ruft tatsächlich `browser_tabs` auf, um zu verifizieren. Läuft Aa Browser bereits, schreibt sie nur die Konfiguration und verifiziert.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

Das Installationsprogramm fragt nie interaktiv nach. `--clients zcode,cursor` begrenzt, welche Clients konfiguriert werden, `--dir <dir>` überschreibt das Installationsverzeichnis, `--no-launch` überspringt den Start, und `--sha256 <hex>` legt den erwarteten Hash des Installationsprogramms fest. Jeder andere MCP-Client kann die Ausgabe von `--print-config` verwenden.

### Windows

Lade `aa-browser-setup-<version>.exe` von [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) herunter und führe sie aus. Das Installationsprogramm ist **nicht code-signiert**: Wenn SmartScreen erscheint, wähle „Weitere Informationen → Trotzdem ausführen". Jede Version liefert außerdem `SHA256SUMS.txt`, `sbom.cdx.json` und eine unveränderliche Release-Attestierung mit, damit du die Dateien selbst prüfen kannst.

### Linux AppImage

Lade `aa-browser-<version>-linux-x86_64.AppImage` herunter, mache sie ausführbar und starte sie aus der aktuellen Desktop-Sitzung. Erforderlich sind GTK 3, NSS, GBM, Audio-Bibliotheken und eine funktionierende Chromium-Sandbox; der MCP-Zugriff benötigt System-Node.js 22.12 oder neuer.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

Ohne FUSE startest du sie mit `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. Distributionsspezifischen Status und Wiederherstellungsschritte findest du im [Plattform-Leitfaden](../../../docs/PLATFORMS.md).

### Aus dem Quellcode

Node.js 22.12 oder neuer ist erforderlich.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

Der Entwicklungsmodus mit hot-reloadendem Renderer ist `npm run dev`; er verwendet ein eigenes Benutzerdatenverzeichnis `aa-browser-dev` und kann daher neben dem installierten Build laufen.

## Verbinde deinen Agenten

Voraussetzungen: Aa Browser läuft (er schreibt Port und Token nach `~/.aabrowser/connection.json`), der Client unterstützt stdio MCP, und beide laufen als derselbe Benutzer auf derselben Maschine.

- **Ein Klick**: Einstellungen → KI-Client verbinden → Clients ankreuzen → schreiben. Danach den Client neu starten.
- **Manuell**: führe `node install.mjs --print-config` aus und füge die ausgegebenen `command` / `args` / `env` in die Client-Konfiguration ein. Bestehende Konfigurationen werden nach `<Datei>.aa-backup-<Zeitstempel>` gesichert; nur der Eintrag `aa-browser` wird geändert, und die Schreibvorgänge sind idempotent.

### Status und Verifikation

| Status in der Symbolleiste | Bedeutung |
| --- | --- |
| Warten auf KI-Verbindung | Keine MCP-Brücke hat sich verbunden: Konfiguration fehlt, Client nicht neu gestartet oder Browser läuft nicht |
| Warten auf ersten KI-Aufruf | Die Brücke ist verbunden und authentifiziert, aber noch kein Tool-Aufruf war erfolgreich |
| KI verbunden ×N | Mindestens ein `browser_tabs`-Listenaufruf war erfolgreich; N ist die Anzahl verifizierter Brücken |

Eine geschriebene Konfiguration ist **keine** funktionierende Verbindung. Verifiziere mit `node install.mjs --verify-only`, oder lass den Agenten tatsächlich `browser_tabs` aufrufen.

## MCP-Tools

**44 Tools** in fünf Gruppen: Navigation & Snapshot (5), Interaktion (9), Lesen & Status (20), Netzwerk & Mock (6), Diagnose & Tabs (4). Tool-Namen im Client können das Präfix `mcp__aa-browser__` tragen.

| Gruppe | Tools |
| --- | --- |
| Navigation & Snapshot | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| Interaktion | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| Lesen & Status | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| Netzwerk & Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| Diagnose & Tabs | `browser_performance`, `browser_resize`, `browser_tabs` |

Gemeinsames Verhalten: Die meisten Tools geben zusammen mit ihrem Ergebnis einen Snapshot zurück (`snapshot: false` überspringt ihn), jedes Tool außer `browser_resize` und `browser_downloads` akzeptiert eine `tabId`, ein einzelner Aufruf läuft nach 180 Sekunden in einen Timeout, eine Freigabe wartet bis zu 120 Sekunden, und Netzwerkdetails werden standardmäßig redigiert.

## Sicherheit

- Der Agent-Dienst lauscht nur auf `127.0.0.1`, verwendet ein zufälliges Token pro Start und weist nicht-lokale Ursprünge zurück; Port und Token liegen in `~/.aabrowser/connection.json` und werden beim sauberen Beenden gelöscht.
- Seitenansichten laufen ohne Preload-Skript; Snapshots und Aktionsskripte werden vom Hauptprozess injiziert. Die Navigation erlaubt nur `http:` / `https:` — `file:`, `data:`, `devtools:` und ähnliche Protokolle werden abgelehnt.
- Sensible Eingabefelder muss der Benutzer selbst ausfüllen: Vom Agenten gelieferter Text wird nie geschrieben, gelesen oder zurückgegeben. Mit aktivierter Option „Riskante Vorgänge bestätigen" warten Formularübermittlungen, Enter nach dem Tippen und unredigierter Netzwerkzugriff im Browser auf eine Freigabe (120 Sekunden, danach gilt sie als abgelehnt).
- Netzwerkdetails und HAR-Exporte redigieren standardmäßig Authentifizierungs-Header und Parameter, die nach Zugangsdaten aussehen.
- **Site-Allowlist**: gilt nur für die Navigation; bleibt sie leer, ist sie deaktiviert, und selbst wenn sie leer ist, bleiben `file:`, `data:`, `devtools:` und andere Nicht-Web-Protokolle blockiert.
- **Die Agent-Anbindung ändert nur einen Eintrag**: vorhandene Client-Konfigurationen werden zuerst gesichert, nur der Eintrag `aa-browser` wird geändert, es werden niemals Token oder Passwörter geschrieben, und Installer-Downloads prüfen das SHA-256-Digest des Releases sowie den Dateiheader.
- Isolierte Tabs nutzen eine eigene Session-Partition: keine gemeinsamen Cookies oder Anmeldungen, beim Schließen gelöscht und vom globalen Verlauf, der Liste zuletzt geschlossener Tabs und der Sitzungswiederherstellung ausgeschlossen.
- **Grenze**: Ein Agent kann Seiteninhalte und Datenverkehr sehen, einschließlich Cookies, Storage, Headern und Antwortkörpern. Diese Kontrollen sind Minderungsmaßnahmen, kein allgemeines DLP — richte keinen nicht vertrauenswürdigen Agenten auf hochsensible Websites.

Melde Schwachstellen über die private Meldung in [SECURITY.md](../../../SECURITY.md), niemals in einem öffentlichen Issue.

## Plattformen und Grenzen

| Plattform | Offizieller Build | Hinweise |
| --- | --- | --- |
| Windows 11 x64 | NSIS-Installationsprogramm | Aktiv gepflegt, durch CI und lokale Regressionen abgedeckt |
| Windows 10 x64 | Dasselbe Installationsprogramm | Teilt den Build von Windows 11; die Upgrade-Abnahme auf echter Hardware steht noch aus |
| Linux x86_64 (Ubuntu Desktop) | AppImage | Benötigt System-Node.js 22.12+; andere Distributionen müssen auf echter Hardware verifiziert werden |
| Windows ARM64 / macOS / Android / iOS | Keiner | Das Installationsprogramm lehnt ausdrücklich ab, statt eine Installation vorzutäuschen |

Bekannte Einschränkungen:

- **Keine Code-Signierung** unter Windows: SmartScreen warnt und verlangt „Weitere Informationen → Trotzdem ausführen".
- **Kein Chrome-Ersatz**: keine Lesezeichen, Erweiterungen oder Konto-/Gerätesynchronisierung. Der Umfang ist „Browser-Kern + Agent-Zugriff".
- **MCP-Zugriff unter Linux erfordert System-Node.js 22.12+**; unter Windows wird die mitgelieferte Laufzeit verwendet, wenn kein System-Node gefunden wird.
- **Die Sitzungswiederherstellung ist begrenzt**: nur normale Web-Tabs, höchstens 20 Einträge, niemals isolierte Tabs, interne Seiten oder Nicht-HTTP(S)-URLs.
- **Eine Instanz pro Benutzerdatenverzeichnis**; der Dev-Build nutzt sein eigenes Verzeichnis, sodass beide laufen können.
- **Installation und Updates hängen von GitHub Releases ab**; die Selbstaktualisierung des AppImage braucht ein beschreibbares Verzeichnis.

## Dokumentation

Die ausführliche Dokumentation ist derzeit auf Chinesisch verfügbar:

| Dokument | Inhalt |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | Plattform- und Client-Matrix, Installer-Flags, manuelle Schritte, Fehlerbehebung |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | Release-Matrix, Linux-Abhängigkeiten, Deinstallation und Datenwiederherstellung |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | Update-Prüfung, Download, Neustart zum Installieren, SHA-512 und Rollback |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | Installation und Verifikation des DeepSeek-Harness-Plugins |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | Release-Nachweise, Regressionsprotokolle und Wartungsgrenzen |
| [Versionshinweise](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | Änderungsverlauf je Version |

## Mitwirken und Lizenz

Fehlerberichte, Funktionsdiskussionen, Dokumentationskorrekturen und PRs sind willkommen — bitte lies zuerst [CONTRIBUTING.md](../../../CONTRIBUTING.md). Wenn du ein MCP-Tool hinzufügst, aktualisiere `src/main/tools.ts`, `cli/mcp.mjs`, die Tool-Tabelle in dieser README und `src/shared/tool-defs.mjs` gemeinsam; `npm run check` prüft, dass die ersten drei synchron bleiben.

MIT licensed — siehe [LICENSE](../../../LICENSE) © Aa Browser contributors.

Diese Übersetzung kann hinter dem chinesischen Original zurückbleiben. Übersetzungen dieser README werden in [README.md](../../../README.md) (简体中文) sowie `README.<Sprache>.md` gepflegt; die vollständige Liste findest du in `../readme-languages.json`.
