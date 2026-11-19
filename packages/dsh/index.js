/**
 * aa-browser-dsh — Host plugin that stages the Aa Browser MCP bridge.
 *
 * On activation it copies this package's single-file bridge (`bridge.cjs`,
 * built from the Aa Browser repository) to a stable user path and logs the
 * result. The bundle's MCP row starts that staged file with DSH's own runtime,
 * so the MCP configuration never points into a plugin install directory that
 * changes on update.
 *
 * The plugin only touches the file system: it never spawns a process, never
 * throws at activation, and stays inert with an actionable warning when the
 * bridge cannot be staged.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of this package, and the base for a relative `bridge` value. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
/** Bundled bridge, relative to the package root. */
const DEFAULT_BRIDGE = './bridge.cjs'
/** Stable location the MCP row runs, relative to the user's home directory. */
const DEFAULT_TARGET = '~/.aabrowser/dsh-bridge.cjs'
/** Environment override for the staged bridge destination. */
const TARGET_ENV = 'AA_BROWSER_DSH_BRIDGE_TARGET'
/** Build-time version stamp injected by scripts/sync-bridge.mjs. */
const BRIDGE_VERSION = /globalThis\.__AA_BRIDGE_VERSION__\s*=\s*"([^"]+)"/u

/**
 * Expand a leading `~` without relying on shell expansion.
 * @param {string} value - a path that may start with `~`, `~/`, or `~\`.
 * @returns {string} the path with the home directory substituted.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the bridge source and destination for this activation.
 * @param {unknown} config - the row's `config` object.
 * @param {Record<string, string | undefined>} env - environment to read the override from.
 * @returns {{ source: string, target: string }} absolute source and target paths.
 */
export function resolveBridgePaths(config, env) {
  const settings = typeof config === 'object' && config !== null ? config : {}
  const bridge = typeof settings.bridge === 'string' && settings.bridge.trim() !== '' ? settings.bridge.trim() : DEFAULT_BRIDGE
  const source = isAbsolute(bridge) ? bridge : resolve(PACKAGE_ROOT, bridge)

  const configuredTarget = typeof env[TARGET_ENV] === 'string' && env[TARGET_ENV].trim() !== ''
    ? env[TARGET_ENV]
    : typeof settings.target === 'string' && settings.target.trim() !== ''
      ? settings.target
      : DEFAULT_TARGET
  const expanded = expandHome(configuredTarget.trim())
  const target = isAbsolute(expanded) ? expanded : resolve(homedir(), expanded)
  return { source, target }
}

/**
 * Copy the bridge atomically: write a sibling temporary file, then rename it
 * over the destination so a reader never sees a partial bridge.
 * @param {string} source - bridge file to copy.
 * @param {string} target - staged bridge destination.
 * @returns {number} size in bytes of the staged file.
 */
function stageBridge(source, target) {
  const sourceStat = statSync(source)
  if (!sourceStat.isFile()) throw new Error('bridge source is not a regular file')
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    copyFileSync(source, temp)
    renameSync(temp, target)
  } finally {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* the rename already consumed it, or cleanup is not permitted */
    }
  }
  return statSync(target).size
}

/**
 * Read the bridge version stamped into the bundled file.
 * @param {string} source - bridge file to read.
 * @returns {string | undefined} the version, or undefined when the file carries none.
 */
function bridgeVersion(source) {
  try {
    return BRIDGE_VERSION.exec(readFileSync(source, 'utf8').slice(0, 4096))?.[1]
  } catch {
    return undefined
  }
}

/**
 * Pick a logging sink from the plugin context, falling back to the console.
 * Logging must never be the reason activation fails.
 * @param {unknown} ctx - the Cordis plugin context.
 * @returns {{ info: (message: string) => void, warn: (message: string) => void }} logger.
 */
function reporter(ctx) {
  const logger = typeof ctx === 'object' && ctx !== null ? ctx.logger : undefined
  const write = (level, message) => {
    try {
      const sink = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : console[level].bind(console)
      sink(message)
    } catch {
      /* logging is best-effort */
    }
  }
  return { info: (message) => write('info', message), warn: (message) => write('warn', message) }
}

/**
 * Cordis Host plugin entry: stage the Aa Browser MCP bridge to a stable path.
 * @param {unknown} ctx - the Cordis plugin context.
 * @param {unknown} config - the row's `config`: `{ bridge?, target? }`.
 */
export function apply(ctx, config) {
  const log = reporter(ctx)
  let paths
  try {
    paths = resolveBridgePaths(config, process.env)
    const bytes = stageBridge(paths.source, paths.target)
    const version = bridgeVersion(paths.source)
    log.info(
      `aa-browser-dsh: staged Aa Browser MCP bridge${version === undefined ? '' : ` v${version}`} at ${paths.target} ` +
        `(${Math.round(bytes / 1024)} KB); tools are mcp__aa-browser__* once connected.`,
    )
  } catch (error) {
    const reason = error instanceof Error ? `${error.code === undefined ? '' : `[${String(error.code)}] `}${error.message}` : String(error)
    log.warn(
      `aa-browser-dsh: could not stage the Aa Browser MCP bridge ` +
        `(${paths?.source ?? 'bridge.cjs'} -> ${paths?.target ?? 'unknown target'}): ${reason}. ` +
        'Install Aa Browser first, then reinstall this plugin so its bundled bridge.cjs is present; ' +
        'the MCP server keeps running without a bridge and its tools stay unavailable until one is staged.',
    )
  }
}
