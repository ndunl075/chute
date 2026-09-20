import { loadBitmap, saveBitmap, deleteBitmap } from './idb'

export type PairedDevice = {
  deviceId: string
  label: string
  roomId: string
  keyFragment: string
  lastSeen: number
}

const PAIR_KEY = 'chute-device-id'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('chute', 1)
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

export function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(PAIR_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(PAIR_KEY, id)
  }
  return id
}

export async function savePair(p: PairedDevice): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pairs', 'readwrite')
    tx.objectStore('pairs').put(p)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function listPairs(): Promise<PairedDevice[]> {
  const db = await openDb()
  const rows = await new Promise<PairedDevice[]>((resolve, reject) => {
    const tx = db.transaction('pairs', 'readonly')
    const req = tx.objectStore('pairs').getAll()
    req.onsuccess = () => resolve((req.result as PairedDevice[]) || [])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return rows.sort((a, b) => b.lastSeen - a.lastSeen)
}

export async function removePair(deviceId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pairs', 'readwrite')
    tx.objectStore('pairs').delete(deviceId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

// Re-export bitmap helpers so pair module stays the persistence facade if needed later.
export { loadBitmap, saveBitmap, deleteBitmap }
