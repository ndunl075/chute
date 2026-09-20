# Self-hosting Chute

## Docker Compose (signaling + coturn)

```bash
cd deploy
# Point TURN at an address browsers can reach (LAN IP or public IP):
export CHUTE_TURN_URL=turn:YOUR.IP.HERE:3478
docker compose up --build
```

Open `http://localhost:8080`.

### Environment

| Variable | Purpose | Default |
|---|---|---|
| `CHUTE_TURN_URL` | TURN URI(s), comma-separated | unset |
| `CHUTE_TURN_USERNAME` | TURN user | `chute` |
| `CHUTE_TURN_CREDENTIAL` | TURN password | `chute` |
| `CHUTE_STUN_URLS` | STUN URI(s) | Google public STUN |

For public internet, set `external-ip` in `deploy/coturn.conf` to your server's public IP and open UDP 3478 + 49152–49200.

## What the server sees

Signaling sees room membership and SDP/ICE. The HTTPS fallback path stores **opaque ciphertext** only — the AES-GCM key lives in the URL `#fragment` and never leaves the browser.
