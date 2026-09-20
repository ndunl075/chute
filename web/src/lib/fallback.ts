import { CHUNK_SIZE } from './protocol'
import { decryptBytes, encryptBytes } from './crypto'
import { uuid } from './id'
import type { TransferProgress } from './transfer'

/** HTTPS store-and-forward. Server only sees AES-GCM ciphertext. */
export async function fallbackSend(
  roomId: string,
  key: CryptoKey,
  file: File,
  onProgress: (p: TransferProgress) => void,
): Promise<string> {
  const transferId = uuid()
  const dropAt = performance.now()
  onProgress({
    transferId,
    direction: 'send',
    name: file.name,
    size: file.size,
    bytesDone: 0,
    ttfbMs: null,
    status: 'sending',
  })

  const meta = new TextEncoder().encode(
    JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      chunkSize: CHUNK_SIZE,
    }),
  )
  await put(roomId, transferId, 'meta', await encryptBytes(key, meta.buffer))

  const total = Math.ceil(file.size / CHUNK_SIZE) || 0
  let first: number | null = null
  for (let i = 0; i < total; i++) {
    const buf = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer()
    const enc = await encryptBytes(key, buf)
    if (first === null) first = performance.now() - dropAt
    await put(roomId, transferId, `chunk/${i}`, enc)
    onProgress({
      transferId,
      direction: 'send',
      name: file.name,
      size: file.size,
      bytesDone: Math.min((i + 1) * CHUNK_SIZE, file.size),
      ttfbMs: first,
      status: 'sending',
    })
  }
  await fetch(`/api/fallback/${roomId}/${transferId}/complete`, { method: 'POST' })
  onProgress({
    transferId,
    direction: 'send',
    name: file.name,
    size: file.size,
    bytesDone: file.size,
    ttfbMs: first,
    status: 'done',
  })
  return transferId
}

export async function fallbackReceive(
  roomId: string,
  key: CryptoKey,
  transferId: string,
  onProgress: (p: TransferProgress) => void,
): Promise<void> {
  const start = performance.now()
  let metaRaw: ArrayBuffer | null = null
  for (let i = 0; i < 120 && !metaRaw; i++) {
    metaRaw = await get(roomId, transferId, 'meta')
    if (!metaRaw) await sleep(500)
  }
  if (!metaRaw) throw new Error('fallback meta timeout')

  const meta = JSON.parse(new TextDecoder().decode(await decryptBytes(key, metaRaw))) as {
    name: string
    size: number
    mime: string
    chunkSize: number
  }

  onProgress({
    transferId,
    direction: 'receive',
    name: meta.name,
    size: meta.size,
    bytesDone: 0,
    ttfbMs: null,
    status: 'receiving',
  })

  const total = Math.ceil(meta.size / meta.chunkSize) || 0
  const parts: ArrayBuffer[] = []
  let first: number | null = null
  for (let i = 0; i < total; i++) {
    let chunk: ArrayBuffer | null = null
    for (let attempt = 0; attempt < 60 && !chunk; attempt++) {
      chunk = await get(roomId, transferId, `chunk/${i}`)
      if (!chunk) await sleep(250)
    }
    if (!chunk) throw new Error(`missing chunk ${i}`)
    const plain = await decryptBytes(key, chunk)
    if (first === null) first = performance.now() - start
    parts.push(plain)
    onProgress({
      transferId,
      direction: 'receive',
      name: meta.name,
      size: meta.size,
      bytesDone: Math.min((i + 1) * meta.chunkSize, meta.size),
      ttfbMs: first,
      status: 'receiving',
    })
  }

  onProgress({
    transferId,
    direction: 'receive',
    name: meta.name,
    size: meta.size,
    bytesDone: meta.size,
    ttfbMs: first,
    status: 'done',
    objectUrl: URL.createObjectURL(new Blob(parts, { type: meta.mime })),
  })
}

async function put(roomId: string, transferId: string, path: string, body: ArrayBuffer): Promise<void> {
  const res = await fetch(`/api/fallback/${roomId}/${transferId}/${path}`, {
    method: 'PUT',
    body,
  })
  if (!res.ok) throw new Error('fallback put failed')
}

async function get(roomId: string, transferId: string, path: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`/api/fallback/${roomId}/${transferId}/${path}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('fallback get failed')
  return res.arrayBuffer()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
