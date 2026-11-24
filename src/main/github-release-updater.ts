import type { RequestOptions } from 'node:http'
import type { UpdateInfo } from 'electron-updater'
import {
  downloadAaBrowserReleaseAsset,
  isSafeAaBrowserRedirect,
  parseAaBrowserReleaseAsset,
  readTrustedAaBrowserSha256Sums
} from '../shared/github-release-download.mjs'
import type {
  ReleaseProgress,
  ReleaseRequest,
  ReleaseResponse
} from '../shared/github-release-download.mjs'

type UpdateFileMetadata = { url: string; size?: number; sha512?: string }
type TrustedUpdateInfo = UpdateInfo & { files?: UpdateFileMetadata[]; tag?: string }
type DownloadOptions = {
  cancellationToken?: {
    cancelled?: boolean
    on?: (event: 'cancel', listener: () => void) => unknown
    removeListener?: (event: 'cancel', listener: () => void) => unknown
  }
  onProgress?: (progress: ReleaseProgress) => void
  sha512?: string | null
}

type ElectronRequest = {
  on(event: string, listener: (...args: any[]) => void): ElectronRequest
  once(event: string, listener: (...args: any[]) => void): ElectronRequest
  end(): void
  abort(): void
  followRedirect(): void
}

type UpdaterExecutor = {
  download(url: URL, destination: string, options: DownloadOptions): Promise<string>
  createRequest(
    options: RequestOptions,
    callback: (response: Electron.IncomingMessage) => void
  ): ElectronRequest
}

type UpdaterRuntime = { httpExecutor?: UpdaterExecutor }
type Logger = Pick<Console, 'info' | 'warn'>

const MAX_REDIRECTS = 8

function makeRequest(executor: UpdaterExecutor, officialOnly = false): ReleaseRequest {
  return (input, headers, signal) => new Promise<ReleaseResponse>((resolve, reject) => {
    let current = new URL(input)
    let redirectCount = 0
    let settled = false
    let request: ElectronRequest | null = null
    let activeResponse: Electron.IncomingMessage | null = null
    let connectTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
      signal?.removeEventListener('abort', abort)
    }
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = () => {
      request?.abort()
      ;(activeResponse as (Electron.IncomingMessage & { destroy?: () => void }) | null)?.destroy?.()
      finishReject(new Error('Updater request was cancelled'))
    }
    const finishResponse = (response: Electron.IncomingMessage) => {
      if (settled) return
      settled = true
      activeResponse = response
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
      const releaseResponse: ReleaseResponse = {
        status: response.statusCode,
        headers: response.headers,
        body: response,
        abort: () => {
          cleanup()
          request?.abort()
          ;(response as Electron.IncomingMessage & { destroy?: () => void }).destroy?.()
        }
      }
      response.once('end', cleanup)
      response.once('aborted', cleanup)
      resolve(releaseResponse)
    }

    try {
      const url = current
      const created = executor.createRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        useSessionCookies: false,
        cache: 'no-store'
      } as RequestOptions, finishResponse)
      request = created
      created.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
        if (
          statusCode < 300 ||
          statusCode >= 400 ||
          ++redirectCount > MAX_REDIRECTS ||
          !isSafeAaBrowserRedirect(current, redirectUrl, officialOnly)
        ) {
          created.abort()
          finishReject(new Error('Updater rejected an unsafe or excessive redirect'))
          return
        }
        current = new URL(redirectUrl, current)
        created.followRedirect()
      })
      created.on('error', finishReject)
      created.once('close', cleanup)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        created.abort()
        finishReject(new Error('Updater request was cancelled'))
        return
      }
      connectTimer = setTimeout(() => {
        created.abort()
        finishReject(new Error('Updater request timed out'))
      }, 20_000)
      created.end()
    } catch (error) {
      finishReject(error)
    }
  })
}

export function installGithubReleaseDownloadAcceleration(
  updater: object,
  logger: Logger = console
): (info: UpdateInfo | null) => void {
  const runtime = updater as UpdaterRuntime
  const executor = runtime.httpExecutor
  if (!executor || typeof executor.download !== 'function' || typeof executor.createRequest !== 'function') {
    throw new Error('electron-updater download contract is unavailable; refusing unverified GitHub downloads')
  }

  const current = executor as UpdaterExecutor & {
    __aaBrowserOriginalDownload?: UpdaterExecutor['download']
    __aaBrowserTrustedInfo?: TrustedUpdateInfo | null
  }
  if (!current.__aaBrowserOriginalDownload) {
    const originalDownload = executor.download.bind(executor)
    current.__aaBrowserOriginalDownload = originalDownload
    executor.download = async (input, destination, options) => {
      const parsed = parseAaBrowserReleaseAsset(input)
      const trustedInfo = current.__aaBrowserTrustedInfo
      if (!parsed) return originalDownload(input, destination, options)
      if (!trustedInfo || trustedInfo.version !== parsed.tag.slice(1)) {
        throw new Error('Trusted GitHub update metadata is unavailable for this release asset')
      }

      const fileInfo = trustedInfo.files?.find((file) => file.url === parsed.assetName)
      if (
        !fileInfo ||
        !Number.isSafeInteger(fileInfo.size) ||
        !fileInfo.sha512 ||
        !options.sha512 ||
        fileInfo.sha512 !== options.sha512
      ) {
        throw new Error('GitHub update metadata is missing the trusted asset size or SHA-512 digest')
      }

      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancellationToken = options.cancellationToken
      cancellationToken?.on?.('cancel', cancel)
      if (cancellationToken?.cancelled) controller.abort()
      try {
        const manifestRequest = makeRequest(executor, true)
        const assetRequest = makeRequest(executor)
        const sha256 = await readTrustedAaBrowserSha256Sums(input, manifestRequest, controller.signal)
        logger.info(`[updater] verified official SHA256SUMS.txt for ${parsed.assetName}`)
        return await downloadAaBrowserReleaseAsset({
          url: input,
          destination,
          size: fileInfo.size!,
          sha256,
          sha512: fileInfo.sha512,
          request: assetRequest,
          signal: controller.signal,
          onProgress: options.onProgress,
          onRoute: (route) => logger.info(`[updater] release download route: ${route}`)
        })
      } finally {
        cancellationToken?.removeListener?.('cancel', cancel)
      }
    }
  }

  return (info) => {
    current.__aaBrowserTrustedInfo = info as TrustedUpdateInfo | null
  }
}
