/** Load files stashed by the share_target service worker. */

export async function consumeSharedFiles(): Promise<File[]> {
  const cache = await caches.open('chute-share')
  const meta = await cache.match('/__share_payload__')
  if (!meta) return []
  const { count } = (await meta.json()) as { count: number }
  const files: File[] = []
  for (let i = 0; i < count; i++) {
    const res = await cache.match(`/__share_file_${i}__`)
    if (!res) continue
    const buf = await res.arrayBuffer()
    const name = decodeURIComponent(res.headers.get('x-filename') || `shared-${i}`)
    const type = res.headers.get('content-type') || 'application/octet-stream'
    files.push(new File([buf], name, { type }))
    await cache.delete(`/__share_file_${i}__`)
  }
  await cache.delete('/__share_payload__')
  return files
}
