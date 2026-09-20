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

Each browser generates an **Ed25519** device keypair (Web Crypto) stored in IndexedDB.

On connection, peers exchange SPKI public keys and a signed challenge (`pair-hello` / `pair-ack`). Verified peers are saved with fingerprint, room id, and key fragment for one-tap reconnect.

**Revocation:** use **Revoke** on a paired device in the lobby. That fingerprint is stored in a local deny list and will refuse future handshakes from that key. Clearing site data also wipes identity, pairs, and the revoke list.

## What we do not claim

- No protection against a malicious peer you intentionally paired with.
- No anonymity from the signaling operator (they see IPs and timing).
- No integrity guarantees against a MITM on the signaling channel that swaps SDP to a third peer — pin trust to the QR/URL you scanned. Application-level peer auth is a later milestone.
