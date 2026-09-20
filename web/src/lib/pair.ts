import { loadBitmap, saveBitmap, deleteBitmap } from './idb'

export type PairedDevice = {
  /** Fingerprint of remote Ed25519 public key (hex) */
  deviceId: string
  label: string
  roomId: string
  keyFragment: string
  /** SPKI base64 of remote public key */
  publicKeySpki: string
  lastSeen: number
}

const DB_NAME = 'chute'
const DB_VERSION = 2

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
      if (!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('revoked')) {
        db.createObjectStore('revoked', { keyPath: 'deviceId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function idbPut(store: string, value: unknown): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(value)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).getAll()
      req.onsuccess = () => resolve((req.result as T[]) || [])
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): ArrayBuffer {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

async function fingerprint(spki: ArrayBuffer): Promise<string> {
  const dig = await crypto.subtle.digest('SHA-256', spki)
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type DeviceIdentity = {
  publicKeySpki: string
  fingerprint: string
  privateKey: CryptoKey
  publicKey: CryptoKey
}

/** Load or create this browser's Ed25519 identity. */
export async function getOrCreateIdentity(): Promise<DeviceIdentity> {
  const existing = await idbGet<{
    id: string
    publicKeySpki: string
    fingerprint: string
    privateKey: CryptoKey
    publicKey: CryptoKey
  }>('identity', 'self')

  if (existing?.privateKey && existing.publicKey) {
    return {
      publicKeySpki: existing.publicKeySpki,
      fingerprint: existing.fingerprint,
      privateKey: existing.privateKey,
      publicKey: existing.publicKey,
    }
  }

  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
  const fp = await fingerprint(spki)
  const rec = {
    id: 'self',
    publicKeySpki: b64(spki),
    fingerprint: fp,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  }
  await idbPut('identity', rec)
  return {
    publicKeySpki: rec.publicKeySpki,
    fingerprint: fp,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  }
}

/** Sign a challenge with our device key. */
export async function signChallenge(privateKey: CryptoKey, challenge: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(challenge))
  return b64(sig)
}

export async function verifyChallenge(
  publicKeySpkiB64: string,
  challenge: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      fromB64(publicKeySpkiB64),
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
    return crypto.subtle.verify(
      'Ed25519',
      key,
      fromB64(signatureB64),
      new TextEncoder().encode(challenge),
    )
  } catch {
    return false
  }
}

export async function fingerprintFromSpki(publicKeySpkiB64: string): Promise<string> {
  return fingerprint(fromB64(publicKeySpkiB64))
}

export async function isRevoked(deviceId: string): Promise<boolean> {
  const row = await idbGet<{ deviceId: string }>('revoked', deviceId)
  return Boolean(row)
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await idbPut('revoked', { deviceId, revokedAt: Date.now() })
  await removePair(deviceId)
}

export async function savePair(p: PairedDevice): Promise<void> {
  if (await isRevoked(p.deviceId)) return
  await idbPut('pairs', p)
}

export async function listPairs(): Promise<PairedDevice[]> {
  const rows = await idbGetAll<PairedDevice>('pairs')
  return rows.sort((a, b) => b.lastSeen - a.lastSeen)
}

export async function removePair(deviceId: string): Promise<void> {
  await idbDelete('pairs', deviceId)
}

/** @deprecated use getOrCreateIdentity().fingerprint */
export function getOrCreateDeviceId(): string {
  return 'legacy'
}

export { loadBitmap, saveBitmap, deleteBitmap }
