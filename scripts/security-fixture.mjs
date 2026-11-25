import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'

const require = createRequire(import.meta.url)
export const SECURITY_MODULES = ['redaction', 'file-policy', 'tool-validation', 'permissions']

/** Load actual standalone security modules while replacing only Electron profile I/O. */
export function securityFixture(compiled) {
  const loaded = {}
  for (const name of SECURITY_MODULES) {
    const file = path.join(compiled, `${name}.js`)
    const module = { exports: {} }
    compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'], { filename: file })(
      (specifier) => loaded[specifier] ?? require(specifier), module, module.exports
    )
    loaded[`./${name}`] = module.exports
  }
  const context = new AsyncLocalStorage()
  const manager = {
    currentProfileId: () => context.getStore() ?? 'default',
    hasContext: () => context.getStore() !== undefined,
    runWithProfile: (id, fn) => context.run(id, fn),
    withUse: (_id, fn) => fn(),
    clientProfile: () => 'default',
    assertLeaseAccess() {},
    directory: (_id, kind) => process.env[`AA_BROWSER_${kind === 'downloads' ? 'DOWNLOAD' : kind === 'screenshots' ? 'SCREENSHOT' : kind.toUpperCase()}_DIR`] || path.join(os.homedir(), '.aabrowser', kind)
  }
  loaded['./profiles'] = { getProfileManager: () => manager }
  return loaded
}
