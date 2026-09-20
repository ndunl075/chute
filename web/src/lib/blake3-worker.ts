import { createBLAKE3 } from 'hash-wasm'

const ctx: Worker = self as unknown as Worker

ctx.onmessage = async (ev: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => {
  const { id, buffer } = ev.data
  try {
    const hasher = await createBLAKE3()
    hasher.update(new Uint8Array(buffer))
    const hash = hasher.digest('hex')
    ctx.postMessage({ id, hash: `blake3:${hash}` })
  } catch (e) {
    ctx.postMessage({
      id,
      error: e instanceof Error ? e.message : 'hash failed',
    })
  }
}

export {}
