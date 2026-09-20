# Security

## Threat model (v1)

Chute moves files between two browsers. The operator of the signaling/TURN/fallback server is **not** trusted with file contents.

| Asset | Protection |
|---|---|
| File bytes (WebRTC) | DTLS on the DataChannel. TURN sees ciphertext only. |
| File bytes (HTTPS fallback) | AES-GCM with a key from the URL `#fragment`. Fragments are not sent to the server. |
| Room membership | Anyone with the room id can join (2-peer cap). Treat room URLs as capabilities. |
| Filenames / sizes | Travel on the DataChannel (or encrypted fallback meta), not in signaling. |

## Room URLs

A room link looks like:

```
https://host/r/{roomId}#{key}
```

- `{roomId}` is the rendezvous handle (server-visible).
- `{key}` is 256-bit key material for fallback encryption (browser-only).

Share the full URL (including the fragment) out of band. Clearing site data removes local resume bitmaps and paired devices.

## Persistent pairing

Paired devices store `roomId` + key fragment in IndexedDB on each browser. Clearing site data is the v1 revocation story.

## What we do not claim

- No protection against a malicious peer you intentionally paired with.
- No anonymity from the signaling operator (they see IPs and timing).
- No integrity guarantees against a MITM on the signaling channel that swaps SDP to a third peer — pin trust to the QR/URL you scanned. Application-level peer auth is a later milestone.
