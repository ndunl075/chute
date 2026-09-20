/** Generate a short room id (URL-safe). */
export function randomRoomId(len = 8): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/** 4-char human code for typing. */
export function randomCode(): string {
  return randomRoomId(4).toUpperCase()
}

export function uuid(): string {
  return crypto.randomUUID()
}
