import {
  CHUNK_SIZE,
  DATA_CHANNEL_COUNT,
  decodeChunk,
  encodeChunk,
  type ControlMessage,
  type FileEntry,
  type ManifestMessage,
} from './protocol'
import { uuid } from './id'
import { openReceiveSink } from './fs'
import { makeThumbnail } from './preview'
import type { PeerTransport } from './transport'
import { deleteBitmap, fromBitset, loadBitmap, saveBitmap, toBitset } from './idb'
import { releaseWakeLock, requestWakeLock } from './wakelock'
import { blake3Bytes, blake3File } from './blake3'

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
  objectUrls?: { name: string; url: string }[]
  thumbnailUrl?: string
  streamedToDisk?: boolean
  fileCount?: number
  hashVerified?: boolean
}

export type TransferCallbacks = {
  onProgress: (p: TransferProgress) => void
}

type Receiving = {
  transferId: string
  files: FileEntry[]
  chunkSize: number
  totalChunks: number
  totalSize: number
  chunks: (ArrayBuffer | undefined)[]
  have: Set<number>
  bytesDone: number
  firstByteAt: number | null
  startAt: number
  senderDone: boolean
  finishing: boolean
  thumbnailUrl?: string
  /** Pending resume bitmap from prior session */
  resumed: boolean
}

/**
 * M4 transfer: multi-file, resume bitmaps, wake lock around active sends/receives.
 */
export class TransferSession {
  private receiving: Receiving | null = null
  private resumeWaiters = new Map<string, (bits: Set<number>) => void>()

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

    if (msg.type === 'resume') {
      const waiter = this.resumeWaiters.get(msg.transferId)
      const bits = fromBitset(msg.totalChunks, msg.bitmap)
      if (waiter) {
        this.resumeWaiters.delete(msg.transferId)
        waiter(bits)
      }
      return
    }

    if (msg.type === 'thumbnail') {
      if (this.receiving?.transferId === msg.transferId) {
        this.receiving.thumbnailUrl = msg.dataUrl
        this.emitReceive()
      } else {
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
      }
      return
    }

    if (msg.type === 'manifest') {
      void this.beginReceive(msg)
      return
    }

