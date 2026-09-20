# Production TURN

TURN relay bandwidth is the only meaningful cost line. Prefer Hetzner/OVH; avoid AWS/GCP egress.

## Checklist

1. Copy `deploy/coturn.conf` and set:
   - `external-ip=<public-ipv4>`
   - `user=chute:<strong-password>`
2. Export matching env for the chute service:
   ```bash
   export CHUTE_TURN_URL=turn:YOUR.PUBLIC.IP:3478
   export CHUTE_TURN_USERNAME=chute
   export CHUTE_TURN_CREDENTIAL=<strong-password>
   ```
3. Open firewall: UDP+TCP `3478`, UDP `49152-49200`.
4. Deploy with host networking so coturn binds correctly:
   ```bash
   cd deploy
   docker compose up --build -d
   ```
5. Confirm browsers receive TURN in `GET /api/config`.
6. Cap free-tier HTTPS fallback via `CHUTE_FALLBACK_DAILY_BYTES`.

## Local / CI

Use `docker compose -f docker-compose.dev.yml up --build` (bridge networking, weak credentials OK).
