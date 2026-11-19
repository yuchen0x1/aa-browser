# Aa Browser

**Le navigateur de bureau pensé pour les agents — open source, sous licence MIT.**

<p align="center">
  <a href="./README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <b>Français</b> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> Un navigateur que vous utilisez comme un humain, piloté par un agent comme un ingénieur.

<p align="center">
  <img src="./site/assets/og-image.png" alt="Aa Browser — un navigateur conçu pour les agents" width="720" />
</p>

Il s'agit d'une **traduction condensée**. La documentation complète et de référence est rédigée en chinois : [README.md](./README.md) et [`docs/`](./docs).

## Ce que c'est

Les navigateurs classiques sont conçus pour des yeux humains qui regardent des pixels ; un agent IA a besoin de **données de page structurées**. Aa Browser est un navigateur de bureau Chromium complet (Electron) que tout le monde peut utiliser normalement — onglets, barre d'adresse, historique, téléchargements, recherche dans la page, sessions persistantes — et il expose la page à n'importe quel agent [MCP](https://modelcontextprotocol.io) via un pont stdio local : lire un **snapshot d'accessibilité structuré**, puis cliquer, saisir, sélectionner, glisser, faire défiler, extraire et capturer le trafic. Pas de captures d'écran, pas de coordonnées devinées.

Les snapshots sont **incrémentaux** par défaut : une page inchangée coûte une ligne, de petits changements ne renvoient que le diff, et les identifiants `ref` restent stables d'un snapshot à l'autre. Le pont écoute sur `127.0.0.1` avec un token généré à chaque lancement et stocké dans `~/.aabrowser/connection.json`.

## Points clés

- 🖥️ **Un vrai navigateur** : coque Electron/Chromium avec onglets, barre d'adresse, précédent/suivant, recherche dans la page, panneau de téléchargements et sessions persistantes.
- 🧠 **Snapshots structurés** : la page devient un arbre d'accessibilité de style YAML où chaque élément interactif porte un identifiant `ref` (`- button "Sign in" [ref=e5]`), aligné sur le format de Playwright MCP.
- 💸 **Les snapshots incrémentaux économisent des tokens** : aucun changement → une ligne ; petit changement → uniquement les blocs modifiés ; une navigation ou de gros changements font retomber sur un snapshot complet. Les tâches longues économisent généralement 60 %+ du contexte.
- 🎯 **Chemin de saisie réel** : les clics utilisent de vrais événements d'entrée de confiance (`isTrusted=true`), la saisie passe par le pipeline `insertText` avec un repli pour les champs contrôlés par React, et des événements synthétiques couvrent le rare cas où un événement réel est perdu.
- 🤖 **MCP natif** : un pont MCP stdio standard ; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code et WorkBuddy peuvent le piloter.
- 📊 **Diagnostic** : `browser_performance` renvoie les durées de navigation, le premier rendu, la taille des ressources et les ressources lentes, le tas JS et la taille du DOM sans ouvrir DevTools.
- 🌐 **Interface bilingue** : suit la langue du système ou du navigateur, ou fixe le chinois simplifié / English dans les réglages.
- 🔒 **Sécurité locale d'abord** : WebSocket en loopback uniquement, token aléatoire à chaque lancement, liste de sites autorisés, onglets isolés, données réseau expurgées et approbation dans le navigateur pour les opérations à risque.
- 📦 **Versions vérifiables** : Windows NSIS et Linux AppImage sortent dans la même version avec `SHA256SUMS.txt`, des attestations de publication immuables GitHub et un `sbom.cdx.json` CycloneDX.

## Exemple de snapshot

Appeler `browser_snapshot` sur la page d'accueil de Bing renvoie (sortie réelle, conservée telle quelle) :

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

L'agent agit ensuite sur un `ref` :

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

Après une action, vous obtenez un **snapshot incrémental** — uniquement les blocs modifiés, plus les identifiants `ref` ajoutés ou invalidés. `browser_snapshot { full: true }` force l'arbre complet.

## Installation

### Un seul prompt (recommandé)

Envoyez le prompt de [PROMPT.md](./PROMPT.md) à toute IA capable d'exécuter des commandes locales. Si Aa Browser n'est pas encore installé, elle télécharge l'installeur officiel, vérifie le SHA-256, installe, lance, écrit la configuration MCP et appelle réellement `browser_tabs` pour vérifier. Si Aa Browser est déjà en cours d'exécution, elle écrit seulement la configuration et vérifie.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

L'installeur ne pose jamais de question interactive. `--clients zcode,cursor` limite les clients configurés, `--dir <dir>` remplace le répertoire d'installation, `--no-launch` saute le lancement, et `--sha256 <hex>` fixe le hash attendu de l'installeur. Tout autre client MCP peut utiliser la sortie de `--print-config`.

### Windows

Téléchargez `aa-browser-setup-<version>.exe` depuis [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) et exécutez-le. L'installeur **n'est pas signé** : quand SmartScreen apparaît, choisissez « Informations complémentaires → Exécuter quand même ». Chaque version fournit aussi `SHA256SUMS.txt`, `sbom.cdx.json` et une attestation de publication immuable pour vérifier vous-même les fichiers.

### Linux AppImage

Téléchargez `aa-browser-<version>-linux-x86_64.AppImage`, rendez-le exécutable et lancez-le depuis la session de bureau courante. GTK 3, NSS, GBM, les bibliothèques audio et un sandbox Chromium fonctionnel sont requis ; l'accès MCP nécessite Node.js 22.12 ou plus récent côté système.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

Sans FUSE, lancez-le avec `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. Voir le [guide des plateformes](./docs/PLATFORMS.md) pour l'état par distribution et les étapes de récupération.

### Depuis les sources

Node.js 22.12 ou plus récent est requis.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

Le mode développement avec rendu à chaud est `npm run dev` ; il utilise un répertoire de données utilisateur distinct, `aa-browser-dev`, et peut donc tourner en parallèle de la version installée.

## Connecter votre agent

Prérequis : Aa Browser est en cours d'exécution (il écrit le port et le token dans `~/.aabrowser/connection.json`), le client prend en charge MCP stdio, et les deux tournent sous le même utilisateur sur la même machine.

- **En un clic** : Réglages → Connecter un client IA → cochez les clients → écrire. Redémarrez le client ensuite.
- **Manuel** : exécutez `node install.mjs --print-config` et collez le `command` / `args` / `env` affichés dans la configuration du client. Les configurations existantes sont sauvegardées sous `<file>.aa-backup-<timestamp>` ; seule l'entrée `aa-browser` est modifiée, et les écritures sont idempotentes.

### État et vérification

| État dans la barre d'outils | Signification |
| --- | --- |
| En attente de connexion IA | Aucun pont MCP ne s'est connecté : configuration absente, client non redémarré ou navigateur non lancé |
| En attente du premier appel IA | Le pont est connecté et authentifié, mais aucun appel d'outil n'a encore réussi |
| IA connectée ×N | Au moins un appel de liste `browser_tabs` a réussi ; N est le nombre de ponts vérifiés |

Une configuration écrite **n'est pas** une connexion qui fonctionne. Vérifiez avec `node install.mjs --verify-only`, ou laissez l'agent appeler réellement `browser_tabs`.

## Outils MCP

**34 outils** en cinq groupes : navigation et snapshot (4), interaction (9), lecture et état (12), réseau et Mock (6), diagnostic et onglets (3). Les noms d'outils côté client peuvent porter le préfixe `mcp__aa-browser__`.

| Groupe | Outils |
| --- | --- |
| Navigation et snapshot | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| Interaction | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| Lecture et état | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| Réseau et Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| Diagnostic et onglets | `browser_performance`, `browser_resize`, `browser_tabs` |

Comportement commun : la plupart des outils renvoient un snapshot avec leur résultat (`snapshot: false` l'omet), tous les outils sauf `browser_resize` et `browser_downloads` acceptent un `tabId`, un appel unique expire après 180 secondes, l'approbation attend jusqu'à 120 secondes, et les détails réseau sont expurgés par défaut. Le manuel complet des outils est dans [site/tools.html](./site/tools.html).

## Sécurité

- Le service de l'agent n'écoute que sur `127.0.0.1`, utilise un token aléatoire à chaque lancement et rejette les origines non locales ; le port et le token résident dans `~/.aabrowser/connection.json` et sont supprimés à la fermeture propre.
- Les vues de page s'exécutent sans script de preload ; les snapshots et les scripts d'action sont injectés par le processus principal. La navigation n'autorise que `http:` / `https:` — `file:`, `data:`, `devtools:` et les protocoles similaires sont rejetés.
- Les champs de saisie sensibles doivent être remplis par l'utilisateur : le texte fourni par l'agent n'est jamais écrit, lu ni renvoyé. Avec « confirmer les opérations à risque » activé, l'envoi de formulaire, l'Entrée après saisie et l'accès réseau non expurgé attendent une approbation dans le navigateur (120 secondes, ensuite traité comme un refus).
- Les détails réseau et les exports HAR expurgent par défaut les en-têtes d'authentification et les paramètres ressemblant à des identifiants.
- **Liste de sites autorisés** : s'applique uniquement à la navigation ; la laisser vide la désactive, et même vide, `file:`, `data:`, `devtools:` et les autres protocoles non web restent bloqués.
- **Connecter un agent ne touche qu'une seule entrée** : les configurations client existantes sont d'abord sauvegardées, seule l'entrée `aa-browser` est modifiée, aucun token ni mot de passe n'est jamais écrit, et le téléchargement de l'installeur vérifie le digest SHA-256 et l'en-tête de fichier de la release.
- Les onglets isolés utilisent une partition de session séparée : aucun cookie ni identifiant partagé, données effacées à la fermeture, et exclusion de l'historique global, de la liste des onglets récemment fermés et de la restauration de session.
- **Limite** : un agent peut voir le contenu de la page et le trafic, y compris les cookies, le stockage, les en-têtes et les corps de réponse. Ces contrôles sont des mesures d'atténuation, pas une DLP générale — ne pointez pas un agent non fiable vers des sites très sensibles.

Signalez les vulnérabilités via le rapport privé de [SECURITY.md](./SECURITY.md), jamais dans une issue publique.

## Plateformes et limites

| Plateforme | Build officiel | Remarques |
| --- | --- | --- |
| Windows 11 x64 | Installeur NSIS | Maintenu activement, couvert par la CI et des régressions locales |
| Windows 10 x64 | Même installeur | Partage le build Windows 11 ; la validation de mise à niveau sur machine réelle reste à faire |
| Linux x86_64 (bureau Ubuntu) | AppImage | Nécessite Node.js 22.12+ côté système ; les autres distributions demandent une vérification sur machine réelle |
| Windows ARM64 / macOS / Android / iOS | Aucun | L'installeur refuse explicitement au lieu de prétendre installer |

Limites connues :

- **Pas de signature de code** sous Windows : SmartScreen avertit et demande « Informations complémentaires → Exécuter quand même ».
- **Pas un remplacement de Chrome** : ni favoris, ni extensions, ni synchronisation de compte/multi-appareils. Le périmètre est « noyau du navigateur + accès agent ».
- **L'accès MCP sous Linux exige Node.js 22.12+ côté système** ; sous Windows, le runtime embarqué est utilisé quand aucun Node système n'est trouvé.
- **La restauration de session est limitée** : onglets web normaux uniquement, 20 entrées au maximum, jamais d'onglets isolés, de pages internes ni d'URL non HTTP(S).
- **Une instance par répertoire de données utilisateur** ; le build de développement utilise son propre répertoire pour que les deux puissent tourner.
- **L'installation et les mises à jour dépendent de GitHub Releases** ; l'auto-mise à jour de l'AppImage exige un répertoire inscriptible.

## Documentation

La documentation détaillée est actuellement en chinois :

| Document | Contenu |
| --- | --- |
| [docs/CONNECT.md](./docs/CONNECT.md) | Matrice plateformes et clients, options de l'installeur, étapes manuelles, dépannage |
| [docs/PLATFORMS.md](./docs/PLATFORMS.md) | Matrice des versions, dépendances Linux, désinstallation et récupération des données |
| [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md) | Vérification des mises à jour, téléchargement, redémarrage pour installer, SHA-512 et rollback |
| [docs/MARKETPLACE.md](./docs/MARKETPLACE.md) | Installation et vérification du plugin DeepSeek Harness |
| [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) | Preuves de publication, registres de régression et limites de maintenance |
| [release notes](./docs/releases/release-notes.md) / [CHANGELOG](./CHANGELOG.md) | Historique des changements par version |
| [site/tools.html](./site/tools.html) | Manuel complet des 34 outils (à ouvrir en local, aucun déploiement nécessaire) |

## Contribution et licence

Les rapports de bugs, discussions de fonctionnalités, corrections de documentation et PR sont bienvenus — lisez d'abord [CONTRIBUTING.md](./CONTRIBUTING.md). Lors de l'ajout d'un outil MCP, mettez à jour ensemble `src/main/tools.ts`, `cli/mcp.mjs`, le tableau des outils de ce README et `site/tools.html` ; `npm run check` vérifie que les trois premiers restent synchronisés.

MIT licensed — voir [LICENSE](./LICENSE) © contributeurs d'Aa Browser.

Cette traduction peut être en retard sur l'original chinois. Les traductions de ce README sont maintenues dans [README.md](./README.md) (简体中文), plus les fichiers `README.<language>.md` ; voir `docs/i18n/readme-languages.json` pour la liste complète.
