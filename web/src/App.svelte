<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { randomRoomId } from './lib/id'
  import { renderQr } from './lib/qr'
  import { SignalingClient, defaultWsUrl } from './lib/signaling'
  import { PeerTransport } from './lib/transport'
  import { TransferSession, type TransferProgress } from './lib/transfer'
  import type { SignalEnvelope } from './lib/protocol'
  import { generateRoomKey, importRoomKey } from './lib/crypto'
  import { loadConfig, type AppConfig } from './lib/config'
  import { fallbackReceive, fallbackSend } from './lib/fallback'
  import { getOrCreateDeviceId, listPairs, savePair, type PairedDevice } from './lib/pair'
  import { readLocalClipboard, writeLocalClipboard } from './lib/clipboard'
  import { consumeSharedFiles } from './lib/share'
  import { exposeMetrics, recordIce, recordTransfer } from './lib/metrics'

  type Phase = 'lobby' | 'waiting' | 'connected' | 'fallback' | 'error'

  let phase = $state<Phase>('lobby')
  let roomId = $state('')
  let joinCode = $state('')
  let status = $state('Idle')
  let peerCount = $state(0)
  let progress = $state<TransferProgress | null>(null)
  let error = $state('')
  let dragging = $state(false)
  let shareUrl = $state('')
  let transportMode = $state<'webrtc' | 'fallback'>('webrtc')
  let pairs = $state<PairedDevice[]>([])
  let clipboardNote = $state('')
  let pendingShare: File[] = []
  let keyFragment = $state('')

  let qrCanvas: HTMLCanvasElement | undefined = $state()
  let fileInput: HTMLInputElement | undefined = $state()
  let folderInput: HTMLInputElement | undefined = $state()

  let signaling: SignalingClient | null = null
  let transport: PeerTransport | null = null
  let session: TransferSession | null = null
  let unsub: (() => void) | null = null
  let roomKey: CryptoKey | null = null
  let appConfig: AppConfig | null = null
  let remotePeerId: string | null = null
  let iceServers: RTCIceServer[] = []
  let connectTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    exposeMetrics()
    getOrCreateDeviceId()
    void listPairs().then((p) => {
      pairs = p
    })
    void loadConfig().then((c) => {
      appConfig = c
      iceServers = c.iceServers as RTCIceServer[]
    })
    const path = location.pathname
    const m = path.match(/^\/r\/([a-z0-9]+)$/i)
    if (m) {
      void enterRoom(m[1].toLowerCase(), location.hash.slice(1) || null)
    } else if (location.search.includes('share=1')) {
      void consumeSharedFiles().then((files) => {
        pendingShare = files
        if (files.length) status = `${files.length} shared file(s) ready — start or join a room`
      })
    }
  })

  onDestroy(() => {
    cleanup()
  })

  $effect(() => {
    if ((phase === 'waiting' || phase === 'fallback') && shareUrl && qrCanvas) {
      void renderQr(qrCanvas, shareUrl)
    }
  })

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  function cleanup() {
    if (connectTimer) clearTimeout(connectTimer)
    connectTimer = null
    unsub?.()
    unsub = null
    session = null
    transport?.close()
    transport = null
    signaling?.close()
    signaling = null
  }

  async function startHost() {
    const id = randomRoomId(8)
    const key = await generateRoomKey()
    history.replaceState({}, '', `/r/${id}#${key}`)
    await enterRoom(id, key)
  }

  async function joinWithCode() {
    const id = joinCode.trim().toLowerCase()
    if (id.length < 4) {
      error = 'Enter a room code'
      return
    }
    // Code join without fragment: generate a key (pair must share full URL for E2EE fallback)
    const key = location.hash.slice(1) || (await generateRoomKey())
    history.replaceState({}, '', `/r/${id}#${key}`)
    await enterRoom(id, key)
  }

  async function enterRoom(id: string, keyMaterial: string | null) {
    cleanup()
    roomId = id
    phase = 'waiting'
    status = 'Connecting to signaling…'
    error = ''
    progress = null
    peerCount = 0
    transportMode = 'webrtc'
    remotePeerId = null

    if (!keyMaterial) {
      keyMaterial = await generateRoomKey()
      history.replaceState({}, '', `/r/${id}#${keyMaterial}`)
    }
    roomKey = await importRoomKey(keyMaterial)
    keyFragment = keyMaterial
    shareUrl = `${location.origin}/r/${id}#${keyMaterial}`

    if (!appConfig) {
      appConfig = await loadConfig()
      iceServers = appConfig.iceServers as RTCIceServer[]
    }

    signaling = new SignalingClient(defaultWsUrl())
    try {
      await signaling.connect()
    } catch {
      phase = 'error'
      error = 'Could not reach signaling server'
      return
    }

    unsub = signaling.onMessage((msg) => void onSignal(msg))
    signaling.join(id)
    status = 'In room — scan the QR or share the link'
    peerCount = 1
  }

  async function onSignal(msg: SignalEnvelope) {
    if (msg.type === 'joined') {
      peerCount = msg.connected ?? 1
      if (msg.peers && msg.peers.length > 0) {
        status = 'Peer present — waiting for offer'
      }
      return
    }

    if (msg.type === 'peer-joined' && msg.peerId && signaling) {
      peerCount = msg.connected ?? 2
      remotePeerId = msg.peerId
      status = 'Peer joined — negotiating…'
      startTransport(msg.peerId, true)
      armFallbackTimer()
      return
    }

    if (msg.type === 'signal' && msg.peerId && signaling) {
      const payload = msg.payload as { kind?: string; transferId?: string } | undefined
      if (payload?.kind === 'fallback' && payload.transferId && roomKey) {
        transportMode = 'fallback'
        phase = 'fallback'
        status = 'Receiving via HTTPS fallback…'
        try {
          await fallbackReceive(roomId, roomKey, payload.transferId, (p) => {
            progress = p
          })
        } catch (e) {
          error = e instanceof Error ? e.message : 'fallback receive failed'
        }
        return
      }

      if (!transport) {
        remotePeerId = msg.peerId
        status = 'Receiving offer — negotiating…'
        startTransport(msg.peerId, false)
        armFallbackTimer()
      }
      await transport?.handleSignal(msg)
      return
    }

    if (msg.type === 'peer-left') {
      peerCount = msg.connected ?? 1
      status = 'Peer left — waiting again'
      phase = 'waiting'
      transport?.close()
      transport = null
      session = null
      remotePeerId = null
      return
    }

    if (msg.type === 'error') {
      error = msg.error || 'signaling error'
      phase = 'error'
    }
  }

  function armFallbackTimer() {
    if (connectTimer) clearTimeout(connectTimer)
    if (!appConfig?.fallback) return
    connectTimer = setTimeout(() => {
      if (phase !== 'connected' && phase !== 'fallback') {
        status = 'WebRTC slow — HTTPS fallback available'
      }
    }, 8000)
  }

  function enableFallbackMode() {
    transport?.close()
    transport = null
    session = null
    transportMode = 'fallback'
    phase = 'fallback'
    status = 'HTTPS fallback ready — drop a file (encrypted at rest on server)'
  }

  function startTransport(peerId: string, isOfferer: boolean) {
    if (!signaling) return
    transport?.close()
    transport = new PeerTransport(
      signaling,
      peerId,
      isOfferer,
      {
        onReady: () => {
          if (connectTimer) clearTimeout(connectTimer)
          phase = 'connected'
          transportMode = 'webrtc'
          status = 'Connected — pipe is hot. Drop a file.'
          void rememberPair()
          if (transport) {
            session = new TransferSession(transport, {
              onProgress: (p) => {
                progress = {
                  ...progress,
                  ...p,
                  thumbnailUrl: p.thumbnailUrl ?? progress?.thumbnailUrl,
                }
                if (p.ttfbMs !== null && (p.status === 'sending' || p.status === 'receiving' || p.status === 'done')) {
                  // Record once when TTFB first appears, and again on done.
                  if (p.status === 'done' || p.bytesDone > 0) {
                    recordTransfer({
                      transferId: p.transferId,
                      direction: p.direction,
                      size: p.size,
                      ttfbMs: p.ttfbMs,
                    })
                  }
                }
              },
            })
          }
          if (pendingShare.length && session) {
            const files = pendingShare
            pendingShare = []
            void session.sendFiles(files)
          }
        },
        onControlMessage: (data) => {
          try {
            const msg = JSON.parse(data) as { type?: string; text?: string }
            if (msg.type === 'clipboard' && typeof msg.text === 'string') {
              void writeLocalClipboard(msg.text).then(() => {
                clipboardNote = `Clipboard received (${msg.text!.length} chars)`
              })
              return
            }
          } catch {
            /* fall through */
          }
          session?.handleControl(data)
        },
        onDataMessage: (data) => {
          session?.handleData(data)
        },
        onConnectionState: (s) => {
          if (s === 'failed' || s === 'disconnected') {
            status = 'WebRTC failed — use HTTPS fallback'
          }
        },
        onIceConnectedAt: (ms, path) => {
          recordIce(Math.round(ms), path)
        },
      },
      iceServers,
    )
  }

  async function onFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return
    const list = [...files]
    try {
      if (transportMode === 'fallback' || phase === 'fallback') {
        if (!roomKey || !signaling) throw new Error('not ready')
        // Fallback path: send first file only in M3; multi-file stays on WebRTC for M4.
        const transferId = await fallbackSend(roomId, roomKey, list[0], (p) => {
          progress = p
        })
        signaling.signal({ kind: 'fallback', transferId }, remotePeerId ?? undefined)
        return
      }
      if (!session) return
      await session.sendFiles(list)
    } catch (e) {
      error = e instanceof Error ? e.message : 'send failed'
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    void onFiles(e.dataTransfer?.files ?? null)
  }

  async function rememberPair() {
    if (!roomId || !keyFragment) return
    const deviceId = remotePeerId || 'peer'
    await savePair({
      deviceId,
      label: `Room ${roomId}`,
      roomId,
      keyFragment,
      lastSeen: Date.now(),
    })
    pairs = await listPairs()
  }

  async function reconnectPair(p: PairedDevice) {
    history.replaceState({}, '', `/r/${p.roomId}#${p.keyFragment}`)
    await enterRoom(p.roomId, p.keyFragment)
  }

  async function sendClipboard() {
    if (!transport?.channel || transport.channel.readyState !== 'open') {
      error = 'Not connected'
      return
    }
    try {
      const text = await readLocalClipboard()
      transport.sendControl(
        JSON.stringify({ type: 'clipboard', text, sentAt: Date.now() }),
      )
      clipboardNote = `Clipboard sent (${text.length} chars)`
    } catch (e) {
      error = e instanceof Error ? e.message : 'clipboard failed'
    }
  }
