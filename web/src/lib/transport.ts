import type { SignalingClient } from './signaling'
import { DATA_CHANNEL_COUNT, type SignalEnvelope } from './protocol'

export type IcePath = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'

export type TransportEvents = {
  onReady: () => void
  onControlMessage: (data: string) => void
  onDataMessage: (data: ArrayBuffer) => void
  onConnectionState: (state: RTCPeerConnectionState) => void
  onIceConnectedAt: (ms: number, path: IcePath) => void
}

type RaceLane = {
  name: string
  pc: RTCPeerConnection
  control: RTCDataChannel | null
  data: RTCDataChannel[]
  makingOffer: boolean
  connected: boolean
}

/**
 * M2 transport: race multiple PeerConnections in parallel; first to
 * `connected` wins. Winner opens a control channel + N data channels.
 */
export class PeerTransport {
  private lanes: RaceLane[] = []
  private winner: RaceLane | null = null
  private polite: boolean
  private iceConnectedAt: number | null = null
  private startedAt: number
  private readyNotified = false
  private closed = false

  /** Winning control channel (after ready). */
  get channel(): RTCDataChannel | null {
    return this.winner?.control ?? null
  }

  get dataChannels(): RTCDataChannel[] {
    return this.winner?.data.filter((c) => c.readyState === 'open') ?? []
  }

  get pc(): RTCPeerConnection | null {
    return this.winner?.pc ?? null
  }

  constructor(
    private signaling: SignalingClient,
    private remotePeerId: string,
    isOfferer: boolean,
    private events: TransportEvents,
    iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  ) {
    this.polite = !isOfferer
    this.startedAt = performance.now()
    this.iceServers = iceServers

    // Race: all-candidates vs relay-only. First connected wins.
    this.lanes = [
      this.createLane('all', { iceTransportPolicy: 'all' }),
      this.createLane('relay', { iceTransportPolicy: 'relay' }),
    ]

    if (isOfferer) {
      for (const lane of this.lanes) {
        this.setupOffererChannels(lane)
        void this.makeOffer(lane)
      }
    }
  }

  private iceServers: RTCIceServer[]

