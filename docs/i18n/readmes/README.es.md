# Aa Browser

**El navegador de escritorio nativo para agentes: código abierto, licencia MIT.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <b>Español</b> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Linux%20x86_64-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> Un navegador que usas como un humano y que un agente conduce como un ingeniero.

<p align="center">
  <img src="../../../docs/media/aa-browser-demo.webp" alt="Aa Browser: un navegador creado para agentes" width="720" />
</p>

Esta es una **traducción resumida**. La documentación completa y autoritativa está escrita en chino: [README.md](../../../README.md) y [`docs/`](../../).

## Qué es

Los navegadores convencionales están diseñados para ojos humanos que miran píxeles; un agente de IA necesita **datos de página estructurados**. Aa Browser es un navegador de escritorio Chromium completo (Electron) que cualquiera puede usar con normalidad —pestañas, barra de direcciones, historial, descargas, búsqueda en página, sesiones persistentes— y expone la página a cualquier agente [MCP](https://modelcontextprotocol.io) a través de un puente stdio local: leer un **snapshot de accesibilidad estructurado** y luego hacer clic, escribir, seleccionar, arrastrar, desplazar, extraer y capturar tráfico. Sin capturas de pantalla, sin coordenadas adivinadas.

Los snapshots son **incrementales** por defecto: una página sin cambios cuesta una línea, los cambios pequeños devuelven solo el diff y los ids `ref` se mantienen estables entre snapshots. El puente escucha en `127.0.0.1` con un token por inicio guardado en `~/.aabrowser/connection.json`.

## Aspectos destacados

- 🖥️ **Un navegador real**: carcasa Electron/Chromium con pestañas, barra de direcciones, atrás/adelante, búsqueda en página, panel de descargas y sesiones persistentes.
- 🧠 **Snapshots estructurados**: la página se convierte en un árbol de accesibilidad estilo YAML donde cada elemento interactivo lleva un id `ref` (`- button "Sign in" [ref=e5]`), alineado con el formato de Playwright MCP.
- 💸 **Los snapshots incrementales ahorran tokens**: sin cambios → una línea; cambios pequeños → solo los bloques modificados; una navegación o cambios grandes vuelven a un snapshot completo. En tareas largas se ahorran normalmente 60%+ de contexto.
- 🎯 **Ruta de entrada real**: los clics usan eventos de entrada de confianza (`isTrusted=true`), la escritura usa la tubería `insertText` con respaldo para campos controlados por React, y los eventos sintéticos cubren el caso raro en que se pierde un evento real.
- 🤖 **MCP nativo**: un puente MCP stdio estándar; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code y WorkBuddy pueden manejarlo.
- 📊 **Diagnóstico**: `browser_performance` devuelve tiempos de navegación, primer pintado, tamaños de recursos y recursos lentos, heap de JS y tamaño del DOM sin abrir DevTools.
- 🌐 **Interfaz bilingüe**: sigue el idioma del sistema o del navegador, o fija chino simplificado / English en los ajustes.
- 🔒 **Seguridad local primero**: WebSocket solo en loopback, token aleatorio en cada inicio, lista de sitios permitidos, pestañas aisladas, datos de red redactados y aprobación en el navegador para operaciones de alto riesgo.
- 📦 **Versiones verificables**: Windows NSIS y Linux AppImage se publican en la misma versión con `SHA256SUMS.txt`, atestaciones de publicación inmutables de GitHub y un `sbom.cdx.json` de CycloneDX.

## Ejemplo de snapshot

Llamar a `browser_snapshot` en la página de inicio de Bing devuelve (salida real, conservada tal cual):

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

Después el agente actúa sobre un `ref`:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

Tras una acción obtienes un **snapshot incremental**: solo los bloques modificados, más los ids `ref` que se añadieron o invalidaron. `browser_snapshot { full: true }` fuerza el árbol completo.

## Instalación

### Un solo prompt (recomendado)

Envía el prompt de [PROMPT.md](../../../PROMPT.md) a cualquier IA capaz de ejecutar comandos locales. Si Aa Browser aún no está instalado, descarga el instalador oficial, verifica el SHA-256, instala, lo lanza, escribe la configuración MCP y llama de verdad a `browser_tabs` para verificar. Si Aa Browser ya se está ejecutando, solo escribe la configuración y verifica.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

El instalador nunca pregunta de forma interactiva. `--clients zcode,cursor` limita qué clientes se configuran, `--dir <dir>` cambia el directorio de instalación, `--no-launch` omite el lanzamiento y `--sha256 <hex>` fija el hash esperado del instalador. Cualquier otro cliente MCP puede usar la salida de `--print-config`.

### Windows

Descarga `aa-browser-setup-<version>.exe` desde [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) y ejecútalo. El instalador **no está firmado**: cuando aparezca SmartScreen, elige «Más información → Ejecutar de todas formas». Cada versión incluye además `SHA256SUMS.txt`, `sbom.cdx.json` y una atestación de publicación inmutable para que puedas verificar los archivos tú mismo.

### Linux AppImage

Descarga `aa-browser-<version>-linux-x86_64.AppImage`, dale permiso de ejecución y arráncalo desde la sesión de escritorio actual. Se requieren GTK 3, NSS, GBM, bibliotecas de audio y un sandbox de Chromium funcional; el acceso MCP necesita Node.js 22.12 o superior del sistema.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

Sin FUSE, arráncalo con `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. Consulta la [guía de plataformas](../../../docs/PLATFORMS.md) para el estado por distribución y los pasos de recuperación.

### Desde el código fuente

Se requiere Node.js 22.12 o superior.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

El modo de desarrollo con recarga en caliente del renderer es `npm run dev`; usa un directorio de datos de usuario separado, `aa-browser-dev`, así que puede convivir con la versión instalada.

## Conecta tu agente

Requisitos previos: Aa Browser está en ejecución (escribe el puerto y el token en `~/.aabrowser/connection.json`), el cliente admite MCP stdio, y ambos se ejecutan con el mismo usuario en la misma máquina.

- **Un clic**: Ajustes → Conectar cliente de IA → marca los clientes → escribir. Reinicia el cliente después.
- **Manual**: ejecuta `node install.mjs --print-config` y pega el `command` / `args` / `env` impresos en la configuración del cliente. Las configuraciones existentes se respaldan en `<file>.aa-backup-<timestamp>`; solo se modifica la entrada `aa-browser` y las escrituras son idempotentes.

### Estado y verificación

| Estado en la barra de herramientas | Significado |
| --- | --- |
| Esperando conexión de IA | Ningún puente MCP se ha conectado: falta la configuración, el cliente no se reinició o el navegador no está en ejecución |
| Esperando la primera llamada de IA | El puente está conectado y autenticado, pero todavía no ha funcionado ninguna llamada a herramienta |
| IA conectada ×N | Al menos una llamada de listado de `browser_tabs` tuvo éxito; N es el número de puentes verificados |

Una configuración escrita **no** es una conexión funcional. Verifícala con `node install.mjs --verify-only`, o deja que el agente llame realmente a `browser_tabs`.

## Herramientas MCP

**47 herramientas** en cinco grupos: navegación y snapshot (5), interacción (9), lectura y estado (20), red y Mock (6), diagnóstico y pestañas (7). Los nombres de herramienta en el cliente pueden llevar el prefijo `mcp__aa-browser__`.

| Grupo | Herramientas |
| --- | --- |
| Navegación y snapshot | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| Interacción | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| Lectura y estado | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| Red y Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| Diagnóstico y pestañas | `browser_performance`, `browser_resize`, `browser_tabs`, `browser_window`, `browser_tasks`, `browser_extensions`, `browser_evidence` |

Comportamiento común: la mayoría de las herramientas devuelven un snapshot junto con su resultado (`snapshot: false` lo omite), todas las herramientas excepto `browser_resize` y `browser_downloads` aceptan un `tabId`, una llamada individual expira a los 180 segundos, la aprobación espera hasta 120 segundos y los detalles de red se redactan por defecto.

## Seguridad

- El servicio del agente solo escucha en `127.0.0.1`, usa un token aleatorio en cada inicio y rechaza orígenes no locales; el puerto y el token viven en `~/.aabrowser/connection.json` y se eliminan al salir de forma limpia.
- Las vistas de página se ejecutan sin script de preload; los snapshots y los scripts de acción los inyecta el proceso principal. La navegación solo permite `http:` / `https:` — se rechazan `file:`, `data:`, `devtools:` y protocolos similares.
- Los campos de entrada sensibles debe rellenarlos el usuario: el texto que aporta el agente nunca se escribe, se lee ni se devuelve. Con «confirmar operaciones de alto riesgo» activado, los envíos de formulario, el Enter tras escribir y el acceso a red sin redactar esperan aprobación en el navegador (120 segundos; después se consideran denegados).
- Los detalles de red y las exportaciones HAR redactan por defecto las cabeceras de autenticación y los parámetros con aspecto de credenciales.
- **Lista de sitios permitidos**: solo se aplica a la navegación; dejarla vacía la desactiva, y aunque esté vacía, `file:`, `data:`, `devtools:` y otros protocolos que no son web siguen bloqueados.
- **Conectar un agente toca una sola entrada**: primero se hace copia de seguridad de las configuraciones de cliente existentes, solo se modifica la entrada `aa-browser`, nunca se escribe ningún token ni contraseña, y la descarga del instalador verifica el digest SHA-256 y la cabecera del archivo de la release.
- Las pestañas aisladas usan una partición de sesión separada: sin cookies ni sesiones compartidas, se limpian al cerrarse y quedan excluidas del historial global, de la lista de cerradas recientes y de la restauración de sesión.
- **Límite**: un agente puede ver el contenido de la página y el tráfico, incluidas cookies, almacenamiento, cabeceras y cuerpos de respuesta. Estos controles son mitigaciones, no un DLP general; no apuntes un agente no confiable a sitios de alta sensibilidad.

Informa de vulnerabilidades mediante el reporte privado de [SECURITY.md](../../../SECURITY.md), nunca en un issue público.

## Plataformas y límites

| Plataforma | Compilación oficial | Notas |
| --- | --- | --- |
| Windows 11 x64 | Instalador NSIS | Mantenido activamente, cubierto por CI y regresiones locales |
| Windows 10 x64 | Mismo instalador | Comparte la compilación de Windows 11; la aceptación de actualización en equipo real sigue pendiente |
| Linux x86_64 (Ubuntu de escritorio) | AppImage | Necesita Node.js 22.12+ del sistema; otras distribuciones requieren verificación en equipo real |
| Windows ARM64 / macOS / Android / iOS | Ninguna | El instalador se niega de forma explícita en lugar de fingir que instala |

Limitaciones conocidas:

- **Sin firma de código** en Windows: SmartScreen avisa y hay que elegir «Más información → Ejecutar de todas formas».
- **No es un sustituto de Chrome**: sin marcadores, extensiones ni sincronización de cuenta/multidispositivo. El alcance es «núcleo de navegador + acceso de agentes».
- **El acceso MCP en Linux requiere Node.js 22.12+ del sistema**; en Windows se usa el runtime incluido cuando no hay Node del sistema.
- **La restauración de sesión tiene alcance**: solo pestañas web normales, como máximo 20 entradas, nunca pestañas aisladas, páginas internas ni URL no HTTP(S).
- **Una instancia por directorio de datos de usuario**; la compilación de desarrollo usa su propio directorio para que ambas puedan convivir.
- **Las instalaciones y actualizaciones dependen de GitHub Releases**; la autoactualización de AppImage necesita un directorio escribible.

## Documentación

La documentación detallada está actualmente en chino:

| Documento | Contenido |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | Matriz de plataformas y clientes, opciones del instalador, pasos manuales, resolución de problemas |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | Matriz de versiones, dependencias de Linux, desinstalación y recuperación de datos |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | Comprobación de actualizaciones, descarga, reinicio para instalar, SHA-512 y rollback |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | Instalación y verificación del plugin de DeepSeek Harness |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | Evidencia de versiones, registros de regresión y límites de mantenimiento |
| [release notes](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | Historial de cambios por versión |

## Contribuir y licencia

Se agradecen informes de errores, debates de funcionalidades, correcciones de documentación y PR. Lee antes [CONTRIBUTING.md](../../../CONTRIBUTING.md). Al añadir una herramienta MCP, actualiza a la vez `src/main/tools.ts`, `cli/mcp.mjs`, la tabla de herramientas de este README y `src/shared/tool-defs.mjs`; `npm run check` verifica que los tres primeros sigan sincronizados.

MIT licensed — consulta [LICENSE](../../../LICENSE) © colaboradores de Aa Browser.

Esta traducción puede ir por detrás del original en chino. Las traducciones de este README se mantienen en [README.md](../../../README.md) (简体中文), además de `docs/i18n/readmes/README.<language>.md`; consulta `../readme-languages.json` para la lista completa.
