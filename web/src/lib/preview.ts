/** Best-effort client-side thumbnail (~200px). */

export async function makeThumbnail(file: File): Promise<string | null> {
  if (file.type.startsWith('image/')) {
    return imageThumb(file)
  }
  if (file.type.startsWith('video/')) {
    return videoThumb(file)
  }
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return pdfThumb(file)
  }
  return null
}

async function pdfThumb(file: File): Promise<string | null> {
  try {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
    const data = new Uint8Array(await file.arrayBuffer())
    const doc = await pdfjs.getDocument({ data }).promise
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(1, 200 / Math.max(viewport.width, viewport.height))
    const scaled = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(scaled.width))
    canvas.height = Math.max(1, Math.floor(scaled.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      await doc.destroy()
      return null
    }
    await page.render({ canvasContext: ctx, viewport: scaled, canvas }).promise
    const url = canvas.toDataURL('image/jpeg', 0.7)
    await doc.destroy()
    return url
  } catch {
    return null
  }
}

async function imageThumb(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 200 / Math.max(bmp.width, bmp.height))
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  }
}

async function videoThumb(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.src = url
    const fail = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    video.onerror = fail
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) * 0.01)
      } catch {
        fail()
      }
    }
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 200 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return fail()
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/jpeg', 0.7)
        URL.revokeObjectURL(url)
        resolve(data)
      } catch {
        fail()
      }
    }
  })
}
