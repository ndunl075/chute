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
| signal | both | peerId, target?, payload (SDP/ICE + lane) |
| ping / pong | both | — |
| error | S→C | error |

Signal payload includes a `lane` (`all` | `relay`) so peers can race PeerConnections.

## DataChannel layout (M2)

- `control` — ordered JSON control messages
- `data-0` … `data-N` — unordered binary chunk frames (N=6)

## Control messages

| type | purpose |
|------|---------|
| ready | channels open; pre-warm complete |
| thumbnail | preview data URL ahead of payload |
| manifest | transfer metadata before bytes |
| complete | sender finished writing all chunks |
| abort | cancel |

## Manifest

```json
{
  "type": "manifest",
  "transferId": "uuid",
  "files": [
    { "id": 0, "name": "file.bin", "size": 1234, "mime": "application/octet-stream" }
  ],
  "chunkSize": 65536,
  "channelCount": 6,
  "dropAt": 0
}
```

## Binary data frame

`u32be chunkIndex` + payload bytes. Striped across data channels by `index % channelCount`.
