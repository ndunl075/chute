/** Clipboard sync over the control channel. */

export type ClipboardMessage = {
  type: 'clipboard'
  text: string
  sentAt: number
}

export async function readLocalClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    throw new Error('Clipboard read denied')
  }
}

export async function writeLocalClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    throw new Error('Clipboard write denied')
  }
}
