import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface FileScope {
  profileId: string
  roots: string[]
  blockedRoots?: string[]
}

let scopeProvider: ((profileId?: string) => FileScope) | undefined
export function configureFilePolicy(provider: (profileId?: string) => FileScope): void { scopeProvider = provider }

export function fileScope(profileId?: string): FileScope {
  if (scopeProvider) return scopeProvider(profileId)
  const root = path.join(os.homedir(), '.aabrowser')
  if (profileId && profileId !== 'default') {
    const profileRoot = path.join(root, 'profiles', profileId)
    return { profileId, roots: ['downloads', 'files', 'har', 'screenshots', 'baselines'].map((kind) => path.join(profileRoot, kind)), blockedRoots: [root] }
  }
  return {
    profileId: 'default',
    roots: [process.env.AA_BROWSER_EXPORT_DIR, process.env.AA_BROWSER_DOWNLOAD_DIR, process.env.AA_BROWSER_SCREENSHOT_DIR,
      ...['downloads', 'files', 'har', 'screenshots', 'baselines'].map((kind) => path.join(root, kind))].filter((item): item is string => !!item),
    blockedRoots: [root]
  }
}

export function pathInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

function normalizedFile(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || !path.isAbsolute(input)) throw new Error('[PERMISSION_ERROR] An absolute file path is required')
  const file = path.resolve(input)
  // NTFS alternate streams and Win32 aliases must not escape ordinary file semantics.
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(file) || file.slice(path.parse(file).root.length).includes(':') || file.split(/[\\/]/).some((part) => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('[PERMISSION_ERROR] Unsupported Windows file path')
  }
  return file
}

/** Reject links in every existing path component, including directory junctions. */
function assertNoLinks(file: string): void {
  let current = file
  for (;;) {
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('[PERMISSION_ERROR] Symbolic links and junctions are not allowed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function assertScope(file: string, opts: { profileId?: string; approvedExternal?: boolean }): void {
  const scope = fileScope(opts.profileId)
  const owned = scope.roots.some((root) => pathInside(root, file))
  if (!owned && scope.blockedRoots?.some((root) => pathInside(root, file))) throw new Error('[PERMISSION_ERROR] Another profile or browser private data cannot be accessed')
  if (!owned && !opts.approvedExternal) throw new Error('[PERMISSION_ERROR] File is outside this profile\'s managed directories; explicit one-time approval is required')
}

export function validateReadFile(input: string, opts: { profileId?: string; approvedExternal?: boolean } = {}): string {
  const file = normalizedFile(input)
  assertScope(file, opts)
  assertNoLinks(file)
  if (!fs.lstatSync(file).isFile()) throw new Error('[PERMISSION_ERROR] Only regular files may be read')
  return file
}

export function resolveWriteFile(input: string, opts: { profileId?: string; approvedExternal?: boolean; overwrite?: boolean } = {}): string {
  const file = normalizedFile(input)
  assertScope(file, opts)
  assertNoLinks(file)
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile()) throw new Error('[PERMISSION_ERROR] Export target is not a regular file')
    if (!opts.overwrite) throw new Error('[PERMISSION_ERROR] Refusing to overwrite an existing file')
  }
  return file
}

export function writeExportFile(input: string, data: string | Buffer, opts: { profileId?: string; approvedExternal?: boolean; overwrite?: boolean } = {}): string {
  const file = resolveWriteFile(input, opts)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  resolveWriteFile(file, opts)
  if (!opts.overwrite) {
    const fd = fs.openSync(file, 'wx', 0o600)
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } else {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      resolveWriteFile(file, opts)
      fs.renameSync(temporary, file)
    } finally { try { fs.unlinkSync(temporary) } catch { /* already committed */ } }
  }
  return file
}
