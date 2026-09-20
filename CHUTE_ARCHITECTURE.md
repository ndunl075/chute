# Chute — Architecture

**Instant file transfer between any two devices, in the browser, open source.**

Status: post-M5 hardening complete (TTFB soak, BLAKE3, StreamSaver, PDF preview, Ed25519 pairing, metering, TURN, CI, landing)
Owner: Nico Dunlap / Frontier Digital
Last updated: 2026-09-20

---

## 1. What Chute is

Open a page on your laptop. Scan the QR with your phone. Drag a file. It's on the other device.

No app install, no account, no cable, no cloud round-trip, no AirDrop-only-works-between-Apple-devices. Works phone to laptop, iPad to Windows, Android to Mac, laptop to laptop, and in both directions.

**Tagline:** Drop it in. It's already there.

### What Chute is not

- Not a sync tool. No folder mirroring, no conflict resolution, no versioning.
- Not storage. Nothing persists on a server. Rooms are ephemeral.
- Not a format converter. Chute moves bytes. Format awareness is a thin preview layer and nothing more.
- Not an account system. v1 has no login.

---

## 2. Three design constraints, stated up front

These shape every decision below and should be repeated in the README so contributors don't relitigate them.

### 2.1 "Instant" means time-to-first-byte, not throughput

Throughput is a property of the network, not the software. Same Wi-Fi gives 300–900 Mbps of real DataChannel throughput. Across the internet through a relay you get the sender's *upload* bandwidth, typically 10–35 Mbps on US residential. A 200 MB video is ~2 seconds on LAN and ~90 seconds on relay. No architecture changes that.

What Chute controls is the gap between the user releasing the file and the first byte moving. Every competitor in this category burns 3–8 seconds there on discovery, pairing, and ICE negotiation. **Chute's target is under 200 ms**, achieved by having the peer connection fully established before the user has even picked a file.

This is the product. Everything else is table stakes.

### 2.2 "Web based" means a server always exists

A browser cannot do mDNS discovery, cannot bind a listening port, and cannot open a raw socket. Peer discovery on a local network is therefore impossible without a rendezvous point. Chute will always need a signaling server, even when zero file bytes touch it.

The honest framing for the README: *the server knows two devices want to talk; it never sees what they say.*

### 2.3 Format-agnostic by construction

"Supports PDFs, images, slide decks, video" is not a feature list, it's a consequence of moving bytes. The only place format matters is preview generation, which is cosmetic, client-side, and best-effort.

---

## 3. Competitive position

| Tool | Approach | Gap Chute exploits |
|---|---|---|
| PairDrop | Web, WebRTC, room codes | LAN-centric; cross-network is an afterthought; no resume |
| Snapdrop | Web, public-IP auto-grouping | Unmaintained; breaks under CGNAT; no relay path |
| LocalSend | Native app, no server | Requires install on both ends; LAN only by design |
| AirDrop | Native, OS-level | Apple to Apple only |
| Wormhole / WeTransfer | Upload then download link | Full round-trip through cloud; slow; files sit on someone's server |

**Chute's wedge, in priority order:**

1. **Sub-200ms time-to-first-byte** via pre-warmed connections. Nobody does this.
2. **Cross-network is first class**, not a degraded fallback. Same UX whether you're on the same Wi-Fi or on different continents.
3. **Resumable multi-gigabyte transfers.** Chunk-level acks survive tab suspension, Wi-Fi handoff, and screen lock. This is what makes the tool usable for video.
4. **Persistent pairing.** Second and subsequent transfers between known devices require zero interaction.

If Chute ships without at least 1 and 3, it is a PairDrop clone and should not be built.

---

## 4. System overview

