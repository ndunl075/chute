/** Shared protocol types — keep in sync with protocol/PROTOCOL.md */

export const CHUNK_SIZE = 64 * 1024
export const DATA_CHANNEL_COUNT = 6

export type SignalEnvelope = {
  type: string
  room?: string
  peerId?: string
  target?: string
  peers?: string[]
  payload?: unknown
  error?: string
  connected?: number
}

export type FileEntry = {
  id: number
  name: string
  size: number
  mime: string
  /** Relative path for folder transfers */
  path?: string
}

export type ManifestMessage = {
  type: 'manifest'
  transferId: string
  files: FileEntry[]
  chunkSize: number
  channelCount: number
  /** Sender performance.now() when drop happened — for TTFB measurement */
  dropAt: number
}

export type ResumeMessage = {
  type: 'resume'
  transferId: string
  /** base64 bitset of already-received chunk indices */
  bitmap: string
  totalChunks: number
}

export type ReadyMessage = {
  type: 'ready'
  channels: number
}

export type ThumbnailMessage = {
  type: 'thumbnail'
  transferId: string
  mime: string
  /** base64 data URL body without prefix, or full data URL */
  dataUrl: string
}

export type CompleteMessage = {
  type: 'complete'
  transferId: string
}

export type AbortMessage = {
  type: 'abort'
  transferId: string
  reason?: string
}

export type ControlMessage =
  | ManifestMessage
  | ResumeMessage
  | ReadyMessage
  | ThumbnailMessage
  | CompleteMessage
  | AbortMessage

/** Binary data-channel frame: u32be chunkIndex + payload */
export function encodeChunk(index: number, payload: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(4 + payload.byteLength)
  const view = new DataView(out)
  view.setUint32(0, index)
  new Uint8Array(out, 4).set(new Uint8Array(payload))
  return out
}

export function decodeChunk(buf: ArrayBuffer): { index: number; payload: ArrayBuffer } {
  const view = new DataView(buf)
  const index = view.getUint32(0)
  return { index, payload: buf.slice(4) }
}
