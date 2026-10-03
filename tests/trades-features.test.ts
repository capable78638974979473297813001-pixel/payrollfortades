import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { savePayRun } from '../payroll/store.ts';
import type { PayRunLine } from '../payroll/types.ts';

import {
  checksForCompany,
  computeMissingHoursNudges,
  consoleNudgeSender,
  distanceMeters,
  monthlyBill,
  renderNudgeText,
  sendNudges,
  setCheckPaid,
  verifyClockIn,
  type Job,
  type NudgeWorker,
} from '../trades/index.ts';

// ============================================================================
// Geofenced clock-ins (trades/geofence.ts)
// ============================================================================

describe('geofenced clock-ins (trades/geofence.ts)', () => {
  test('distance is 0 for the same point and ~111 m per 0.001° of latitude', () => {
    assert.equal(distanceMeters({ lat: 30, lng: -97 }, { lat: 30, lng: -97 }), 0);
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 });
    assert.ok(Math.abs(d - 111) <= 1, `expected ~111 m, got ${d}`);
  });

  const fencedJob: Job = { id: 'J1', companyId: 'c', name: 'Site', workState: 'TX', location: { lat: 30, lng: -97.75, radiusMeters: 150 } };

  test('a punch inside the radius is on site; outside is recorded but flagged', () => {
    const inside = verifyClockIn(fencedJob, { lat: 30.0009, lng: -97.75 }); // ~100 m north
    assert.equal(inside.onSite, true);
    assert.ok(inside.distanceMeters !== null && inside.distanceMeters <= 150);

    const outside = verifyClockIn(fencedJob, { lat: 30.005, lng: -97.75 }); // ~556 m north
    assert.equal(outside.onSite, false);
    assert.match(outside.note, /Off site/i);
  });

  test('a job with no geofence, or a punch with no coordinates, is accepted (not flagged)', () => {
    const noFence = verifyClockIn({ ...fencedJob, location: undefined }, { lat: 0, lng: 0 });
    assert.equal(noFence.onSite, true);
    assert.equal(noFence.distanceMeters, null);

    const noCoords = verifyClockIn(fencedJob, null);
    assert.equal(noCoords.onSite, true);
    assert.match(noCoords.note, /unverified/i);
  });
});

// ============================================================================
// Hour-log nudges (trades/nudge.ts)
// ============================================================================

describe('hour-log nudges (trades/nudge.ts)', () => {
  test('the reminder names the worker and the day in plain language', () => {
    const text = renderNudgeText('Joe Pipe', '2026-01-09');
    assert.match(text, /Joe/);
    assert.match(text, /Fri Jan 9/);
    assert.match(text, /Crewtally/);
  });

  test('only active workers who logged nothing that day are nudged', () => {
    const crew: NudgeWorker[] = [
      { employeeId: 'joe', name: 'Joe Pipe', phone: '+15125551000' },
      { employeeId: 'amy', name: 'Amy Wire' },
      { employeeId: 'pat', name: 'Pat Ledger', phone: '+15125552000' },
    ];
    const nudges = computeMissingHoursNudges(crew, ['joe'], '2026-01-09'); // joe already logged
    assert.deepEqual(nudges.map((n) => n.employeeId).sort(), ['amy', 'pat']);
    assert.equal(nudges.find((n) => n.employeeId === 'amy')!.phone, null); // no number on file
  });

  test('the default sender stages the message honestly — never claims delivery', () => {
    const results = sendNudges(computeMissingHoursNudges([{ employeeId: 'pat', name: 'Pat' }], [], '2026-01-09'), consoleNudgeSender);
    assert.equal(results.length, 1);
    assert.equal(results[0].delivered, false);
    assert.match(results[0].via, /no SMS carrier/i);
  });
});

// ============================================================================
// $5 / employee billing (trades/billing.ts)
// ============================================================================

describe('per-employee billing (trades/billing.ts)', () => {
  test('$5 per active employee per month', () => {
    assert.deepEqual(monthlyBill(3), { headcount: 3, perEmployeeCents: 500, totalCents: 1500 });
  });
  test('a zero or negative headcount bills nothing', () => {
    assert.equal(monthlyBill(0).totalCents, 0);
    assert.equal(monthlyBill(-4).totalCents, 0);
  });
});

