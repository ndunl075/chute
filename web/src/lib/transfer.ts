import { CHUNK_SIZE, type ControlMessage, type ManifestMessage } from './protocol'
import { uuid } from './id'
import type { PeerTransport } from './transport'

export type TransferProgress = {
  transferId: string
  direction: 'send' | 'receive'
  name: string
  size: number
  bytesDone: number
  /** ms from drop to first byte on the wire / received */
  ttfbMs: number | null
  status: 'sending' | 'receiving' | 'done' | 'error'
  error?: string
  objectUrl?: string
}

export type TransferCallbacks = {
  onProgress: (p: TransferProgress) => void
}

/**
 * M1 transfer: single file, single channel, in-memory receive.
 */
export class TransferSession {
  private receiving:
    | {
        transferId: string
        name: string
        size: number
        mime: string
        chunks: ArrayBuffer[]
        bytesDone: number
        firstByteAt: number | null
        dropAt: number
      }
    | null = null

  constructor(
    private transport: PeerTransport,
    private callbacks: TransferCallbacks,
  ) {}

  handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.handleControl(JSON.parse(data) as ControlMessage)
      return
    }
    this.handleChunk(data)
  }

  private handleControl(msg: ControlMessage): void {
    if (msg.type === 'ready') return
    if (msg.type === 'manifest') {
      this.receiving = {
        transferId: msg.transferId,
        name: msg.files[0].name,
        size: msg.files[0].size,
        mime: msg.files[0].mime || 'application/octet-stream',
        chunks: [],
        bytesDone: 0,
        firstByteAt: null,
        // Receiver clock: gap from manifest → first chunk (pipe heat)
        dropAt: performance.now(),
      }
      this.callbacks.onProgress({
        transferId: msg.transferId,
        direction: 'receive',
        name: msg.files[0].name,
        size: msg.files[0].size,
        bytesDone: 0,
        ttfbMs: null,
        status: 'receiving',
      })
      return
    }
    if (msg.type === 'complete' && this.receiving?.transferId === msg.transferId) {
      const r = this.receiving
      const blob = new Blob(r.chunks, { type: r.mime })
      const objectUrl = URL.createObjectURL(blob)
      this.callbacks.onProgress({
        transferId: r.transferId,
        direction: 'receive',
        name: r.name,
        size: r.size,
        bytesDone: r.bytesDone,
        ttfbMs: r.firstByteAt,
        status: 'done',
        objectUrl,
      })
      this.receiving = null
    }
  }

  private handleChunk(buf: ArrayBuffer): void {
    if (!this.receiving) return
    const r = this.receiving
    if (r.firstByteAt === null) {
      r.firstByteAt = performance.now() - r.dropAt
    }
    r.chunks.push(buf)
    r.bytesDone += buf.byteLength
    this.callbacks.onProgress({
      transferId: r.transferId,
      direction: 'receive',
      name: r.name,
      size: r.size,
      bytesDone: r.bytesDone,
      ttfbMs: r.firstByteAt,
      status: 'receiving',
    })
  }

  async sendFile(file: File): Promise<void> {
    const transferId = uuid()
    const dropAt = performance.now()
    const channel = this.transport.channel
    if (!channel || channel.readyState !== 'open') {
      throw new Error('data channel not open')
    }

    const manifest: ManifestMessage = {
      type: 'manifest',
      transferId,
      files: [
        {
          id: 0,
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
        },
      ],
      chunkSize: CHUNK_SIZE,
      dropAt,
    }

    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: file.name,
      size: file.size,
      bytesDone: 0,
      ttfbMs: null,
      status: 'sending',
    })

    channel.send(JSON.stringify(manifest))

    let offset = 0
    let firstByteSentAt: number | null = null

    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size)
      const slice = file.slice(offset, end)
      const buf = await slice.arrayBuffer()

      // Backpressure
      while (channel.bufferedAmount > 2 * 1024 * 1024) {
        await new Promise<void>((resolve) => {
          channel.bufferedAmountLowThreshold = 512 * 1024
          channel.onbufferedamountlow = () => resolve()
        })
      }

      if (firstByteSentAt === null) {
        firstByteSentAt = performance.now() - dropAt
      }
      channel.send(buf)
      offset = end

      this.callbacks.onProgress({
        transferId,
        direction: 'send',
        name: file.name,
        size: file.size,
        bytesDone: offset,
        ttfbMs: firstByteSentAt,
        status: 'sending',
      })
    }

    channel.send(JSON.stringify({ type: 'complete', transferId }))
    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: file.name,
      size: file.size,
      bytesDone: file.size,
      ttfbMs: firstByteSentAt,
      status: 'done',
    })
  }
}
