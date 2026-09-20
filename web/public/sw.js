/* Minimal service worker: cache shell + handle share target navigations. */
const CACHE = 'chute-shell-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Share Target POST → stash files in Cache Storage, redirect to /?share=1
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
        // Store each file as a Response body
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

  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return

  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).catch(() => caches.match('/'))),
  )
})
