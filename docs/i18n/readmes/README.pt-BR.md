# Aa Browser

**O navegador desktop nativo para agentes — código aberto, licença MIT.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <b>Português (BR)</b> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> Um navegador que você usa como um humano e que um agente conduz como um engenheiro.

<p align="center">
  <img src="../../../docs/media/aa-browser-demo.webp" alt="Aa Browser — um navegador feito para agentes" width="720" />
</p>

Esta é uma **tradução condensada**. A documentação completa e oficial está escrita em chinês: [README.md](../../../README.md) e [`docs/`](../../).

## O que é

Navegadores convencionais são projetados para olhos humanos olhando pixels; um agente de IA precisa de **dados de página estruturados**. O Aa Browser é um navegador desktop Chromium completo (Electron) que qualquer pessoa pode usar normalmente — abas, barra de endereços, histórico, downloads, localizar na página, logins persistentes — e expõe a página a qualquer agente [MCP](https://modelcontextprotocol.io) por meio de uma ponte stdio local: ler um **snapshot de acessibilidade estruturado** e então clicar, digitar, selecionar, arrastar, rolar, extrair e capturar tráfego. Sem capturas de tela, sem coordenadas adivinhadas.

Os snapshots são **incrementais** por padrão: uma página sem mudanças custa uma linha, mudanças pequenas retornam apenas o diff e os ids `ref` permanecem estáveis entre snapshots. A ponte escuta em `127.0.0.1` com um token por execução salvo em `~/.aabrowser/connection.json`.

## Destaques

- 🖥️ **Um navegador de verdade**: shell Electron/Chromium com abas, barra de endereços, voltar/avançar, localizar na página, painel de downloads e logins persistentes.
- 🧠 **Snapshots estruturados**: a página vira uma árvore de acessibilidade no estilo YAML em que cada elemento interativo carrega um id `ref` (`- button "Sign in" [ref=e5]`), alinhado ao formato do Playwright MCP.
- 💸 **Snapshots incrementais economizam tokens**: sem mudança → uma linha; mudança pequena → apenas os blocos alterados; navegação ou mudanças grandes voltam a um snapshot completo. Tarefas longas normalmente economizam 60%+ de contexto.
- 🎯 **Caminho de entrada real**: cliques usam eventos de entrada confiáveis (`isTrusted=true`), a digitação usa o pipeline `insertText` com fallback para inputs controlados pelo React, e eventos sintéticos cobrem o caso raro em que um evento real se perde.
- 🤖 **MCP nativo**: uma ponte MCP stdio padrão; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code e WorkBuddy podem conduzi-lo.
- 📊 **Diagnóstico**: `browser_performance` retorna tempos de navegação, primeira pintura, tamanhos de recursos e recursos lentos, heap de JS e tamanho do DOM sem abrir o DevTools.
- 🌐 **Interface bilíngue**: segue o idioma do sistema ou do navegador, ou fixa chinês simplificado / English nas configurações.
- 🔒 **Segurança local em primeiro lugar**: WebSocket apenas em loopback, token aleatório por execução, lista de sites permitidos, abas isoladas, dados de rede mascarados e aprovação no navegador para operações de alto risco.
- 📦 **Versões verificáveis**: Windows NSIS e Linux AppImage são lançados na mesma versão com `SHA256SUMS.txt`, atestações imutáveis de release do GitHub e um `sbom.cdx.json` CycloneDX.

## Exemplo de snapshot

Chamar `browser_snapshot` na página inicial do Bing retorna (saída real, mantida literalmente):

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

Em seguida o agente age sobre um `ref`:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

Depois de uma ação você recebe um **snapshot incremental** — apenas os blocos alterados, mais quais ids `ref` foram adicionados ou invalidados. `browser_snapshot { full: true }` força a árvore completa.

## Instalação

### Um único prompt (recomendado)

Envie o prompt de [PROMPT.md](../../../PROMPT.md) para qualquer IA capaz de executar comandos locais. Se o Aa Browser ainda não estiver instalado, ela baixa o instalador oficial, verifica o SHA-256, instala, inicia, grava a configuração MCP e chama de fato `browser_tabs` para verificar. Se o Aa Browser já estiver em execução, ela apenas grava a configuração e verifica.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

O instalador nunca pergunta de forma interativa. `--clients zcode,cursor` limita quais clientes são configurados, `--dir <dir>` substitui o diretório de instalação, `--no-launch` pula a inicialização e `--sha256 <hex>` fixa o hash esperado do instalador. Qualquer outro cliente MCP pode usar a saída de `--print-config`.

### Windows

Baixe `aa-browser-setup-<version>.exe` em [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) e execute. O instalador **não tem assinatura de código**: quando o SmartScreen aparecer, escolha «Mais informações → Executar assim mesmo». Cada versão também inclui `SHA256SUMS.txt`, `sbom.cdx.json` e uma atestação imutável de release para você verificar os arquivos por conta própria.

### Linux AppImage

Baixe `aa-browser-<version>-linux-x86_64.AppImage`, dê permissão de execução e inicie-o a partir da sessão de desktop atual. São necessários GTK 3, NSS, GBM, bibliotecas de áudio e um sandbox do Chromium funcional; o acesso MCP exige Node.js 22.12 ou superior do sistema.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

Sem FUSE, inicie com `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. Veja o [guia de plataformas](../../../docs/PLATFORMS.md) para o status por distribuição e os passos de recuperação.

### A partir do código-fonte

É necessário Node.js 22.12 ou superior.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

O modo de desenvolvimento com renderer em hot reload é `npm run dev`; ele usa um diretório de dados de usuário separado, `aa-browser-dev`, então pode rodar junto com a versão instalada.

## Conecte seu agente

Pré-requisitos: o Aa Browser está em execução (ele grava a porta e o token em `~/.aabrowser/connection.json`), o cliente suporta MCP stdio, e ambos rodam com o mesmo usuário na mesma máquina.

- **Um clique**: Configurações → Conectar cliente de IA → marque os clientes → gravar. Reinicie o cliente depois.
- **Manual**: execute `node install.mjs --print-config` e cole o `command` / `args` / `env` impressos na configuração do cliente. Configurações existentes são copiadas para `<file>.aa-backup-<timestamp>`; apenas a entrada `aa-browser` é modificada e as gravações são idempotentes.

### Status e verificação

| Estado na barra de ferramentas | Significado |
| --- | --- |
| Aguardando conexão da IA | Nenhuma ponte MCP se conectou: configuração ausente, cliente não reiniciado ou navegador não está em execução |
| Aguardando a primeira chamada da IA | A ponte está conectada e autenticada, mas nenhuma chamada de ferramenta teve sucesso ainda |
| IA conectada ×N | Pelo menos uma chamada de listagem do `browser_tabs` teve sucesso; N é o número de pontes verificadas |

Uma configuração gravada **não** é uma conexão funcionando. Verifique com `node install.mjs --verify-only`, ou deixe o agente chamar de fato `browser_tabs`.

## Ferramentas MCP

**44 ferramentas** em cinco grupos: navegação e snapshot (5), interação (9), leitura e estado (20), rede e Mock (6), diagnóstico e abas (4). Os nomes de ferramenta no cliente podem trazer o prefixo `mcp__aa-browser__`.

| Grupo | Ferramentas |
| --- | --- |
| Navegação e snapshot | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| Interação | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| Leitura e estado | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| Rede e Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| Diagnóstico e abas | `browser_performance`, `browser_resize`, `browser_tabs` |

Comportamento comum: a maioria das ferramentas retorna um snapshot junto com o resultado (`snapshot: false` o dispensa), todas as ferramentas exceto `browser_resize` e `browser_downloads` aceitam um `tabId`, uma chamada individual expira após 180 segundos, a aprovação espera até 120 segundos e os detalhes de rede são mascarados por padrão.

## Segurança

- O serviço do agente escuta apenas em `127.0.0.1`, usa um token aleatório por execução e rejeita origens não locais; a porta e o token ficam em `~/.aabrowser/connection.json` e são apagados na saída limpa.
- As visualizações de página rodam sem script de preload; snapshots e scripts de ação são injetados pelo processo principal. A navegação permite apenas `http:` / `https:` — `file:`, `data:`, `devtools:` e protocolos semelhantes são rejeitados.
- Campos de entrada sensíveis devem ser preenchidos pelo usuário: texto fornecido pelo agente nunca é gravado, lido ou retornado. Com «confirmar operações de alto risco» ativado, envios de formulário, Enter após digitar e acesso à rede sem máscara aguardam aprovação no navegador (120 segundos; depois disso, tratados como negados).
- Detalhes de rede e exportações HAR mascaram por padrão cabeçalhos de autenticação e parâmetros com aparência de credencial.
- **Lista de sites permitidos**: aplica-se apenas à navegação; deixá-la vazia a desativa, e mesmo vazia, `file:`, `data:`, `devtools:` e outros protocolos que não são web continuam bloqueados.
- **Conectar um agente altera apenas uma entrada**: as configurações existentes do cliente são copiadas primeiro, apenas a entrada `aa-browser` é modificada, nenhum token ou senha é gravado, e o download do instalador verifica o digest SHA-256 e o cabeçalho do arquivo do release.
- Abas isoladas usam uma partição de sessão separada: sem cookies ou logins compartilhados, limpas ao fechar e excluídas do histórico global, da lista de fechadas recentemente e da restauração de sessão.
- **Limite**: um agente pode ver o conteúdo da página e o tráfego, incluindo cookies, armazenamento, cabeçalhos e corpos de resposta. Esses controles são mitigações, não um DLP geral — não aponte um agente não confiável para sites de alta sensibilidade.

Relate vulnerabilidades pelo relatório privado do [SECURITY.md](../../../SECURITY.md), nunca em uma issue pública.

## Plataformas e limites

| Plataforma | Build oficial | Notas |
| --- | --- | --- |
| Windows 11 x64 | Instalador NSIS | Mantido ativamente, coberto por CI e regressões locais |
| Windows 10 x64 | Mesmo instalador | Compartilha o build do Windows 11; a aceitação de atualização em máquina real ainda está pendente |
| Linux x86_64 (Ubuntu desktop) | AppImage | Requer Node.js 22.12+ do sistema; outras distribuições precisam de verificação em máquina real |
| Windows ARM64 / macOS / Android / iOS | Nenhum | O instalador recusa explicitamente em vez de fingir que instala |

Limitações conhecidas:

- **Sem assinatura de código** no Windows: o SmartScreen avisa e é preciso escolher «Mais informações → Executar assim mesmo».
- **Não é um substituto do Chrome**: sem favoritos, extensões ou sincronização de conta/multidispositivo. O escopo é «núcleo do navegador + acesso de agentes».
- **O acesso MCP no Linux exige Node.js 22.12+ do sistema**; no Windows o runtime incluído é usado quando não há Node do sistema.
- **A restauração de sessão tem escopo**: apenas abas web normais, no máximo 20 entradas, nunca abas isoladas, páginas internas ou URLs não HTTP(S).
- **Uma instância por diretório de dados de usuário**; o build de desenvolvimento usa seu próprio diretório para que ambos possam rodar.
- **Instalações e atualizações dependem do GitHub Releases**; a autoatualização do AppImage precisa de um diretório gravável.

## Documentação

A documentação detalhada está atualmente em chinês:

| Documento | Conteúdo |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | Matriz de plataformas e clientes, flags do instalador, passos manuais, solução de problemas |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | Matriz de releases, dependências do Linux, desinstalação e recuperação de dados |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | Verificação de atualização, download, reiniciar para instalar, SHA-512 e rollback |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | Instalação e verificação do plugin do DeepSeek Harness |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | Evidências de release, registros de regressão e limites de manutenção |
| [release notes](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | Histórico de mudanças por versão |

## Contribuição e licença

Relatos de bugs, discussões de funcionalidades, correções de documentação e PRs são bem-vindos — leia antes o [CONTRIBUTING.md](../../../CONTRIBUTING.md). Ao adicionar uma ferramenta MCP, atualize junto `src/main/tools.ts`, `cli/mcp.mjs`, a tabela de ferramentas deste README e `src/shared/tool-defs.mjs`; `npm run check` verifica se os três primeiros continuam em sincronia.

MIT licensed — consulte [LICENSE](../../../LICENSE) © colaboradores do Aa Browser.

Esta tradução pode ficar atrás do original em chinês. As traduções deste README são mantidas em [README.md](../../../README.md) (简体中文), além de `docs/i18n/readmes/README.<language>.md`; veja `../readme-languages.json` para a lista completa.