```
  ┌──────────────┐                          ┌──────────────┐
  │   Device A   │                          │   Device B   │
  │  (browser)   │                          │  (browser)   │
  └──────┬───────┘                          └───────┬──────┘
         │                                          │
         │  1. WebSocket: join room                 │
         ├──────────────┐            ┌──────────────┤
         │              ▼            ▼              │
         │      ┌────────────────────────┐          │
         │      │   Signaling server     │          │
         │      │   (Go, stateless)      │          │
         │      │   rooms, SDP, ICE      │          │
         │      └────────────────────────┘          │
         │                                          │
         │  2. Race all transport paths in parallel │
         │                                          │
         │  ── local  (host candidates) ──────────► │   fastest
         │  ── direct (srflx / hole punch) ───────► │
         │  ── relay  (TURN / coturn) ────────────► │
         │  ── fallback (HTTPS store-fwd) ────────► │   slowest
         │                                          │
         │  3. File bytes over winning path only    │
         └──────────────────────────────────────────┘
```

---

## 5. Layer 1 — Rendezvous

A stateless Go WebSocket server. Rooms live in memory. Redis pub/sub only if horizontal scaling is needed; a single instance handles a large number of concurrent rooms because it forwards a few kilobytes of SDP and then goes idle.

### Four ways into a room

| Method | Use case | Notes |
|---|---|---|
| **QR code** | Desktop screen, phone camera | Primary path. Room ID in the URL path, E2EE key in the fragment. |
| **4-char code** | Either device types it | For when the camera isn't convenient. Rate-limit and expire aggressively. |
| **Public-IP auto-group** | Two devices on the same network | Convenience only. Breaks under CGNAT and rotating IPv6 — never the sole path. |
| **Persistent pairing** | Repeat transfers | Ed25519 keypair in IndexedDB, auto-rejoins a known room ID on page load. |

### What the server sees

Room membership, SDP offers and answers, ICE candidates, connection timing. It must **never** see filenames, file sizes, file contents, or the E2EE key. Filenames travel inside the encrypted DataChannel as part of the transfer manifest, not in signaling.

### Code sharing with Cue

Cue already implements QR-to-room-to-WebRTC. Extract it:

```
@frontier/rendezvous   ← signaling protocol, room lifecycle, ICE negotiation
   ├── consumed by Cue (closed source product)
   └── consumed by Chute (open source)
```

Separate repos and separate brands. Chute is free and open source with a self-host story; Cue is a $6/month prosumer product. Putting a free OSS tool under a paid SaaS brand poisons both — users distrust that the free thing stays free, and Cue's positioning blurs. Share the code, not the name.

---

## 6. Layer 2 — Transport ladder, raced not cascaded

**The single most important decision in this document.**

The standard approach is sequential: try LAN, wait for timeout, try direct, wait for timeout, fall back to relay. Those timeouts are where the 5 seconds goes.

Chute gathers all ICE candidates and attempts **every path in parallel**. First connection to reach `connected` wins; the rest are torn down immediately.

| Path | Mechanism | Typical throughput | When it wins |
|---|---|---|---|
| Local | WebRTC DataChannel, host candidates | 300–900 Mbps | Same Wi-Fi or Ethernet |
| Direct | STUN + UDP hole punch, srflx candidates | Sender's upload | Different networks, cooperative NAT |
| Relay | TURN via coturn | Sender's upload, minus relay overhead | Symmetric NAT, corporate firewalls |
| Fallback | HTTPS chunked store-and-forward | Slow, server-buffered | Networks blocking UDP entirely |

### Encryption per path

WebRTC DataChannels are DTLS-encrypted end to end. A TURN relay forwards ciphertext it cannot read, so **the relay path is already E2EE with no extra work**. This is worth stating loudly in the README because most users assume relay means the operator can read their files.

The HTTPS fallback path gets none of that for free. It needs explicit application-layer encryption: derive an AES-GCM key from a secret carried in the URL fragment (`#`), which browsers never transmit to the server. Same key material can be used to authenticate the room and prevent a signaling-server operator from silently inserting a third peer.

---

## 7. Layer 3 — The data path

### Chunking and parallelism

