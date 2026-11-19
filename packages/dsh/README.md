# aa-browser-dsh

DeepSeek Harness bundle that connects a running [Aa Browser](https://github.com/yuchen0x1/aa-browser) to the agent over MCP.

The bundle vendors only Aa Browser's single-file MCP bridge (`bridge.cjs`, built from the browser's `cli/mcp.mjs`), not the browser itself. On activation a tiny Host plugin stages that bridge at a stable path, and an `aa-browser` stdio MCP entry runs it with DSH's own runtime.

- No npm dependencies; reuses the `@deepseek-ai/dsh-mcp-client` shipped with DSH.
- No system Node.js required (`command` is `process.execPath`, with `ELECTRON_RUN_AS_NODE=1` for the Electron-hosted Desktop build).
- Tools reach the agent as `mcp__aa-browser__<tool name>`.

## Requirements

- Windows x64 or Linux x64. The bundle declares `dsh.bundle.platforms: ["win32", "linux"]`; there is no macOS or Android build yet.
- Aa Browser installed and running.
- DeepSeek Harness with plugin management (Desktop, or a CLI profile).

## Install

In DeepSeek Harness Desktop: **Plugins** → **Add plugin** (marketplace entry or a local directory), then enable **Aa Browser connection** if it is not already selected.

From a CLI profile, `dsh plugin add` forwards to pnpm and then selects the bundle for that profile:

```sh
# npm (after the package is published)
dsh plugin --profile web add aa-browser-dsh

# GitHub monorepo subdirectory. Pin a full commit so DSH can update it later.
dsh plugin --profile web add "github:yuchen0x1/aa-browser#<40-char-commit>&path:/packages/dsh"

# a local checkout, e.g. this directory
dsh plugin --profile web add "<absolute path>/packages/dsh"
```

Without HMR, restart DSH (or the profile) after installing so the new rows mount. A local directory install links the checkout, so run `npm run sync` in this directory (or copy `bridge.cjs` manually) before installing; npm and GitHub installs ship the bridge already.

## Verify

1. After activation, `~/.aabrowser/dsh-bridge.cjs` exists and the DSH log shows `aa-browser-dsh: staged Aa Browser MCP bridge v… at …`.
2. Start Aa Browser, then ask the agent to call one of the `mcp__aa-browser__*` tools, for example `mcp__aa-browser__browser_tabs`. Only a successful call proves the connection; seeing the tool listed proves the bridge is running, not that the browser is reachable.
3. If the tools are missing, check that **Aa Browser connection** is enabled in **Plugins** and look for an `aa-browser-dsh: could not stage …` warning. Reinstalling the plugin restores the bundled `bridge.cjs`.

## Configuration

The bundle inserts two rows into the profile:

| Row id | Package | Purpose |
| --- | --- | --- |
| `aa-browser-dsh` | `aa-browser-dsh` | Stages `bridge.cjs` at the target path |
| `aa-browser-mcp` | `@deepseek-ai/dsh-mcp-client` | Runs the staged bridge as the `aa-browser` MCP server |

`aa-browser-dsh` takes `config.bridge` (default `./bridge.cjs`, relative to the package) and `config.target` (default `~/.aabrowser/dsh-bridge.cjs`). Set `AA_BROWSER_DSH_BRIDGE_TARGET` in the environment that launches DSH to override the target without editing the patch. If you change the target, also change the `args` of `aa-browser-mcp` to the same path.

## Update and remove

- **Update**: use **Update** in **Plugins** (marketplace/npm installs) or `dsh plugin --profile web add aa-browser-dsh@<version>`; reinstall a local directory after pulling. Every activation re-stages the bundled bridge, so the MCP row needs no manual edit.
- **Remove**: remove the bundle in **Plugins**. The staged `~/.aabrowser/dsh-bridge.cjs` is left in place; delete it manually if you want it gone.

## Limitations

- Windows x64 and Linux x64 only; no macOS or Android support yet.
- Tool names are prefixed: `mcp__aa-browser__*`, not bare `browser_*`.
- The MCP entry starts and lists tools even when Aa Browser is closed. Browser tool calls cannot reach it until it runs; the bridge retries every 5 seconds, so no DSH reload is needed. Start Aa Browser before calling browser tools: a call made before the bridge reaches the browser may stay pending until the 180-second tool-call timeout.
- Calls can wait for Aa Browser's approval UI; the MCP call timeout is 180 seconds to cover the browser's 120-second approval window.
- Screenshots are returned as MCP image content; the model sees them only when it supports image input.
- The agent can read page content and captured traffic, including cookies, storage, headers, and response bodies.

## Development

```sh
node scripts/sync-bridge.mjs   # copy ../../out/bridge/mcp.cjs to ./bridge.cjs (runs on prepack too)
node --check index.js
```

`bridge.cjs` must stay committed for GitHub installs; the repository's `out/` directory is not.

## License

MIT, matching Aa Browser.
