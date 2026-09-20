/** IndexedDB persistence for resume bitmaps and paired devices. */

const DB_NAME = 'chute'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('bitmaps')) {
        db.createObjectStore('bitmaps', { keyPath: 'transferId' })
      }
      if (!db.objectStoreNames.contains('pairs')) {
        db.createObjectStore('pairs', { keyPath: 'deviceId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export type BitmapRecord = {
  transferId: string
  name: string
  size: number
  mime: string
  chunkSize: number
  totalChunks: number
  /** Sparse list of received chunk indices */
  received: number[]
  updatedAt: number
}

const RETENTION_MS = 24 * 60 * 60 * 1000

export async function saveBitmap(rec: BitmapRecord): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('bitmaps', 'readwrite')
    tx.objectStore('bitmaps').put({ ...rec, updatedAt: Date.now() })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function loadBitmap(transferId: string): Promise<BitmapRecord | null> {
  const db = await openDb()
  const rec = await new Promise<BitmapRecord | undefined>((resolve, reject) => {
    const tx = db.transaction('bitmaps', 'readonly')
    const req = tx.objectStore('bitmaps').get(transferId)
    req.onsuccess = () => resolve(req.result as BitmapRecord | undefined)
    req.onerror = () => reject(req.error)
  })
  db.close()
  if (!rec) return null
  if (Date.now() - rec.updatedAt > RETENTION_MS) {
    await deleteBitmap(transferId)
    return null
  }
  return rec
}

export async function deleteBitmap(transferId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('bitmaps', 'readwrite')
    tx.objectStore('bitmaps').delete(transferId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/** Compact bitmap as base64 of bytes (1 bit per chunk). */
export function toBitset(total: number, received: Iterable<number>): string {
  const bytes = new Uint8Array(Math.ceil(total / 8) || 1)
  for (const i of received) {
    if (i >= 0 && i < total) bytes[i >> 3] |= 1 << (i & 7)
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBitset(total: number, b64: string): Set<number> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const out = new Set<number>()
  for (let i = 0; i < total; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) out.add(i)
  }
  return out
}
