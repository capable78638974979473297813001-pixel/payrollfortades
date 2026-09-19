import { randomUUID } from 'node:crypto';

import { addWorkedHours, jobsForCompany, saveJob } from './store.ts';
import type { ClockEvent } from './geofence.ts';
import type { Job, WorkedHours } from './types.ts';

/**
 * Clock-in → hours bookkeeping. The crew app's punches are the ONLY source of
 * hours: a worker types where the job is when they clock in (creating the job
 * if it doesn't exist), and clocking out pairs with that open punch and writes
 * the worked-hours entry the payroll run prices. The owner never enters a job
 * or an hour — this module is what "keep track of everything" means.
 *
 * Kept here (not in the HTTP layer) because pairing punches and deriving a
 * timecard is business logic: the server stays transport-only per the project's
 * own rule.
 */

/** The classification auto-tracked hours are booked under. A worker with no role-specific rates prices at their shop rate — the resolver's fallback — and the run still splits overtime weekly. */
export const TRACKED_CLASSIFICATION_CODE = 'WORKER';

/**
 * The worker's open punch, given the shop's recent events in chronological
 * order: the last 'in' with no later 'out'. Null when they're off the clock.
 */
export function findOpenPunch(events: readonly ClockEvent[], employeeId: string): ClockEvent | null {
  let open: ClockEvent | null = null;
  for (const e of events) {
    if (e.employeeId !== employeeId) continue;
    if (e.type === 'in') open = e;
    else open = null;
  }
  return open;
}

/** Elapsed hours between an 'in' and its 'out', rounded to the quarter hour. */
export function punchHours(inPunch: ClockEvent, outPunch: ClockEvent): number {
  const ms = Date.parse(outPunch.at) - Date.parse(inPunch.at);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 4) / 4;
}

/**
 * Close a shift: pair the open 'in' with its 'out' and write the WorkedHours
 * entry the payroll run prices — same job the worker named at clock-in, the
 * day the shift started, hours to the quarter hour. Overtime is NOT entered
 * here; the run derives it from the 40-hour workweek across all entries.
 */
export function recordTrackedHours(inPunch: ClockEvent, outPunch: ClockEvent): WorkedHours {
  const entry: WorkedHours = {
    employeeId: inPunch.employeeId,
    jobId: inPunch.jobId,
    date: inPunch.at.slice(0, 10),
    classificationCode: TRACKED_CLASSIFICATION_CODE,
    hours: punchHours(inPunch, outPunch),
  };
  if (entry.hours > 0) addWorkedHours([entry]);
  return entry;
}

/**
 * The job a worker named at clock-in: the shop's existing job with that name,
 * or a new private job started on the spot. The crew creates jobs from the
 * field — scoped to their own shop, matched case-insensitively so "1420 Elm
 * St kitchen" on Tuesday is the same job as "1420 elm st kitchen" on Friday.
 */
export function findOrCreateJobByName(companyId: string, name: string, workState: string): Job {
  const wanted = name.trim().toLowerCase();
  const existing = jobsForCompany(companyId).find((j) => j.name.trim().toLowerCase() === wanted);
  if (existing) return existing;
  const job: Job = { id: `job_${randomUUID().slice(0, 8)}`, companyId, name: name.trim(), workState };
  saveJob(job);
  return job;
}
