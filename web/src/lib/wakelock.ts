/** Screen Wake Lock to reduce tab suspension mid-transfer. */

type Lock = { release: () => Promise<void> }
let sentinel: Lock | null = null

export async function requestWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<Lock> }
    }
    if (!nav.wakeLock) return
    sentinel = await nav.wakeLock.request('screen')
  } catch {
    /* permission / unsupported */
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    await sentinel?.release()
  } catch {
    /* ignore */
  }
  sentinel = null
}