</script>

<main class="shell">
  <header class="brand">
    <a class="wordmark" href="/" aria-label="Chute home">Chute</a>
  </header>

  {#if phase === 'lobby'}
    <section class="intro" aria-labelledby="intro-title">
      <h1 id="intro-title">Move files between your devices.</h1>
      <p>Create a private room, then open it on the other device. No account required.</p>
    </section>

    <section class="panel lobby-actions" aria-label="Start or join a transfer">
      <button class="primary" onclick={() => void startHost()}>Create a room</button>
      <div class="divider"><span>or join a room</span></div>
      <form
        class="join"
        onsubmit={(e) => {
          e.preventDefault()
          void joinWithCode()
        }}
      >
        <input
          bind:value={joinCode}
          aria-label="Room code"
          placeholder="Enter room code"
          maxlength="12"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit">Join</button>
      </form>
      {#if pairs.length}
        <div class="saved">
          <h2>Recent devices</h2>
          <ul class="pairs">
            {#each pairs as p}
              <li>
                <button class="text-button" onclick={() => void reconnectPair(p)}>
                  {p.label}<span aria-hidden="true">→</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  {:else}
    <section class="room-heading" aria-labelledby="room-title">
      <p class="eyebrow">Room</p>
      <h1 id="room-title">{roomId}</h1>
      <p class="status">{status}</p>
    </section>

    {#if phase === 'waiting'}
      <section class="panel qr">
        <canvas bind:this={qrCanvas} aria-label="QR code for this room"></canvas>
        <div class="qr-copy">
          <h2>Open on your other device</h2>
          <p>Scan the code or send this private link.</p>
          <a class="url" href={shareUrl}>{shareUrl}</a>
          {#if peerCount >= 2}
            <button class="secondary" onclick={enableFallbackMode}>Use fallback connection</button>
          {/if}
        </div>
      </section>
    {/if}

    {#if phase === 'connected' || phase === 'fallback'}
      <section
        class="drop"
        class:dragging
        role="button"
        tabindex="0"
        ondragover={(e) => {
          e.preventDefault()
          dragging = true
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInput?.click()
        }}
      >
        <h2>Drop files here</h2>
        <p>They’ll be sent directly to the other device.</p>
        <div class="action-row">
          <button class="secondary" onclick={() => fileInput?.click()}>Choose files</button>
          <button class="secondary" onclick={() => folderInput?.click()}>Choose folder</button>
        </div>
        {#if phase === 'connected'}
          <div class="quiet-actions">
            <button class="text-button" onclick={() => void sendClipboard()}>Send clipboard</button>
            <button class="text-button" onclick={enableFallbackMode}>Use fallback connection</button>
          </div>
        {/if}
        {#if clipboardNote}
          <p class="hint">{clipboardNote}</p>
        {/if}
        <input
          bind:this={fileInput}
          type="file"
          multiple
          hidden
          onchange={() => void onFiles(fileInput?.files ?? null)}
        />
        <input
          bind:this={folderInput}
          type="file"
          multiple
          {...{ webkitdirectory: true } as object}
          hidden
          onchange={() => void onFiles(folderInput?.files ?? null)}
        />
      </section>
    {/if}

    {#if progress}
      <section class="panel progress">
        {#if progress.thumbnailUrl}
          <img class="thumb" src={progress.thumbnailUrl} alt="" />
        {/if}
        <div class="transfer-heading">
          <span class="eyebrow">{progress.direction === 'send' ? 'Sending' : 'Receiving'}</span>
          <strong>{progress.name}</strong>
        </div>
        <div
          class="bar"
          role="progressbar"
          aria-label={`Transfer progress for ${progress.name}`}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress.size ? Math.round((100 * progress.bytesDone) / progress.size) : 0}
        >
          <div
            class="fill"
            style={`width: ${progress.size ? (100 * progress.bytesDone) / progress.size : 0}%`}
          ></div>
        </div>
        <p class="transfer-meta">
          {formatBytes(progress.bytesDone)} of {formatBytes(progress.size)} · {progress.status}
          {#if progress.ttfbMs !== null}
            · <span class="ttfb">TTFB {Math.round(progress.ttfbMs)} ms</span>
          {/if}
        </p>
        {#if progress.hashVerified}
          <p class="hint">BLAKE3 verified</p>
        {/if}
        {#if progress.streamedToDisk}
          <p class="hint">Streamed to disk (File System Access or StreamSaver)</p>
        {/if}
        {#if progress.objectUrls && progress.objectUrls.length > 1}
          <ul class="file-list">
            {#each progress.objectUrls as f}
              <li><a href={f.url} download={f.name}>{f.name}</a></li>
            {/each}
          </ul>
        {:else if progress.objectUrl}
          <a class="download" href={progress.objectUrl} download={progress.name}>Download</a>
        {/if}
      </section>
    {/if}

    {#if error || phase === 'error'}
      <p class="error">{error}</p>
    {/if}
  {/if}
</main>
