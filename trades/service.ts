import { approvePayRun, type ApprovedPayRun } from '../payroll/run.ts';
import { employeesForCompany, getCompany, getPayRun, saveEmployees, savePayRun } from '../payroll/store.ts';
import type { CertifiedPayrollReport } from './certifiedPayroll.ts';
import {
  buildTradesComplianceReport,
  type TradesComplianceInput,
  type TradesComplianceReport,
} from './compliance.ts';
import type { JobCost, WorkersCompRating } from './jobCosting.ts';
import {
  certifiedPayrollForPeriod,
  draftTradesPayRun,
  jobCostsForPeriod,
  type TradesPayRunInput,
  type TradesPayRunResult,
} from './payRun.ts';
import {
  allWageDeterminations,
  getWorkerProfile,
  jobsForCompany,
  workedHoursForCompanyInRange,
} from './store.ts';
import type { TradeWorkerProfile } from './types.ts';

/**
 * The application service — the layer a UI or an HTTP handler calls. Every
 * function below takes ids and dates, loads the materialized records from the
 * two stores (payroll/store.ts for the company and its people, trades/store.ts
 * for jobs, determinations, profiles and reported hours), and runs one real
 * workflow end to end. It holds no business rules of its own: the arithmetic
 * lives in the engine and the trades layer, the persistence in the stores;
 * this only wires "for company X, this week" to those.
 *
 * This is deliberately the ONE place that reads both stores at once. Keeping
 * the join here — rather than in the pay-run layer — is what lets
 * trades/payRun.ts stay a pure function of its inputs (testable with no I/O),
 * the same separation payroll/run.ts keeps from payroll/store.ts.
 */

export interface TradesRunRequest {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  /** The cheque date — drives which year's tax rules apply and which YTD an approved run rolls into. */
  checkDate: string;
  /** ISO weekday the workweek starts on (0 = Sunday default). */
  weekStartsOn?: number;
  /**
   * Run one worker's pay instead of the whole crew's — the owner picks a
   * worker and runs their paycheck. Absent = everyone with hours.
   */
  employeeId?: string;
}

/** Thrown when a request names a company that isn't in the payroll store. */
export class UnknownCompanyError extends Error {
  readonly companyId: string;
  constructor(companyId: string) {
    super(`No company "${companyId}" in the payroll store — create it before running trades payroll.`);
    this.name = 'UnknownCompanyError';
    this.companyId = companyId;
  }
}

/**
 * Assemble a TradesPayRunInput for a company and period from the stores. Only
 * the wage determinations this company's public jobs actually reference are
 * loaded — not every determination on file — so an unrelated determination
 * for another employer can never collide into this run.
 */
export function loadTradesPayRunInput(req: TradesRunRequest): TradesPayRunInput {
  const company = getCompany(req.companyId);
  if (!company) throw new UnknownCompanyError(req.companyId);

  const employees = employeesForCompany(req.companyId).filter((e) => !req.employeeId || e.id === req.employeeId);
  const profiles = employees
    .map((e) => getWorkerProfile(e.id))
    .filter((p): p is TradeWorkerProfile => p !== null);
  const jobs = jobsForCompany(req.companyId);

  const referencedDeterminationIds = new Set(
    jobs.filter((j) => j.prevailingWage).map((j) => j.prevailingWage!.determinationId),
  );
  const determinations = allWageDeterminations().filter((d) => referencedDeterminationIds.has(d.id));

  const workedHours = workedHoursForCompanyInRange(req.companyId, req.periodStart, req.periodEnd);

  return {
    company,
    employees,
    profiles,
    periodStart: req.periodStart,
    periodEnd: req.periodEnd,
    checkDate: req.checkDate,
    workedHours,
    jobs,
    determinations,
    weekStartsOn: req.weekStartsOn,
  };
}

/** Draft a run for a company and period, persisting the draft PayRun so it can be approved later by id. Returns the full in-memory result (with the prevailing-wage detail the persisted PayRun doesn't carry). */
export function draftWeeklyTradesRun(req: TradesRunRequest): TradesPayRunResult {
  const result = draftTradesPayRun(loadTradesPayRunInput(req));
  savePayRun(result.run);
  return result;
}

/**
 * Approve a previously drafted run by id: roll every paid employee's YTD
 * forward and persist both the updated employees and the approved run. The
 * one committing step — it reads the stored draft, so a draft that was
 * re-drafted (new id) is never approved by accident.
 */
export function approveRunById(runId: string): ApprovedPayRun {
  const run = getPayRun(runId);
  if (!run) throw new Error(`No pay run "${runId}" in the store.`);
  const employees = employeesForCompany(run.companyId);
  const approved = approvePayRun(run, employees);
  saveEmployees(approved.updatedEmployees);
  savePayRun(approved.run);
  return approved;
}

/** The weekly WH-347 certified-payroll reports for a company's public jobs — drafted in memory (no persistence needed to produce a report). Requires a weekly pay frequency, enforced by certifiedPayrollForPeriod. */
export function weeklyCertifiedPayroll(req: TradesRunRequest): CertifiedPayrollReport[] {
  const result = draftTradesPayRun(loadTradesPayRunInput(req));
  return certifiedPayrollForPeriod(result, req.weekStartsOn ?? 0);
}

/** Burdened cost per job for a company and period, given the caller's workers'-comp ratings by class code. */
export function weeklyJobCosts(req: TradesRunRequest, wcRatingsByClassCode: ReadonlyMap<string, WorkersCompRating>): JobCost[] {
  const result = draftTradesPayRun(loadTradesPayRunInput(req));
  return jobCostsForPeriod(result, wcRatingsByClassCode);
}

/**
 * The consolidated compliance report for a company's week — drafts the run,
 * then runs every wage-compliance check. `audits` supplies the facts the run
 * doesn't carry (registered apprenticeship programs, fringe-plan contributions
 * and total annual hours); omit it and the report still returns the prevailing-
 * wage and minimum-wage picture the run always has.
 */
export function weeklyComplianceReport(
  req: TradesRunRequest,
  audits: Pick<TradesComplianceInput, 'apprenticePrograms' | 'fringeAudits'> = {},
): TradesComplianceReport {
  const run = draftTradesPayRun(loadTradesPayRunInput(req));
  return buildTradesComplianceReport({ run, ...audits });
}