    if (msg.type === 'complete' && this.receiving?.transferId === msg.transferId) {
      this.receiving.senderDone = true
      void this.maybeFinishReceive()
    }
  }

  private async beginReceive(msg: ManifestMessage): Promise<void> {
    await requestWakeLock()
    const totalSize = msg.files.reduce((s, f) => s + f.size, 0)
    const totalChunks = Math.ceil(totalSize / msg.chunkSize) || 0
    const prior = await loadBitmap(msg.transferId)
    const have = new Set<number>(prior?.received ?? [])

    this.receiving = {
      transferId: msg.transferId,
      files: msg.files,
      chunkSize: msg.chunkSize,
      totalChunks,
      totalSize,
      chunks: new Array(totalChunks),
      have,
      bytesDone: have.size * msg.chunkSize, // approximate until sizes known
      firstByteAt: have.size ? 0 : null,
      startAt: performance.now(),
      senderDone: false,
      finishing: false,
      resumed: have.size > 0,
    }

    // Always ack with a resume bitmap so the sender can start promptly.
    this.transport.sendControl(
      JSON.stringify({
        type: 'resume',
        transferId: msg.transferId,
        bitmap: toBitset(totalChunks, have),
        totalChunks,
      }),
    )

    this.emitReceive()
  }

  private async handleChunk(index: number, payload: ArrayBuffer): Promise<void> {
    const r = this.receiving
    if (!r) return
    if (r.have.has(index)) return
    if (r.firstByteAt === null) {
      r.firstByteAt = performance.now() - r.startAt
    }
    r.chunks[index] = payload
    r.have.add(index)
    r.bytesDone = Math.min(r.totalSize, [...r.have].reduce((s, i) => {
      const c = r.chunks[i]
      return s + (c ? c.byteLength : 0)
    }, 0))

    await saveBitmap({
      transferId: r.transferId,
      name: r.files.map((f) => f.name).join(', '),
      size: r.totalSize,
      mime: r.files[0]?.mime || 'application/octet-stream',
      chunkSize: r.chunkSize,
      totalChunks: r.totalChunks,
      received: [...r.have],
      updatedAt: Date.now(),
    })

    this.emitReceive()
    await this.maybeFinishReceive()
  }

  private async maybeFinishReceive(): Promise<void> {
    const r = this.receiving
    if (!r || r.finishing) return
    if (!r.senderDone) return
    if (r.totalChunks > 0 && r.have.size < r.totalChunks) return
    r.finishing = true
    await this.finishReceive()
  }

  private async finishReceive(): Promise<void> {
    const r = this.receiving
    if (!r) return

    // Assemble contiguous bytes then split into files.
    const ordered: ArrayBuffer[] = []
    for (let i = 0; i < r.totalChunks; i++) {
      const c = r.chunks[i]
      if (!c) throw new Error(`missing chunk ${i}`)
      ordered.push(c)
    }
    const all = concat(ordered)
    const objectUrls: { name: string; url: string }[] = []
    let offset = 0
    let streamed = false

    for (const file of r.files) {
      const slice = all.slice(offset, offset + file.size)
      offset += file.size
      if (file.hash) {
        const got = await blake3Bytes(slice)
        if (got !== file.hash) {
          await releaseWakeLock()
          this.callbacks.onProgress({
            transferId: r.transferId,
            direction: 'receive',
            name: file.path || file.name,
            size: r.totalSize,
            bytesDone: r.bytesDone,
            ttfbMs: r.firstByteAt,
            status: 'error',
            error: `hash mismatch for ${file.name}`,
            hashVerified: false,
          })
          this.receiving = null
          return
        }
      }
      const sink = await openReceiveSink(file.path || file.name, file.mime, file.size)
      await sink.write(slice)
      const closed = await sink.close()
      if (closed.objectUrl) {
        objectUrls.push({ name: file.path || file.name, url: closed.objectUrl })
      }
      if (closed.fileHandle || closed.streamed) streamed = true
    }

    await deleteBitmap(r.transferId)
    await releaseWakeLock()

    this.callbacks.onProgress({
      transferId: r.transferId,
      direction: 'receive',
      name: r.files.length === 1 ? r.files[0].name : `${r.files.length} files`,
      size: r.totalSize,
      bytesDone: r.totalSize,
      ttfbMs: r.firstByteAt,
      status: 'done',
      objectUrl: objectUrls[0]?.url,
      objectUrls,
      thumbnailUrl: r.thumbnailUrl,
      streamedToDisk: streamed,
      fileCount: r.files.length,
      hashVerified: r.files.every((f) => Boolean(f.hash)),
    })
    this.receiving = null
  }

  private emitReceive(): void {
    const r = this.receiving
    if (!r) return
    this.callbacks.onProgress({
      transferId: r.transferId,
      direction: 'receive',
      name: r.files.length === 1 ? r.files[0].name : `${r.files.length} files`,
      size: r.totalSize,
      bytesDone: Math.min(r.bytesDone, r.totalSize),
      ttfbMs: r.firstByteAt,
      status: 'receiving',
      thumbnailUrl: r.thumbnailUrl,
      fileCount: r.files.length,
    })
  }

  async sendFiles(files: File[]): Promise<void> {
    if (!files.length) return
    await requestWakeLock()
    try {
      await this.sendFilesInner(files)
    } finally {
      await releaseWakeLock()
    }
  }

  async sendFile(file: File): Promise<void> {
    return this.sendFiles([file])
  }

  private async sendFilesInner(files: File[]): Promise<void> {
    const transferId = uuid()
    const control = this.transport.channel
    if (!control || control.readyState !== 'open') {
      throw new Error('control channel not open')
    }
    const dataChannels = this.transport.dataChannels
    if (!dataChannels.length) throw new Error('data channels not open')

    const entries: FileEntry[] = []
    for (let id = 0; id < files.length; id++) {
      const f = files[id]
      const hash = await blake3File(f)
      entries.push({
        id,
        name: f.name,
        size: f.size,
        mime: f.type || 'application/octet-stream',
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
        hash,
      })
    }
    const totalSize = entries.reduce((s, f) => s + f.size, 0)
    const label = files.length === 1 ? files[0].name : `${files.length} files`

    // TTFB starts when the pipe is used, after hashing (hashing is prep, not wire latency).
    const dropAt = performance.now()

    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: label,
      size: totalSize,
      bytesDone: 0,
      ttfbMs: null,
      status: 'sending',
      fileCount: files.length,
    })

    const thumb = files[0] ? await makeThumbnail(files[0]) : null
    if (thumb) {
      control.send(
        JSON.stringify({
          type: 'thumbnail',
          transferId,
          mime: 'image/jpeg',
          dataUrl: thumb,
        }),
      )
    }

    const manifest: ManifestMessage = {
      type: 'manifest',
      transferId,
      files: entries,
      chunkSize: CHUNK_SIZE,
      channelCount: dataChannels.length || DATA_CHANNEL_COUNT,
      dropAt,
    }
    control.send(JSON.stringify(manifest))

    // Wait for receiver resume bitmap (or empty) before striping.
    const skip = await this.waitResume(transferId, 1000)

    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE) || 0
    let firstByteSentAt: number | null = skip.size ? 0 : null
    let bytesDone = 0
    for (const idx of skip) {
      const start = idx * CHUNK_SIZE
      bytesDone += Math.min(CHUNK_SIZE, totalSize - start)
    }

    // Build a virtual concatenated reader.
    const readChunk = async (index: number): Promise<ArrayBuffer> => {
      const start = index * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, totalSize)
      return readRange(files, start, end)
    }

    const workers = dataChannels.map(async (ch, lane) => {
      for (let index = lane; index < totalChunks; index += dataChannels.length) {
        if (skip.has(index)) continue
        const buf = await readChunk(index)

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
          name: label,
          size: totalSize,
          bytesDone: Math.min(bytesDone, totalSize),
          ttfbMs: firstByteSentAt,
          status: 'sending',
          thumbnailUrl: thumb ?? undefined,
          fileCount: files.length,
        })
      }
    })

    await Promise.all(workers)
    control.send(JSON.stringify({ type: 'complete', transferId }))
    this.callbacks.onProgress({
      transferId,
      direction: 'send',
      name: label,
      size: totalSize,
      bytesDone: totalSize,
      ttfbMs: firstByteSentAt,
      status: 'done',
      thumbnailUrl: thumb ?? undefined,
      fileCount: files.length,
    })
  }

  private waitResume(transferId: string, timeoutMs: number): Promise<Set<number>> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.resumeWaiters.delete(transferId)
        resolve(new Set())
      }, timeoutMs)
      this.resumeWaiters.set(transferId, (bits) => {
        clearTimeout(t)
        resolve(bits)
      })
    })
  }
}

async function readRange(files: File[], start: number, end: number): Promise<ArrayBuffer> {
  let offset = 0
  const parts: ArrayBuffer[] = []
  let remaining = end - start
  let cursor = start
  for (const f of files) {
    const fileEnd = offset + f.size
    if (cursor < fileEnd && remaining > 0) {
      const localStart = Math.max(0, cursor - offset)
      const take = Math.min(f.size - localStart, remaining)
      parts.push(await f.slice(localStart, localStart + take).arrayBuffer())
      cursor += take
      remaining -= take
    }
    offset = fileEnd
    if (remaining <= 0) break
  }
  return concat(parts)
}

function concat(parts: ArrayBuffer[]): ArrayBuffer {
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(new Uint8Array(p), o)
    o += p.byteLength
  }
  return out.buffer
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
