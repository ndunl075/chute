# Chute

**Instant file transfer between any two devices, in the browser.**

Drop it in. It's already there.

Open a page on your laptop. Scan the QR with your phone. Drag a file. It's on the other device.

No app install, no account, no cable, no cloud round-trip for the file bytes.

> Status: **M3 — Make it work anywhere.** STUN/TURN via coturn, ICE config API, encrypted HTTPS store-and-forward fallback.

## Quick start (dev)

### Prerequisites

- Go 1.22+
- Node 20+

### Signaling server

```bash
cd server
go run .
```

Listens on `:8080` (`/ws`, `/health`).

### Web client

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/ws` to the Go server.

### One-binary serve (after build)

```bash
cd web && npm run build
cd ../server && go run . -static ../web/dist
```

Open http://localhost:8080

### Docker (signaling + TURN)

```bash
cd deploy
export CHUTE_TURN_URL=turn:127.0.0.1:3478
docker compose up --build
```

See [docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md).

## How to try M1

1. Open Chute on device A → **Start a transfer**.
2. Scan the QR (or open the `/r/...` URL) on device B.
3. Wait until status says the pipe is hot — note **ICE ready** ms.
4. Drop a file. Note **TTFB** ms (target: under 200 ms once pre-warmed).

## Architecture

See [CHUTE_ARCHITECTURE.md](./CHUTE_ARCHITECTURE.md) and [protocol/PROTOCOL.md](./protocol/PROTOCOL.md).

## Repo layout

```
server/     Go signaling (rooms, SDP/ICE relay)
web/        Svelte client
protocol/   shared message notes
```

## License

MIT (intended) — to be confirmed before public release.
