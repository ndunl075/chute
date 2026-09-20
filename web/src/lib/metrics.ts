/** In-page metrics for soak tests and diagnostics. */

export type TransferMetric = {
  at: number
  transferId: string
  direction: 'send' | 'receive'
  size: number
  ttfbMs: number | null
  iceReadyMs: number | null
  icePath: string | null
}

const samples: TransferMetric[] = []
let lastIceReadyMs: number | null = null
let lastIcePath: string | null = null

export function recordIce(ms: number, path: string): void {
  lastIceReadyMs = ms
  lastIcePath = path
}

export function recordTransfer(m: Omit<TransferMetric, 'at' | 'iceReadyMs' | 'icePath'>): void {
  samples.push({
    ...m,
    at: Date.now(),
    iceReadyMs: lastIceReadyMs,
    icePath: lastIcePath,
  })
  // Keep bounded
  if (samples.length > 50) samples.shift()
}

export function getMetrics(): {
  samples: TransferMetric[]
  lastIceReadyMs: number | null
  lastIcePath: string | null
} {
  return {
    samples: [...samples],
    lastIceReadyMs,
    lastIcePath,
  }
}

declare global {
  interface Window {
    __chuteMetrics?: typeof getMetrics
  }
}

export function exposeMetrics(): void {
  if (typeof window !== 'undefined') {
    window.__chuteMetrics = getMetrics
  }
}
