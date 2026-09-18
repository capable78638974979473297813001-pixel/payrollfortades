# Crewtally — Base44 dev environment

## What this is
A zero-dependency Node 22 TypeScript app (runs TS directly, no build step, no `npm install`). A single HTTP server (`examples/trades-server.ts`) serves a single-page HTML UI at `/` and a JSON API under `/api/`. File-backed storage in `.data/` dirs (gitignored).

## Running
- `docker compose -f docker-compose.base44.yml up -d` — starts on host port 3000 (PORT env set to 3000 inside the container; default is 4325).
- Uses `node --watch` for live reload on file changes.
- No external credentials needed. SMS/Twilio for nudges is optional and degrades gracefully ("not delivered" without a carrier).

## Verifying it works
1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` → 200
2. `curl -X POST http://localhost:3000/api/demo/seed` → seeds a sample plumbing shop
3. In the UI, click "Load the sample plumbing shop" to see the full demo.

## Layout
- `src/` — gross-to-net tax engine
- `payroll/` — pay runs, YTD, time & attendance, file-backed store
- `trades/` — prevailing wage, certified payroll, job costing, geofencing, nudges, billing
- `examples/` — the server + single-page HTML UI
- `data/` — effective-dated tax rules loaded at runtime
- `tests/` — `npm test` runs the trades test suite
