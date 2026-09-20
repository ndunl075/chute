import {
  CHUNK_SIZE,
  DATA_CHANNEL_COUNT,
  decodeChunk,
  encodeChunk,
  type ControlMessage,
  type ManifestMessage,
} from './protocol'
import { uuid } from './id'
import { openReceiveSink, type ReceiveSink } from './fs'
import { makeThumbnail } from './preview'
import type { PeerTransport } from './transport'

export type TransferProgress = {
  transferId: string
  direction: 'send' | 'receive'
  name: string
  size: number
  bytesDone: number
  ttfbMs: number | null
  status: 'sending' | 'receiving' | 'done' | 'error'
  error?: string
  objectUrl?: string
  thumbnailUrl?: string
  streamedToDisk?: boolean
}

export type TransferCallbacks = {
  onProgress: (p: TransferProgress) => void
}

type Receiving = {
  transferId: string
  name: string
  size: number
  mime: string
  chunkSize: number
  totalChunks: number
  chunks: (ArrayBuffer | undefined)[]
  bytesDone: number
  received: number
  firstByteAt: number | null
  startAt: number
  sink: ReceiveSink | null
  nextWrite: number
  writing: boolean
  senderDone: boolean
  finishing: boolean
  thumbnailUrl?: string
}

/**
 * M2 transfer: parallel unordered data channels, chunk indices,
 * thumbnail-first, File System Access streaming when available.
 */
export class TransferSession {
  private receiving: Receiving | null = null

  constructor(
    private transport: PeerTransport,
    private callbacks: TransferCallbacks,
  ) {}

  handleControl(data: string): void {
    this.handleControlMsg(JSON.parse(data) as ControlMessage)
  }

  handleData(buf: ArrayBuffer): void {
    const { index, payload } = decodeChunk(buf)
    void this.handleChunk(index, payload)
  }

  private handleControlMsg(msg: ControlMessage): void {
    if (msg.type === 'ready') return

    if (msg.type === 'thumbnail' && this.receiving?.transferId === msg.transferId) {
      this.receiving.thumbnailUrl = msg.dataUrl
      this.emitReceive()
      return
    }

    if (msg.type === 'thumbnail') {
      // Thumbnail may arrive before manifest on a hot pipe — stash lightly via progress.
      this.callbacks.onProgress({
        transferId: msg.transferId,
        direction: 'receive',
        name: '…',
        size: 0,
        bytesDone: 0,
        ttfbMs: null,
        status: 'receiving',
        thumbnailUrl: msg.dataUrl,
      })
      return
    }

    if (msg.type === 'manifest') {
      const file = msg.files[0]
      const totalChunks = Math.ceil(file.size / msg.chunkSize) || 0
      this.receiving = {
        transferId: msg.transferId,
        name: file.name,
        size: file.size,
        mime: file.mime || 'application/octet-stream',
        chunkSize: msg.chunkSize,
        totalChunks,
        chunks: new Array(totalChunks),
        bytesDone: 0,
        received: 0,
        firstByteAt: null,
        startAt: performance.now(),
        sink: null,
        nextWrite: 0,
        writing: false,
        senderDone: false,
        finishing: false,
      }
      void openReceiveSink(file.name, file.mime, file.size).then((sink) => {
        if (this.receiving?.transferId === msg.transferId) {
          this.receiving.sink = sink
          void this.flushWrites()
        }
      })
      this.emitReceive()
      return
    }

    if (msg.type === 'complete' && this.receiving?.transferId === msg.transferId) {
      this.receiving.senderDone = true
      void this.maybeFinishReceive()
    }
  }

  private async handleChunk(index: number, payload: ArrayBuffer): Promise<void> {
    const r = this.receiving
    if (!r) return
    if (r.chunks[index]) return
    if (r.firstByteAt === null) {
      r.firstByteAt = performance.now() - r.startAt
    }
    r.chunks[index] = payload
    r.received += 1
    r.bytesDone += payload.byteLength
    this.emitReceive()
    await this.flushWrites()
    await this.maybeFinishReceive()
  }

  private async flushWrites(): Promise<void> {
    const r = this.receiving
    if (!r || !r.sink || r.writing) return
    r.writing = true
    try {
      while (r.nextWrite < r.totalChunks && r.chunks[r.nextWrite]) {
        const buf = r.chunks[r.nextWrite]!
        r.chunks[r.nextWrite] = undefined
        await r.sink.write(buf)
        r.nextWrite += 1
      }
    } finally {
      r.writing = false
    }
  }

