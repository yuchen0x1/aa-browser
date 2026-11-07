# Aa Browser v0.6.0

## Features

- Add site whitelist enforcement: once rules are configured, all navigation paths — omnibox, agent tools, page links, redirects, popups and the context menu — are checked in the main process. Supports exact hosts, `*.example.com` wildcards and explicit ports.
- Isolate every tab into its own persistent Electron session partition, so cookies, storage, cache and request-mock rules never leak between tabs; downloads follow each tab's session.
- Add request interception and mocking (`browser_mock_requests` / `browser_list_mocks` / `browser_clear_mocks`), letting agents stub, replay and observe traffic without touching the page.
- Add optional human confirmation before risky agent operations such as form submission (toggleable in Settings).
- Add downloads panel, page context menu, browsing-history omnibox autocomplete, and a full settings panel (search engine, snapshot mode, download directory, whitelist, agent service info).
- Carry over the v0.5.x line: drag tool, cyber HUD UI overhaul and security/stability hardening.
- Override minimatch 9/10 to 11.0.4 to remediate CVE-2026-118764.

## Validation

- Typecheck, production build, and browser MCP smoke suite passed locally.
- GitHub Actions CI re-runs typecheck, build and the end-to-end smoke suite on every push to main.

## Installation

Download and run `aa-browser-setup-0.6.0.exe`. Windows SmartScreen may warn because the binary is not code-signed — choose "More info → Run anyway". After install, open Aa Browser and use the new-tab card to connect your AI client.
