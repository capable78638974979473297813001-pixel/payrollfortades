/**
 * The check register — every check a shop owes its crew, past and present.
 *
 * A check is DERIVED, never invented: it is one line of a stored PayRun
 * (trades/payRun.ts drafts the calculation, approval commits it), so the
 * register can show every period the shop ever calculated — including ones
 * from before today — without a second copy of the numbers drifting around.
 * There is one check per worker per period: when several runs of the same
 * period exist, the approved run's numbers are the truth (they were signed
 * off and rolled into YTD); otherwise the newest draft wins, and a voided
 * run is never a check at all.
 *
 * What IS stored here is only the thing a derived check can't know by
 * itself: whether the owner has actually PAID it, when, and how (direct
 * deposit or paper check) — keyed by company, employee and period, so a
 * re-drafted run getting a new id never orphans a payment someone recorded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payRunsForCompany } from '../payroll/store.ts';
import type { PayRun } from '../payroll/types.ts';

/** How the money actually moves, as the owner records it. */
export type PaymentMethod = 'direct-deposit' | 'paper-check';

export interface CheckRecord {
  /** `${companyId}:${employeeId}:${periodStart}:${periodEnd}` — stable across re-drafts, which is why payments key on it. */
  id: string;
  runId: string;
  companyId: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  grossPayCents: number;
  netPayCents: number;
  runStatus: PayRun['status'];
  paid: boolean;
  method: PaymentMethod | null;
  paidAt: string | null;
}

/** Resolved lazily on each call — the same override shape every store in this app uses, for tests and isolation. */
function dataDir(): string {
  return process.env.CREWTALLY_CHECKS_DB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data');
}
function dbFile(): string {
  return join(dataDir(), 'checks-db.json');
}
interface CheckDB {
  payments: Record<string, { method: PaymentMethod; paidAt: string }>;
}
function loadDb(): CheckDB {
  try {
    return JSON.parse(readFileSync(dbFile(), 'utf8')) as CheckDB;
  } catch {
    return { payments: {} };
  }
}
function saveDb(db: CheckDB): void {
  if (!existsSync(dataDir())) mkdirSync(dataDir(), { recursive: true });
  writeFileSync(dbFile(), JSON.stringify(db, null, 2));
}
function withDb<T>(fn: (db: CheckDB) => T): T {
  const db = loadDb();
  const out = fn(db);
  saveDb(db);
  return out;
}

export function checkKey(companyId: string, employeeId: string, periodStart: string, periodEnd: string): string {
  return `${companyId}:${employeeId}:${periodStart}:${periodEnd}`;
}

/**
 * The one run per period whose lines are the checks to send: an approved run
 * beats any draft, and among runs of the same status the newest wins.
 */
function governingRuns(runs: PayRun[]): Map<string, PayRun> {
  const byPeriod = new Map<string, PayRun>();
  for (const run of runs) {
    if (run.status === 'voided') continue;
    const key = `${run.periodStart}:${run.periodEnd}`;
    const current = byPeriod.get(key);
    if (
      !current ||
      (run.status === 'approved' && current.status !== 'approved') ||
      (run.status === current.status && run.createdAt > current.createdAt)
    ) {
      byPeriod.set(key, run);
    }
  }
  return byPeriod;
}

/** Every check the shop owes — newest check date first, the register's reading order. */
export function checksForCompany(companyId: string): CheckRecord[] {
  return withDb((db) => {
    const checks: CheckRecord[] = [];
    for (const run of governingRuns(payRunsForCompany(companyId)).values()) {
      for (const line of run.lines) {
        const id = checkKey(companyId, line.employeeId, run.periodStart, run.periodEnd);
        const payment = db.payments[id] ?? null;
        checks.push({
          id,
          runId: run.id,
          companyId,
          employeeId: line.employeeId,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          checkDate: run.checkDate,
          grossPayCents: line.grossPay,
          netPayCents: line.netPay,
          runStatus: run.status,
          paid: payment != null,
          method: payment?.method ?? null,
          paidAt: payment?.paidAt ?? null,
        });
      }
    }
    return checks.sort(
      (a, b) => b.checkDate.localeCompare(a.checkDate) || a.periodStart.localeCompare(b.periodStart) || a.employeeId.localeCompare(b.employeeId),
    );
  });
}

/**
 * Record that a check was paid (with a method) — or that it wasn't, after all
 * (method null). Returns the updated check, or null when no run names that
 * worker for that period, so the caller can answer 404 instead of storing a
 * payment for a check that doesn't exist.
 */
export function setCheckPaid(
  companyId: string,
  employeeId: string,
  periodStart: string,
  periodEnd: string,
  method: PaymentMethod | null,
): CheckRecord | null {
  return withDb((db) => {
    const id = checkKey(companyId, employeeId, periodStart, periodEnd);
    const check = checksForCompany(companyId).find((c) => c.id === id);
    if (!check) return null;
    if (method) db.payments[id] = { method, paidAt: new Date().toISOString() };
    else delete db.payments[id];
    const payment = db.payments[id] ?? null;
    return { ...check, paid: payment != null, method: payment?.method ?? null, paidAt: payment?.paidAt ?? null };
  });
}