- 64 KiB chunks.
- **4–8 parallel DataChannels**, not one. SCTP has head-of-line blocking and a per-channel send buffer; a single channel leaves substantial throughput unused on fast links. Striping chunks across channels is one of the largest single wins available.
- Backpressure via `bufferedAmountLowThreshold`, never a fixed send rate. Fixed rates are wrong on both ends of the spectrum.

### Transfer manifest

Before bytes flow, the sender transmits a manifest over the control channel:

```json
{
  "transferId": "...",
  "files": [
    { "id": 0, "name": "deck.pdf", "size": 4823019, "mime": "application/pdf", "hash": "blake3:..." }
  ]
}
```

Hashing is BLAKE3 in a Web Worker. Content addressing is what makes resume and dedupe possible.

### Receive side

| Environment | Mechanism | Ceiling |
|---|---|---|
| Chromium desktop | File System Access API, streamed straight to disk | Disk size |
| Firefox / other | Service-worker-backed stream (StreamSaver pattern) | Disk size, more fragile |
| iOS Safari | In-memory Blob, then download | ~1–2 GB before the tab dies |

The iOS ceiling is real and unfixable in a web app. Document it honestly rather than letting users discover it with a 4 GB video.

### Resume

- Receiver persists a received-chunk bitmap per `transferId` in IndexedDB.
- On reconnect, receiver sends the bitmap; sender ships only the gaps.
- Resume survives: tab suspension, screen lock, Wi-Fi to cellular handoff, browser restart within the retention window.
- Bitmaps expire after 24 hours.

No competitor does this properly. It is the difference between "cute demo" and "tool I use for real video files."

---

## 8. Layer 4 — Engineering the instant feel

These are not polish. They are the product.

**Pre-warm the connection.** The moment both devices are in the room, negotiate ICE and open all DataChannels. By the time the user has dragged a file over the drop zone, the pipe is hot and TTFB is single-digit milliseconds. This alone beats every competitor.

**Thumbnail first.** Generate a ~200px preview client-side (canvas for images, PDF.js first page for PDFs, video first frame via `<video>` + canvas) and push it ahead of the payload. The receiver sees something within ~50 ms even on a 90-second transfer.

**Small files jump the queue.** Anything under 1 MB sends immediately and interleaves ahead of large transfers, so a screenshot doesn't wait behind a movie.

**Text and clipboard get a dedicated path.** Separate control-channel message type, hard budget of under 100 ms end to end. This will be the most-used feature in practice and it should feel like telepathy.

**Tiny bundle.** Page load time is part of the user's perceived transfer time. Target under 50 KB gzipped. Svelte or Preact, or no framework at all. A 300 KB React bundle silently destroys the entire premise.

**Optimistic UI.** Show the file as "sending" the instant it's dropped, before the manifest round-trip completes.

---

## 9. Layer 5 — Platform reality

### iOS and iPadOS, the hard cases

- No File System Access API. Large receives are memory-bound.
- Safari suspends tabs on screen lock, killing in-flight transfers. Mitigate with the Screen Wake Lock API plus resume-on-reconnect. Cannot be fully solved.
- **No Web Share Target API.** "Share to Chute" from the iOS share sheet is impossible in a PWA. The workaround is an iOS Shortcut, which is a worse experience. Say so in the README instead of pretending.

Worth flagging: building a real iOS share extension requires a Mac, which is not currently available. Plan the roadmap around the web path being the iOS story for the foreseeable future.

### Android

- PWA installable, and **Web Share Target works properly**. Chute can appear in the native share sheet. This is a genuinely strong experience and should be a headline feature on Android.

### Desktop

- Chromium gets the best experience via File System Access.
- Consider a small optional CLI (`chute send ./deck.pdf`) that speaks the same protocol via a headless WebRTC implementation. Good for dev credibility and for server-to-laptop transfers. Post-v1.

---

## 10. Layer 6 — Cost model and sustainability

This is what kills open-source transfer tools, and it belongs in the architecture doc because it constrains the design.

**TURN relay bandwidth is the only meaningful cost**, and the relay path is exactly the one users hit when they aren't on the same network.

