import type { SignalingClient } from './signaling'
import type { SignalEnvelope } from './protocol'

export type TransportEvents = {
  onReady: () => void
  onChannelMessage: (data: string | ArrayBuffer) => void
  onConnectionState: (state: RTCPeerConnectionState) => void
  onIceConnectedAt: (ms: number) => void
}

/**
 * M1 transport: single DataChannel, host candidates preferred.
 * Pre-warms as soon as both peers are in the room.
 */
export class PeerTransport {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null = null
  private makingOffer = false
  private polite: boolean
  private iceConnectedAt: number | null = null
  private startedAt: number

  constructor(
    private signaling: SignalingClient,
    private remotePeerId: string,
    /** The peer that was already in the room creates the offer. */
    isOfferer: boolean,
    private events: TransportEvents,
  ) {
    this.polite = !isOfferer
    this.startedAt = performance.now()
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signaling.signal(
          { kind: 'ice', candidate: ev.candidate.toJSON() },
          this.remotePeerId,
        )
      }
    }

    this.pc.onconnectionstatechange = () => {
      this.events.onConnectionState(this.pc.connectionState)
      if (this.pc.connectionState === 'connected' && this.iceConnectedAt === null) {
        this.iceConnectedAt = performance.now() - this.startedAt
        this.events.onIceConnectedAt(this.iceConnectedAt)
      }
    }

    this.pc.ondatachannel = (ev) => {
      this.bindChannel(ev.channel)
    }

    if (isOfferer) {
      const ch = this.pc.createDataChannel('chute', { ordered: true })
      this.bindChannel(ch)
      void this.makeOffer()
    }
  }

  private bindChannel(ch: RTCDataChannel): void {
    this.channel = ch
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => {
      ch.send(JSON.stringify({ type: 'ready' }))
      this.events.onReady()
    }
    ch.onmessage = (ev) => {
      this.events.onChannelMessage(ev.data as string | ArrayBuffer)
    }
  }

  private async makeOffer(): Promise<void> {
    try {
      this.makingOffer = true
      await this.pc.setLocalDescription(await this.pc.createOffer())
      this.signaling.signal(
        { kind: 'sdp', sdp: this.pc.localDescription },
        this.remotePeerId,
      )
    } finally {
      this.makingOffer = false
    }
  }

  async handleSignal(msg: SignalEnvelope): Promise<void> {
    const payload = msg.payload as
      | { kind: 'sdp'; sdp: RTCSessionDescriptionInit }
      | { kind: 'ice'; candidate: RTCIceCandidateInit }
      | undefined
    if (!payload) return

    if (payload.kind === 'sdp' && payload.sdp) {
      const offerCollision =
        payload.sdp.type === 'offer' &&
        (this.makingOffer || this.pc.signalingState !== 'stable')

      if (offerCollision) {
        if (!this.polite) return
        await this.pc.setLocalDescription({ type: 'rollback' })
      }

      await this.pc.setRemoteDescription(payload.sdp)
      if (payload.sdp.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        this.signaling.signal(
          { kind: 'sdp', sdp: this.pc.localDescription },
          this.remotePeerId,
        )
      }
      return
    }

    if (payload.kind === 'ice' && payload.candidate) {
      try {
        await this.pc.addIceCandidate(payload.candidate)
      } catch {
        /* ignore late candidates after close */
      }
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.channel?.readyState !== 'open') return
    if (typeof data === 'string') {
      this.channel.send(data)
    } else {
      this.channel.send(data)
    }
  }

  close(): void {
    this.channel?.close()
    this.pc.close()
  }
}
