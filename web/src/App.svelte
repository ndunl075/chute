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

  type Phase = 'lobby' | 'waiting' | 'connected' | 'fallback' | 'error'

  let phase = $state<Phase>('lobby')
  let roomId = $state('')
  let joinCode = $state('')
  let status = $state('Idle')
  let peerCount = $state(0)
  let iceMs = $state<number | null>(null)
  let icePath = $state('')
  let connState = $state('')
  let progress = $state<TransferProgress | null>(null)
  let error = $state('')
  let dragging = $state(false)
  let shareUrl = $state('')
  let transportMode = $state<'webrtc' | 'fallback'>('webrtc')

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
    void loadConfig().then((c) => {
      appConfig = c
      iceServers = c.iceServers as RTCIceServer[]
    })
    const path = location.pathname
    const m = path.match(/^\/r\/([a-z0-9]+)$/i)
    if (m) {
      void enterRoom(m[1].toLowerCase(), location.hash.slice(1) || null)
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
    iceMs = null
    icePath = ''
    progress = null
    peerCount = 0
    transportMode = 'webrtc'
    remotePeerId = null

    if (!keyMaterial) {
      keyMaterial = await generateRoomKey()
      history.replaceState({}, '', `/r/${id}#${keyMaterial}`)
    }
    roomKey = await importRoomKey(keyMaterial)
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
          if (transport) {
            session = new TransferSession(transport, {
              onProgress: (p) => {
                progress = {
                  ...progress,
                  ...p,
                  thumbnailUrl: p.thumbnailUrl ?? progress?.thumbnailUrl,
                }
              },
            })
          }
        },
        onControlMessage: (data) => {
          session?.handleControl(data)
        },
        onDataMessage: (data) => {
          session?.handleData(data)
        },
        onConnectionState: (s) => {
          connState = s
          if (s === 'failed' || s === 'disconnected') {
            status = 'WebRTC failed — use HTTPS fallback'
          }
        },
        onIceConnectedAt: (ms, path) => {
          iceMs = Math.round(ms)
          icePath = path
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
</script>

<main class="shell">
  <header class="brand">
    <h1>Chute</h1>
    <p class="tag">Drop it in. It's already there.</p>
  </header>

  {#if phase === 'lobby'}
    <section class="panel">
      <button class="primary" onclick={() => void startHost()}>Start a transfer</button>
      <div class="or">or join with a code</div>
      <form
        class="join"
        onsubmit={(e) => {
          e.preventDefault()
          void joinWithCode()
        }}
      >
        <input
          bind:value={joinCode}
          placeholder="Room code"
          maxlength="12"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit">Join</button>
      </form>
    </section>
  {:else}
    <section class="panel meta">
      <div class="row">
        <span class="label">Room</span>
        <code>{roomId}</code>
      </div>
      <div class="row">
        <span class="label">Status</span>
        <span>{status}</span>
      </div>
      <div class="row">
        <span class="label">Peers</span>
        <span>{peerCount}/2</span>
      </div>
      <div class="row">
        <span class="label">Path</span>
        <span>{transportMode}{icePath ? ` · ${icePath}` : ''}</span>
      </div>
      {#if iceMs !== null}
        <div class="row highlight">
          <span class="label">ICE ready</span>
          <span>{iceMs} ms</span>
        </div>
      {/if}
      {#if connState}
        <div class="row">
          <span class="label">RTC</span>
          <span>{connState}</span>
        </div>
      {/if}
    </section>

    {#if phase === 'waiting'}
      <section class="panel qr">
        <canvas bind:this={qrCanvas}></canvas>
        <p>Scan with the other device, or open:</p>
        <code class="url">{shareUrl}</code>
        {#if peerCount >= 2}
          <button class="secondary" onclick={enableFallbackMode}>Use HTTPS fallback</button>
        {/if}
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
      >
        <p>Drop files or a folder here</p>
        <button class="secondary" onclick={() => fileInput?.click()}>browse files</button>
        <button class="secondary" onclick={() => folderInput?.click()}>browse folder</button>
        {#if phase === 'connected'}
          <button class="secondary" onclick={enableFallbackMode}>HTTPS fallback</button>
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
        <div class="row">
          <span class="label">{progress.direction === 'send' ? 'Sending' : 'Receiving'}</span>
          <span>{progress.name}</span>
        </div>
        <div class="bar">
          <div
            class="fill"
            style={`width: ${progress.size ? (100 * progress.bytesDone) / progress.size : 0}%`}
          ></div>
        </div>
        <div class="row">
          <span
            >{formatBytes(progress.bytesDone)} / {formatBytes(progress.size)} · {progress.status}</span
          >
          {#if progress.ttfbMs !== null}
            <span class="highlight">TTFB {Math.round(progress.ttfbMs)} ms</span>
          {/if}
        </div>
        {#if progress.streamedToDisk}
          <p class="hint">Saved to disk via File System Access</p>
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