  private async maybeFinishReceive(): Promise<void> {
    const r = this.receiving
    if (!r || r.finishing) return
    if (!r.senderDone) return
    if (r.totalChunks > 0 && r.received < r.totalChunks) return
    r.finishing = true
    await this.finishReceive()
  }

  private async finishReceive(): Promise<void> {
    const r = this.receiving
    if (!r) return
    await this.flushWrites()

    if (!r.sink) {
      r.sink = await openReceiveSink(r.name, r.mime, r.size)
      for (let i = 0; i < r.totalChunks; i++) {
        const c = r.chunks[i]
        if (c) await r.sink.write(c)
      }
      r.nextWrite = r.totalChunks
    } else {
      await this.flushWrites()
      while (r.nextWrite < r.totalChunks) {
        const c = r.chunks[r.nextWrite]
        if (!c) break
        await r.sink.write(c)
        r.chunks[r.nextWrite] = undefined
        r.nextWrite += 1
      }
    }

    const closed = await r.sink.close()
    this.callbacks.onProgress({
      transferId: r.transferId,
      direction: 'receive',
      name: r.name,
      size: r.size,
      bytesDone: r.bytesDone,
      ttfbMs: r.firstByteAt,
      status: 'done',
      objectUrl: closed.objectUrl,
      thumbnailUrl: r.thumbnailUrl,
      streamedToDisk: Boolean(closed.fileHandle),
    })
    this.receiving = null
  }

  private emitReceive(): void {
    const r = this.receiving
    if (!r) return
    this.callbacks.onProgress({
      transferId: r.transferId,
      direction: 'receive',
      name: r.name,
      size: r.size,
      bytesDone: r.bytesDone,
      ttfbMs: r.firstByteAt,
      status: 'receiving',
      thumbnailUrl: r.thumbnailUrl,
    })
  }

  async sendFile(file: File): Promise<void> {
    const transferId = uuid()
    const dropAt = performance.now()
    const control = this.transport.channel
    if (!control || control.readyState !== 'open') {
      throw new Error('control channel not open')
    }
    const dataChannels = this.transport.dataChannels
    if (!dataChannels.length) throw new Error('data channels not open')

    // Optimistic UI
    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: file.name,
      size: file.size,
      bytesDone: 0,
      ttfbMs: null,
      status: 'sending',
    })

    // Thumbnail first (best-effort), ahead of payload.
    const thumb = await makeThumbnail(file)
    if (thumb) {
      control.send(
        JSON.stringify({
          type: 'thumbnail',
          transferId,
          mime: 'image/jpeg',
          dataUrl: thumb,
        }),
      )
      this.callbacks.onProgress({
        transferId,
        direction: 'send',
        name: file.name,
        size: file.size,
        bytesDone: 0,
        ttfbMs: null,
        status: 'sending',
        thumbnailUrl: thumb,
      })
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
      channelCount: dataChannels.length || DATA_CHANNEL_COUNT,
      dropAt,
    }
    control.send(JSON.stringify(manifest))

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 0
    let firstByteSentAt: number | null = null
    let bytesDone = 0

    // Stripe chunks across channels with backpressure per channel.
    const workers = dataChannels.map(async (ch, lane) => {
      for (let index = lane; index < totalChunks; index += dataChannels.length) {
        const start = index * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const buf = await file.slice(start, end).arrayBuffer()

        while (ch.bufferedAmount > 2 * 1024 * 1024) {
          await new Promise<void>((resolve) => {
            ch.bufferedAmountLowThreshold = 512 * 1024
            ch.onbufferedamountlow = () => resolve()
          })
        }

        if (firstByteSentAt === null) {
          firstByteSentAt = performance.now() - dropAt
        }
        ch.send(encodeChunk(index, buf))
        bytesDone += buf.byteLength
        this.callbacks.onProgress({
          transferId,
          direction: 'send',
          name: file.name,
          size: file.size,
          bytesDone: Math.min(bytesDone, file.size),
          ttfbMs: firstByteSentAt,
          status: 'sending',
          thumbnailUrl: thumb ?? undefined,
        })
      }
    })

    await Promise.all(workers)
    control.send(JSON.stringify({ type: 'complete', transferId }))
    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: file.name,
      size: file.size,
      bytesDone: file.size,
      ttfbMs: firstByteSentAt,
      status: 'done',
      thumbnailUrl: thumb ?? undefined,
    })
  }
}
