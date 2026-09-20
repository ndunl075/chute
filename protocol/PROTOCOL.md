# Protocol schemas (shared concepts)
# TypeScript lives in web/src/lib/protocol.ts
# Go structs live in server/signal

## Signaling messages (server ↔ client)

| type | direction | fields |
|------|-----------|--------|
| welcome | S→C | peerId |
| join | C→S | room |
| joined | S→C | room, peerId, peers[], connected |
| peer-joined | S→C | peerId, connected |
| peer-left | S→C | peerId, connected |
| signal | both | peerId, target?, payload (SDP/ICE) |
| ping / pong | both | — |
| error | S→C | error |

## DataChannel control messages (peer ↔ peer)

Encrypted by DTLS. Never seen by the signaling server.

| type | purpose |
|------|---------|
| ready | peer connection + channel open; pre-warm complete |
| manifest | transfer metadata before bytes |
| chunk-meta | chunk index + length ahead of binary frame |
| complete | transfer finished |
| abort | cancel |

## Manifest (M1)

```json
{
  "type": "manifest",
  "transferId": "uuid",
  "files": [
    { "id": 0, "name": "file.bin", "size": 1234, "mime": "application/octet-stream" }
  ],
  "chunkSize": 65536,
  "ttfbProbeAt": 0
}
```

Binary frames after manifest: raw chunk bytes in order (single channel in M1).