  private createLane(name: string, config: RTCConfiguration): RaceLane {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...config,
    })

    const lane: RaceLane = {
      name,
      pc,
      control: null,
      data: [],
      makingOffer: false,
      connected: false,
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signaling.signal(
          { kind: 'ice', lane: name, candidate: ev.candidate.toJSON() },
          this.remotePeerId,
        )
      }
    }

    pc.onconnectionstatechange = () => {
      if (this.closed) return
      if (pc.connectionState === 'connected') {
        void this.onLaneConnected(lane)
      }
      if (this.winner === lane) {
        this.events.onConnectionState(pc.connectionState)
      }
    }

    pc.ondatachannel = (ev) => {
      this.bindIncomingChannel(lane, ev.channel)
    }

    return lane
  }

  private setupOffererChannels(lane: RaceLane): void {
    const control = lane.pc.createDataChannel('control', { ordered: true })
    this.bindIncomingChannel(lane, control)
    for (let i = 0; i < DATA_CHANNEL_COUNT; i++) {
      const ch = lane.pc.createDataChannel(`data-${i}`, {
        ordered: false,
        maxRetransmits: 30,
      })
      this.bindIncomingChannel(lane, ch)
    }
  }

  private bindIncomingChannel(lane: RaceLane, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer'
    if (ch.label === 'control' || ch.label.startsWith('control')) {
      lane.control = ch
      ch.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.events.onControlMessage(ev.data)
      }
      ch.onopen = () => this.maybeReady(lane)
    } else {
      lane.data.push(ch)
      ch.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) this.events.onDataMessage(ev.data)
        else if (ev.data instanceof Blob) {
          void ev.data.arrayBuffer().then((b) => this.events.onDataMessage(b))
        }
      }
      ch.onopen = () => this.maybeReady(lane)
    }
  }

  private maybeReady(lane: RaceLane): void {
    if (this.winner !== lane || this.readyNotified) return
    if (!lane.control || lane.control.readyState !== 'open') return
    const openData = lane.data.filter((c) => c.readyState === 'open')
    if (openData.length < DATA_CHANNEL_COUNT) return
    this.readyNotified = true
    lane.control.send(JSON.stringify({ type: 'ready', channels: openData.length }))
    this.events.onReady()
  }

  private async onLaneConnected(lane: RaceLane): Promise<void> {
    if (this.winner || this.closed) return
    lane.connected = true
    this.winner = lane

    if (this.iceConnectedAt === null) {
      this.iceConnectedAt = performance.now() - this.startedAt
      const path = await selectedPath(lane.pc)
      this.events.onIceConnectedAt(this.iceConnectedAt, path)
      this.events.onConnectionState(lane.pc.connectionState)
    }

    // Tear down losers immediately.
    for (const other of this.lanes) {
      if (other === lane) continue
      try {
        other.pc.close()
      } catch {
        /* ignore */
      }
    }

    this.maybeReady(lane)
  }

  private async makeOffer(lane: RaceLane): Promise<void> {
    try {
      lane.makingOffer = true
      await lane.pc.setLocalDescription(await lane.pc.createOffer())
      this.signaling.signal(
        { kind: 'sdp', lane: lane.name, sdp: lane.pc.localDescription },
        this.remotePeerId,
      )
    } finally {
      lane.makingOffer = false
    }
  }

  async handleSignal(msg: SignalEnvelope): Promise<void> {
    const payload = msg.payload as
      | { kind: 'sdp'; lane?: string; sdp: RTCSessionDescriptionInit }
      | { kind: 'ice'; lane?: string; candidate: RTCIceCandidateInit }
      | undefined
    if (!payload) return

    const laneName = payload.lane || 'all'
    const lane = this.lanes.find((l) => l.name === laneName) ?? this.lanes[0]
    if (!lane || lane.pc.connectionState === 'closed') return

    if (payload.kind === 'sdp' && payload.sdp) {
      const offerCollision =
        payload.sdp.type === 'offer' &&
        (lane.makingOffer || lane.pc.signalingState !== 'stable')

      if (offerCollision) {
        if (!this.polite) return
        await lane.pc.setLocalDescription({ type: 'rollback' })
      }

      await lane.pc.setRemoteDescription(payload.sdp)
      if (payload.sdp.type === 'offer') {
        await lane.pc.setLocalDescription(await lane.pc.createAnswer())
        this.signaling.signal(
          { kind: 'sdp', lane: lane.name, sdp: lane.pc.localDescription },
          this.remotePeerId,
        )
      }
      return
    }

    if (payload.kind === 'ice' && payload.candidate) {
      try {
        await lane.pc.addIceCandidate(payload.candidate)
      } catch {
        /* ignore */
      }
    }
  }

  /** Round-robin open data channels for striping. */
  pickDataChannel(i: number): RTCDataChannel | null {
    const open = this.dataChannels
    if (!open.length) return null
    return open[i % open.length]
  }

  sendControl(text: string): void {
    if (this.winner?.control?.readyState === 'open') {
      this.winner.control.send(text)
    }
  }

  close(): void {
    this.closed = true
    for (const lane of this.lanes) {
      try {
        lane.pc.close()
      } catch {
        /* ignore */
      }
    }
    this.winner = null
  }
}

async function selectedPath(pc: RTCPeerConnection): Promise<IcePath> {
  try {
    const stats = await pc.getStats()
    let pair: RTCIceCandidatePairStats | undefined
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded') {
        pair = r as RTCIceCandidatePairStats
      }
    })
    if (!pair?.localCandidateId) return 'unknown'
    let candidateType: string | undefined
    stats.forEach((r) => {
      if (r.id === pair!.localCandidateId && 'candidateType' in r) {
        candidateType = String((r as { candidateType?: string }).candidateType)
      }
    })
    if (
      candidateType === 'host' ||
      candidateType === 'srflx' ||
      candidateType === 'prflx' ||
      candidateType === 'relay'
    ) {
      return candidateType
    }
  } catch {
    /* ignore */
  }
  return 'unknown'
}
