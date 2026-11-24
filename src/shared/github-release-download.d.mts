export interface ReleaseProgress {
  transferred: number
  total: number
  percent: number
  bytesPerSecond: number
}

export interface ReleaseResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: {
    on(event: string, listener: (...args: any[]) => void): unknown
    once(event: string, listener: (...args: any[]) => void): unknown
    removeListener(event: string, listener: (...args: any[]) => void): unknown
    pause?(): void
    resume?(): void
  }
  abort?: () => void
}

export type ReleaseRequest = (
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal
) => Promise<ReleaseResponse>

export interface DownloadAaBrowserReleaseAssetOptions {
  url: string | URL
  destination: string
  size: number
  sha256: string
  sha512?: string | null
  request?: ReleaseRequest
  signal?: AbortSignal
  onProgress?: (progress: ReleaseProgress) => void
  onRoute?: (route: string) => void
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  routeTimeoutMs?: number
  minSpeedBytesPerSecond?: number
  speedGraceMs?: number
  speedSampleMs?: number
  slowRouteMs?: number
}

export function parseAaBrowserReleaseAsset(input: string | URL): {
  url: URL
  tag: string
  assetName: string
} | null
export function createAaBrowserReleaseRoutes(input: string | URL): Array<{
  id: string
  url: string
  initialScore: number
}>
export function isSafeAaBrowserRedirect(fromInput: string | URL, toInput: string | URL, officialOnly?: boolean): boolean
export function parseSha256Sums(contents: string, filename: string): string
export function readTrustedAaBrowserSha256Sums(
  input: string | URL,
  request?: ReleaseRequest,
  signal?: AbortSignal,
  maxBytes?: number
): Promise<string>
export function downloadAaBrowserReleaseAsset(options: DownloadAaBrowserReleaseAssetOptions): Promise<string>
export function resetAaBrowserReleaseRouteScores(): void
export function getAaBrowserReleaseRouteScores(): Record<string, {
  score: number
  failures: number
  cooldownUntil: number
  updatedAt: number
}>
