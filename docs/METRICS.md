# Measuring the premise

Architecture target: **p50 time-from-drop-to-first-byte under 200 ms** once both peers have pre-warmed the DataChannel.

## Soak harness

```bash
cd web
npm install
npx playwright install chromium
npm run test:soak
```

This starts the Go signaling server, builds the client, serves it on `:4173`, opens two Chromium contexts, transfers a 512 KiB file, and asserts:

- ICE reaches `connected` (recorded as `lastIceReadyMs`)
- Sender `ttfbMs` **&lt; 200**

Metrics are exposed on `window.__chuteMetrics()` for the test (and manual DevTools checks).
