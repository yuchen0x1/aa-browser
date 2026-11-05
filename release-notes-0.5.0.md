# Aa Browser v0.5.0

## Features

- Add a WorkBuddy connector setup path and local stdio MCP configuration generation.
- Add user approval controls for sensitive browser operations.
- Improve browser bridge connection isolation, tool reliability, downloads, screenshots and snapshot behavior.

## Validation

- WorkBuddy config/connector isolation validation passed.
- Typecheck, production build, and browser MCP smoke suite passed locally and in GitHub Actions.
- Real WorkBuddy 5.9.3 tool discovery and end-to-end session acceptance remain to be confirmed after installing this release.

## Installation

The WorkBuddy one-message prompt prepares the connector and attempts to configure the user-level MCP entry. WorkBuddy may require importing/enabling the generated connector in its supported UI; configuration-file creation alone does not prove that tools are loaded. Confirm actual `browser_tabs` tool invocation before treating setup as complete.
