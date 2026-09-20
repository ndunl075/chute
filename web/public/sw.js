/* Service worker: shell cache, share target, StreamSaver-style downloads. */
const CACHE = 'chute-shell-v2'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

/** @type {Map<string, ReadableStream>} */
const pendingDownloads = new Map()

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'chute-download') return
  const { id, stream } = data
  if (id && stream) pendingDownloads.set(id, stream)
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(
      (async () => {
        const form = await event.request.formData()
        const files = form.getAll('files').filter((f) => f instanceof File)
        const cache = await caches.open('chute-share')
        await cache.put(
          '/__share_payload__',
          new Response(JSON.stringify({ count: files.length }), {
            headers: { 'content-type': 'application/json' },
          }),
        )
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          await cache.put(
            `/__share_file_${i}__`,
            new Response(f, {
              headers: {
                'content-type': f.type || 'application/octet-stream',
                'x-filename': encodeURIComponent(f.name),
              },
            }),
          )
        }
        return Response.redirect('/?share=1', 303)
      })(),
    )
    return
  }

  // StreamSaver-style: /__chute_dl__/<id>?name=&mime=
  if (event.request.method === 'GET' && url.pathname.startsWith('/__chute_dl__/')) {
    const id = url.pathname.slice('/__chute_dl__/'.length)
    const stream = pendingDownloads.get(id)
    pendingDownloads.delete(id)
    if (!stream) {
      event.respondWith(new Response('download not found', { status: 404 }))
      return
    }
    const name = url.searchParams.get('name') || 'download.bin'
    const mime = url.searchParams.get('mime') || 'application/octet-stream'
    const size = url.searchParams.get('size')
    const headers = new Headers({
      'content-type': mime,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    if (size) headers.set('content-length', size)
    event.respondWith(new Response(stream, { headers }))
    return
  }

  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return
  if (url.pathname.startsWith('/__chute_dl__/')) return

  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).catch(() => caches.match('/'))),
  )
})