- Run coturn on bandwidth-sane infrastructure: Hetzner or OVH. **Never AWS or GCP** — egress pricing there will produce a four-figure bill at modest volume.
- Instrument relay bytes per room per day and cap the free tier.
- Degrade gracefully at the cap: fall back to slower store-and-forward rather than failing outright.
- One environment variable points a self-hoster at their own TURN.

**Distribution strategy is the self-host story.** A single `docker compose up` bringing up signaling plus coturn is the reason people star the repo, fork it, and run it inside companies. Make that the first thing in the README, above the hosted link.

---

## 11. Stack

| Component | Choice | Why |
|---|---|---|
| Signaling | Go, single static binary | Trivial to self-host, low memory, good WebSocket story |
| Room state | In-memory, Redis optional | Rooms are seconds-to-minutes lived |
| TURN | coturn | The only serious option |
| Frontend | Svelte + TypeScript | Bundle size is a product requirement |
| Hashing | BLAKE3 via WASM in a Worker | Fast enough to not block the drop |
| Persistence | IndexedDB | Chunk bitmaps, device keypair, paired devices |
| Deploy | Docker Compose, single file | Self-host is the growth channel |

---

## 12. Repo structure

```
chute/
├── server/              Go signaling server
│   ├── room/            room lifecycle, membership
│   ├── signal/          WebSocket protocol, SDP/ICE relay
│   └── fallback/        HTTPS store-and-forward path
├── web/                 Svelte client
│   ├── transport/       ICE racing, DataChannel pool, backpressure
│   ├── transfer/        manifest, chunking, resume bitmap
│   ├── preview/         thumbnail generation per format
│   └── pair/            QR, code entry, persistent pairing
├── protocol/            shared message schemas (TS + Go codegen)
├── deploy/
│   └── docker-compose.yml   signaling + coturn, one command
└── docs/
    ├── PROTOCOL.md
    ├── SELF_HOSTING.md
    └── SECURITY.md
```

---

## 13. Milestones

**M1 — Prove the premise.** Two browsers, same LAN, QR pairing, single DataChannel, one file, in-memory receive. Goal: measure TTFB and confirm the pre-warm approach actually lands under 200 ms. If it doesn't, stop and reconsider.

**M2 — Make it fast.** Parallel DataChannels, ICE racing, File System Access streaming, thumbnail-first. Goal: saturate a gigabit LAN.

**M3 — Make it work anywhere.** STUN, coturn, HTTPS fallback, cross-network testing on cellular and behind a corporate firewall.

**M4 — Make it reliable.** Chunk bitmaps, resume across disconnect, wake lock, multi-file and folder transfers.

**M5 — Make it spread.** Docker Compose self-host, Android PWA with Share Target, persistent pairing, clipboard sync, README and landing page.

Cut from v1 entirely: accounts, transfer history, folder sync, format conversion, multi-format previews beyond image and PDF first page, e2e encrypted group rooms.

---

## 14. Metrics

| Metric | Why it matters |
|---|---|
| Time from drop to first byte | The product thesis. Target p50 under 200 ms. |
| Transport path distribution | If relay exceeds ~30%, ICE gathering is broken or the STUN set is too small |
| Throughput by path | Validates the parallel-channel work |
| Completion rate by platform | Will expose the iOS suspension problem quantitatively |
| Relay bytes per active user per month | The only real cost line |
| Resume invocations and success rate | Proves M4 was worth building |

---

## 15. Open questions

1. Does public-IP auto-grouping cause more confusion than convenience under modern CGNAT? Possibly ship it off by default.
2. What is the right free-tier relay cap — per room, per IP, per day? Needs real usage data before picking a number.
3. Is a CLI worth building before or after the browser client is solid? Leaning after, but it may be the thing that gets the repo noticed.
4. Does the persistent-pairing keypair need a revocation story in v1, or is clearing site data sufficient?
5. Should folder transfers preserve structure via a manifest, or zip client-side? Zipping is simpler and slower; manifest is better and more code.
