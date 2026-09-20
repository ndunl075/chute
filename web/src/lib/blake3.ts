/** BLAKE3 hashing in a Worker so drops stay responsive. */

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (h: string) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./blake3-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<{ id: number; hash?: string; error?: string }>) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    pending.delete(ev.data.id)
    if (ev.data.error) p.reject(new Error(ev.data.error))
    else p.resolve(ev.data.hash || '')
  }
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'blake3 worker error'))
    pending.clear()
  }
  return worker
}

export async function blake3File(file: Blob): Promise<string> {
  const id = ++seq
  const buf = await file.arrayBuffer()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, buffer: buf }, [buf])
  })
}

export async function blake3Bytes(data: ArrayBuffer): Promise<string> {
  const id = ++seq
  // Copy so we can transfer without detaching caller's buffer when needed
  const copy = data.slice(0)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, buffer: copy }, [copy])
  })
}
