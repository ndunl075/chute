# Chute

**Drop it in. It's already there.**

Instant file transfer between any two devices, in the browser. Open a page, scan a QR, drag a file — peer-to-peer over WebRTC, with an encrypted HTTPS fallback when UDP is blocked.

No app install. No account. No cable. No cloud round-trip for file bytes on the happy path.

## Self-host first

```bash
cd deploy
export CHUTE_TURN_URL=turn:YOUR.IP.HERE:3478
export CHUTE_TURN_CREDENTIAL=your-strong-password
docker compose up --build
```

Open `http://localhost:8080`.

Docs: [SELF_HOSTING](./docs/SELF_HOSTING.md) · [TURN](./docs/TURN.md) · [SECURITY](./docs/SECURITY.md) · [METRICS](./docs/METRICS.md)

## Dev

```bash
# terminal 1
cd server && go run .

# terminal 2
cd web && npm install && npm run dev
```

Prove the premise (TTFB &lt; 200 ms on a hot pipe):

```bash
cd web && npm run test:soak
```

## What you get

| Capability | Detail |
|---|---|
| Sub-200 ms TTFB | Pre-warmed DataChannels; CI soak enforces it |
| Fast path | 6 parallel channels, ICE racing, thumbnails (image/video/PDF) |
| Anywhere | STUN/TURN + AES-GCM HTTPS fallback (key in URL `#fragment`) |
| Reliable | Resume bitmaps, wake lock, multi-file/folders, BLAKE3 verify |
| Spread | PWA + Android Share Target, Ed25519 pairing + revoke, clipboard |

## Architecture

[CHUTE_ARCHITECTURE.md](./CHUTE_ARCHITECTURE.md) · [protocol/PROTOCOL.md](./protocol/PROTOCOL.md)

## License

MIT
