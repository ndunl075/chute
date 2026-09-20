import type { SignalEnvelope } from './protocol'

type Handler = (msg: SignalEnvelope) => void

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  peerId: string | null = null
  room: string | null = null

  constructor(private url: string) {}

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws

      const onWelcome = (msg: SignalEnvelope) => {
        if (msg.type === 'welcome' && msg.peerId) {
          this.peerId = msg.peerId
          this.handlers.delete(onWelcome)
          resolve(msg.peerId)
        }
      }
      this.handlers.add(onWelcome)

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as SignalEnvelope
          for (const h of this.handlers) h(msg)
        } catch {
          /* ignore */
        }
      }
      ws.onerror = () => reject(new Error('websocket error'))
      ws.onclose = () => {
        this.ws = null
      }
    })
  }

  join(room: string): void {
    this.room = room
    this.send({ type: 'join', room })
  }

  signal(payload: unknown, target?: string): void {
    this.send({ type: 'signal', payload, target })
  }

  send(msg: SignalEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}

export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}
