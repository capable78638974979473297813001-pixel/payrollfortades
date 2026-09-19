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
- **Hours come only from punches** — the crew creates jobs by typing where the job is at clock-in (`POST /api/clock` find-or-creates the job via `trades/clockTracking.ts`; `workState` defaults to the company's homeState). A double clock-in and a clock-out without an open 'in' are rejected; clock-out pairs with the open punch and writes the WorkedHours entry (`WORKER` classification, quarter-hour rounding). Overtime is never entered — the run derives it from the 40-hour workweek (CA daily rules in California). The owner never enters a job or an hour: the console is read-only tracking, and `run-week` accepts `employeeId` to run the selected worker's paycheck.
- **Real accounts** — `trades/auth.ts` owns signup/login/sessions (scrypt-hashed passwords, server-side session tokens, per-shop join codes) persisted to `trades/.data/auth-db.json` (override: `CREWTALLY_AUTH_DB_DIR`). Session cookie: `crewtally_session`. All `/api/companies/:id/*` routes require a signed-in user of that shop; shop-data writes are owner-only (except the crew's clock-in jobs above); the crew app's `/me` route only serves a worker their own record. `POST /api/demo/seed` signs you in as the demo owner (`demo@crewtally.local`, password `demo`) and RESETS the demo shop's hours (idempotent). Pages: `/login` (= `/signup`) sign-in page, `/me` for workers, `/owner` for owners. Non-demo companies use the current week; the demo company (`shop-1`) keeps the Jan 4–10, 2026 sample week.

## Tests
```bash
docker compose -f docker-compose.base44.yml exec web node --test tests/trades.test.ts tests/trades-features.test.ts
```
