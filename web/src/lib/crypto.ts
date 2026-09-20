/** AES-GCM helpers. Key material lives in the URL fragment only. */

export async function generateRoomKey(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return b64url(raw)
}

export async function importRoomKey(fragment: string): Promise<CryptoKey> {
  const raw = fromB64url(fragment)
  const copy = new Uint8Array(raw)
  return crypto.subtle.importKey('raw', copy, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptBytes(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const out = new Uint8Array(iv.byteLength + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.byteLength)
  return out.buffer
}

export async function decryptBytes(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const buf = new Uint8Array(data)
  const iv = buf.slice(0, 12)
  const ct = buf.slice(12)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
