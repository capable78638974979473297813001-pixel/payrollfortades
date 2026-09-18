# Crewtally — Base44 Dev Environment

## What this is
A self-contained Node.js TypeScript payroll app for construction trades. Runs TypeScript directly (Node 22.18+ type stripping — no build step, no `tsc`, no `node_modules`). File-backed JSON stores under `payroll/.data` and `trades/.data` — no database, no external services.

## Running
```bash
docker compose -f docker-compose.base44.yml up -d
```
Serves on port 3000. The container uses `node --watch` for live reload on file changes.

- Landing page: `/`
- Owner console: `/owner`
- Crew app: `/me`

## Key facts
- **No npm dependencies** — `package.json` has zero deps. Everything uses `node:*` built-in modules and local `.ts` imports.
- **No database** — `payroll/store.ts` and `trades/store.ts` persist to `.data/*.json` files. Override with `PAYROLL_DB_DIR` / `TRADES_DB_DIR` env vars.
- **No external secrets needed** — SMS nudges reference a Twilio carrier but report "not delivered" without one; this is intentional, not a missing config.
- **TypeScript runs natively** — `node examples/trades-server.ts` works because Node 22.18+ strips types automatically. No compilation step.
- The server is transport-only (`examples/trades-server.ts`); all business logic lives in `src/` (tax engine), `payroll/` (payroll layer), and `trades/` (trades-specific features).

## Tests
```bash
docker compose -f docker-compose.base44.yml exec web node --test tests/trades.test.ts tests/trades-features.test.ts
```
