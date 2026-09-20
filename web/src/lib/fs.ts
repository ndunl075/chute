/** Chromium File System Access, Firefox StreamSaver-via-SW, else in-memory Blob. */

export type ReceiveSink = {
  write: (chunk: ArrayBuffer) => Promise<void>
  close: () => Promise<{ objectUrl?: string; fileHandle?: FileSystemFileHandle; streamed?: boolean }>
  abort: () => Promise<void>
}

export async function openReceiveSink(
  name: string,
  mime: string,
  size: number,
): Promise<ReceiveSink> {
  // Prefer streaming to disk when the picker is available and file is large.
  if (size >= 8 * 1024 * 1024 && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: mime
          ? [{ description: 'File', accept: { [mime]: ['.*'] } }]
          : undefined,
      })
      const writable = await handle.createWritable()
      return {
        write: async (chunk) => {
          await writable.write(chunk)
        },
        close: async () => {
          await writable.close()
          return { fileHandle: handle }
        },
        abort: async () => {
          await writable.abort()
        },
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        /* fall through */
      }
    }
  }

  // Firefox / others: StreamSaver pattern via our service worker for larger files.
  if (size >= 2 * 1024 * 1024 && 'serviceWorker' in navigator && typeof ReadableStream !== 'undefined') {
    const swSink = await tryStreamSaver(name, mime, size)
    if (swSink) return swSink
  }

  const chunks: ArrayBuffer[] = []
  return {
    write: async (chunk) => {
      chunks.push(chunk)
    },
    close: async () => {
      const blob = new Blob(chunks, { type: mime })
      return { objectUrl: URL.createObjectURL(blob) }
    },
    abort: async () => {
      chunks.length = 0
    },
  }
}

async function tryStreamSaver(
  name: string,
  mime: string,
  size: number,
): Promise<ReceiveSink | null> {
  try {
    const reg = await navigator.serviceWorker.ready
    if (!reg.active) return null

    const id = crypto.randomUUID()
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })

    // Transfer the readable side to the SW (Chrome/Firefox support transferable streams).
    reg.active.postMessage({ type: 'chute-download', id, stream }, [stream as unknown as Transferable])

    const url =
      `/__chute_dl__/${id}?name=${encodeURIComponent(name)}` +
      `&mime=${encodeURIComponent(mime)}&size=${size}`

    // Kick off the download navigation in a hidden iframe / anchor.
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()

    return {
      write: async (chunk) => {
        controller?.enqueue(new Uint8Array(chunk))
      },
      close: async () => {
        controller?.close()
        return { streamed: true }
      },
      abort: async () => {
        try {
          controller?.error(new Error('aborted'))
        } catch {
          /* ignore */
        }
      },
    }
  } catch {
    return null
  }
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      types?: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<FileSystemFileHandle>
  }

  interface FileSystemFileHandle {
    createWritable(): Promise<FileSystemWritableFileStream>
  }

  interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
  }
}
