export type IceServerConfig = {
  urls: string | string[]
  username?: string
  credential?: string
}

export type AppConfig = {
  iceServers: IceServerConfig[]
  fallback: boolean
}

const defaultConfig: AppConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  fallback: true,
}

let cached: AppConfig | null = null

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached
  try {
    const res = await fetch('/api/config')
    if (!res.ok) throw new Error('config http ' + res.status)
    cached = (await res.json()) as AppConfig
    return cached
  } catch {
    cached = defaultConfig
    return cached
  }
}
