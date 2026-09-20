<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { randomRoomId } from './lib/id'
  import { renderQr } from './lib/qr'
  import { SignalingClient, defaultWsUrl } from './lib/signaling'
  import { PeerTransport } from './lib/transport'
  import { TransferSession, type TransferProgress } from './lib/transfer'
  import type { SignalEnvelope } from './lib/protocol'

  type Phase = 'lobby' | 'waiting' | 'connected' | 'error'

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

  let qrCanvas: HTMLCanvasElement | undefined = $state()
  let fileInput: HTMLInputElement | undefined = $state()

  let signaling: SignalingClient | null = null
  let transport: PeerTransport | null = null
  let session: TransferSession | null = null
  let unsub: (() => void) | null = null

  onMount(() => {
    const path = location.pathname
    const m = path.match(/^\/r\/([a-z0-9]+)$/i)
    if (m) {
      void enterRoom(m[1].toLowerCase())
    }
  })

  onDestroy(() => {
    cleanup()
  })

  $effect(() => {
    if (phase === 'waiting' && shareUrl && qrCanvas) {
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
    history.replaceState({}, '', `/r/${id}`)
    await enterRoom(id)
  }

  async function joinWithCode() {
    const id = joinCode.trim().toLowerCase()
    if (id.length < 4) {
      error = 'Enter a room code'
      return
    }
    history.replaceState({}, '', `/r/${id}`)
    await enterRoom(id)
  }

  async function enterRoom(id: string) {
    cleanup()
    roomId = id
    shareUrl = `${location.origin}/r/${id}`
    phase = 'waiting'
    status = 'Connecting to signaling…'
    error = ''
    iceMs = null
    icePath = ''
    progress = null
    peerCount = 0

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
      status = 'Peer joined — negotiating…'
      startTransport(msg.peerId, true)
      return
    }

    if (msg.type === 'signal' && msg.peerId && signaling) {
      if (!transport) {
        status = 'Receiving offer — negotiating…'
        startTransport(msg.peerId, false)
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
      return
    }

    if (msg.type === 'error') {
      error = msg.error || 'signaling error'
      phase = 'error'
    }
  }

  function startTransport(remotePeerId: string, isOfferer: boolean) {
    if (!signaling) return
    transport?.close()
    transport = new PeerTransport(signaling, remotePeerId, isOfferer, {
      onReady: () => {
        phase = 'connected'
        status = 'Connected — pipe is hot. Drop a file.'
        if (transport) {
          session = new TransferSession(transport, {
            onProgress: (p) => {
              progress = { ...progress, ...p, thumbnailUrl: p.thumbnailUrl ?? progress?.thumbnailUrl }
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
      },
      onIceConnectedAt: (ms, path) => {
        iceMs = Math.round(ms)
        icePath = path
      },
    })
  }

  async function onFiles(files: FileList | File[] | null) {
    if (!files || !files.length || !session) return
    try {
      await session.sendFile(files[0])
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
      {#if iceMs !== null}
        <div class="row highlight">
          <span class="label">ICE ready</span>
          <span>{iceMs} ms{icePath ? ` · ${icePath}` : ''}</span>
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
      </section>
    {/if}

    {#if phase === 'connected'}
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
        <p>Drop a file here</p>
        <button class="secondary" onclick={() => fileInput?.click()}>or browse</button>
        <input
          bind:this={fileInput}
          type="file"
          hidden
          onchange={() => void onFiles(fileInput?.files ?? null)}
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
        {#if progress.objectUrl}
          <a class="download" href={progress.objectUrl} download={progress.name}>Download</a>
        {/if}
      </section>
    {/if}

    {#if error || phase === 'error'}
      <p class="error">{error}</p>
    {/if}
  {/if}
</main>