// ============================================================================
// The check register (trades/checks.ts)
// ============================================================================

describe('the check register (trades/checks.ts)', () => {
  let payrollDir: string;
  let checksDir: string;

  const line = (employeeId: string, grossPay: number, netPay: number): PayRunLine => ({
    employeeId, grossPay, netPay, employeeTaxTotal: 0, employerTaxTotal: 0,
    pretaxDeductions: 0, posttaxDeductions: 0, garnishmentTotal: 0,
    netPayAfterGarnishment: netPay, taxLines: [], garnishmentLines: [], depositAllocations: [],
  });
  const run = (id: string, periodStart: string, periodEnd: string, checkDate: string, status: 'draft' | 'approved', createdAt: string, lines: PayRunLine[]) =>
    ({ id, companyId: 'co_ck', periodStart, periodEnd, checkDate, status, lines, createdAt, minimumWageIssues: [] });

  before(() => {
    payrollDir = mkdtempSync(join(tmpdir(), 'payroll-checks-'));
    checksDir = mkdtempSync(join(tmpdir(), 'checks-store-'));
    process.env.PAYROLL_DB_DIR = payrollDir;
    process.env.CREWTALLY_CHECKS_DB_DIR = checksDir;
    // The same period drafted twice: the approved run's numbers are the truth.
    savePayRun(run('run-a', '2026-01-04', '2026-01-10', '2026-01-14', 'approved', '2026-01-11T00:00:00Z', [line('emp-a', 1000, 800), line('emp-b', 900, 700)]));
    savePayRun(run('run-b', '2026-01-04', '2026-01-10', '2026-01-14', 'draft', '2026-01-12T00:00:00Z', [line('emp-a', 1200, 950)]));
    // A past period — still in the register — and a voided run, which isn't.
    savePayRun(run('run-c', '2025-12-28', '2026-01-03', '2026-01-07', 'draft', '2026-01-04T00:00:00Z', [line('emp-a', 1100, 880)]));
    savePayRun(run('run-d', '2025-12-21', '2025-12-27', '2025-12-31', 'voided', '2025-12-29T00:00:00Z', [line('emp-a', 999, 999)]));
  });
  after(() => {
    delete process.env.PAYROLL_DB_DIR;
    delete process.env.CREWTALLY_CHECKS_DB_DIR;
    rmSync(payrollDir, { recursive: true, force: true });
    rmSync(checksDir, { recursive: true, force: true });
  });

  test('one check per worker per period; the approved run beats a newer draft', () => {
    const checks = checksForCompany('co_ck');
    const week1 = checks.filter((c) => c.periodStart === '2026-01-04');
    assert.deepEqual(week1.map((c) => c.employeeId).sort(), ['emp-a', 'emp-b']);
    assert.equal(week1.find((c) => c.employeeId === 'emp-a')!.netPayCents, 800, 'approved numbers, not the newer draft’s');
    assert.equal(week1.every((c) => c.runId === 'run-a'), true);
  });

  test('past periods still list their checks; a voided run lists none', () => {
    const checks = checksForCompany('co_ck');
    assert.ok(checks.some((c) => c.periodStart === '2025-12-28'), 'a past period’s checks stay in the register');
    assert.ok(!checks.some((c) => c.periodStart === '2025-12-21'), 'a voided run is never a check');
  });

  test('marking a check paid persists — and survives a re-drafted run’s new id', () => {
    const paid = setCheckPaid('co_ck', 'emp-b', '2026-01-04', '2026-01-10', 'paper-check');
    assert.equal(paid?.paid, true);
    assert.equal(paid?.method, 'paper-check');
    assert.equal(checksForCompany('co_ck').find((c) => c.employeeId === 'emp-b' && c.periodStart === '2026-01-04')!.paid, true);
    const unpaid = setCheckPaid('co_ck', 'emp-b', '2026-01-04', '2026-01-10', null);
    assert.equal(unpaid?.paid, false);
  });

  test('a payment for a check no run names is refused', () => {
    assert.equal(setCheckPaid('co_ck', 'emp-a', '2026-02-01', '2026-02-07', 'direct-deposit'), null);
  });
});
