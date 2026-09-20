/** Shared protocol types — keep in sync with protocol/PROTOCOL.md */

export const CHUNK_SIZE = 64 * 1024

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
}

export type ManifestMessage = {
  type: 'manifest'
  transferId: string
  files: FileEntry[]
  chunkSize: number
  /** Sender performance.now() when drop happened — for TTFB measurement */
  dropAt: number
}

export type ReadyMessage = {
  type: 'ready'
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
  | ReadyMessage
  | CompleteMessage
  | AbortMessage
