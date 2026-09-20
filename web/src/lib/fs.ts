/** Chromium File System Access streaming; falls back to in-memory Blob. */

export type ReceiveSink = {
  write: (chunk: ArrayBuffer) => Promise<void>
  close: () => Promise<{ objectUrl?: string; fileHandle?: FileSystemFileHandle }>
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
      // User cancelled picker — fall through to memory.
      if (e instanceof DOMException && e.name === 'AbortError') {
        /* fall through */
      }
    }
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
