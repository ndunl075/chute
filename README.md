# Chute

**Instant file transfer between any two devices, in the browser.**

Drop it in. It's already there.

Open a page on your laptop. Scan the QR with your phone. Drag a file. It's on the other device.

No app install, no account, no cable, no cloud round-trip for the file bytes (WebRTC). HTTPS fallback encrypts with a key that never leaves the URL fragment.

> Status: **M5 — Make it spread.** PWA + Android Share Target, persistent pairing, clipboard sync, self-host docs.

## Self-host first

```bash
cd deploy
export CHUTE_TURN_URL=turn:YOUR.IP.HERE:3478
docker compose up --build
```

Open `http://localhost:8080`. Details: [docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md) · [docs/SECURITY.md](./docs/SECURITY.md)

## Quick start (dev)

### Prerequisites

- Go 1.22+
- Node 20+

### Signaling server

```bash
cd server
go run .
```

Listens on `:8080` (`/ws`, `/health`, `/api/config`, `/api/fallback/...`).

### Web client

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/ws` and `/api` to the Go server.

### One-binary serve (after build)

```bash
cd web && npm run build
cd ../server && go run . -static ../web/dist
```

## Features

1. **Sub-200ms TTFB** — ICE + DataChannels pre-warm as soon as both peers join
2. **Cross-network** — STUN/TURN racing + encrypted HTTPS fallback
3. **Resumable transfers** — chunk bitmaps in IndexedDB (24h)
4. **Multi-file / folders** — striping across 6 DataChannels
5. **PWA** — installable; Android Share Target posts into Chute
6. **Clipboard sync** — control-channel text under a hard UX budget
7. **Persistent pairing** — reconnect to a remembered room from the lobby

## Architecture

See [CHUTE_ARCHITECTURE.md](./CHUTE_ARCHITECTURE.md) and [protocol/PROTOCOL.md](./protocol/PROTOCOL.md).

## Repo layout

```
server/     Go signaling + fallback store
web/        Svelte client (PWA)
protocol/   shared message notes
deploy/     Docker Compose + coturn
docs/       self-host + security
```

## License

MIT
