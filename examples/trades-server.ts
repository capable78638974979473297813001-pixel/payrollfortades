import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { dollars } from '../src/money.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import { activeEmployeesFor } from '../payroll/run.ts';
import { employeesForCompany, getCompany, getPayRun, saveCompany, saveEmployee, saveEmployees } from '../payroll/store.ts';
import type { Company, Employee } from '../payroll/types.ts';
import {
  addClockEvent,
  addWorkedHours,
  approveRunById,
  clockEventsForCompanyInRange,
  computeMissingHoursNudges,
  draftWeeklyTradesRun,
  getJob,
  getWorkerProfile,
  jobsForCompany,
  monthlyBill,
  saveJob,
  saveWageDetermination,
  saveWorkerProfile,
  sendNudges,
  verifyClockIn,
  weeklyCertifiedPayroll,
  weeklyComplianceReport,
  weeklyJobCosts,
  workedHoursForCompanyInRange,
  UnknownCompanyError,
  type ClockEvent,
  type GeoPoint,
  type Job,
  type NudgeWorker,
  type TradeWorkerProfile,
  type WageDetermination,
  type WorkedHours,
  type WorkersCompRating,
} from '../trades/index.ts';
import {
  AuthError,
  createSession,
  ensureDemoOwner,
  joinCodeForCompany,
  logIn,
  logOut,
  sessionUserFor,
  signUpOwner,
  signUpWorker,
  type AuthUser,
} from '../trades/auth.ts';

/**
 * Crewtally — the server for the self-serve trades payroll app. A thin JSON
 * HTTP surface over the trades application service (trades/service.ts) plus the
 * crew-facing features (geofenced clock-in, hour-log nudges, seasonal roster,
 * $5/employee billing), and it serves the single-page UI at /. It holds NO
 * business logic: every route parses a request, calls one service or store
 * function, and serializes the result. The prevailing-wage arithmetic,
 * certified payroll, job costing, geofencing and nudges all live in trades/;
 * this file is transport only.
 *
 *   npm run crewtally     (alias: npm run trades:server)
 *   curl -X POST localhost:4325/api/demo/seed         # sample shop + crew + job
 *   curl -X POST localhost:4325/api/companies/shop-1/runs/draft \
 *        -d '{"periodStart":"2026-01-04","periodEnd":"2026-01-10","checkDate":"2026-01-14"}'
 *   curl localhost:4325/api/companies/shop-1/certified-payroll?periodStart=2026-01-04\&periodEnd=2026-01-10\&checkDate=2026-01-14
 */

const PORT = Number(process.env.PORT ?? 4325);
const HERE = dirname(fileURLToPath(import.meta.url));

function sendHtml(res: ServerResponse, file: string): void {
  const html = readFileSync(join(HERE, file));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.byteLength });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

// ---- sessions ----
// Opaque server-side tokens (trades/auth.ts) carried by a plain HttpOnly cookie —
// same-origin here, so the browser sends it on every API call automatically.

const SESSION_COOKIE = 'crewtally_session';

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
function sessionUser(req: IncomingMessage): AuthUser | null {
  const token = cookieValue(req, SESSION_COOKIE);
  return token ? sessionUserFor(token) : null;
}
function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** A demo plumbing shop, one journeyman, one apprentice, a public and a private job, and a week of hours — enough to exercise every route end to end. */
function seedDemo(): { companyId: string; jobIds: string[]; employeeIds: string[] } {
  const company: Company = {
    id: 'shop-1',
    legalName: 'Rooter Bros LLC',
    ein: '74-1234567',
    homeState: 'TX',
    paySchedule: { frequency: 'weekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 },
  };
  const baseEmployee = (id: string, first: string, rate: number): Employee => ({
    id,
    companyId: 'shop-1',
    firstName: first,
    lastName: 'Crew',
    hireDate: '2025-01-01',
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(rate) },
    workersCompClassCode: '5183',
    residenceState: { code: 'TX' },
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: 2026,
  });

  const determination: WageDetermination = {
    id: 'TX20260001',
    authority: 'davis-bacon',
    state: 'TX',
    locality: 'Travis County',
    constructionType: 'building',
    rates: [
      { classificationCode: 'PLUMBER', baseHourlyRateCents: dollars(50), fringePerHourCents: dollars(15), effectiveDate: '2026-01-01' },
      { classificationCode: 'PLUMBER_APPRENTICE', baseHourlyRateCents: dollars(30), fringePerHourCents: dollars(9), effectiveDate: '2026-01-01' },
    ],
  };
  const publicJob: Job = {
    id: 'J1',
    companyId: 'shop-1',
    name: 'Travis County School — building',
    workState: 'TX',
    workLocality: 'Travis County',
    prevailingWage: { determinationId: 'TX20260001', contractNumber: 'DBA-778', projectName: 'Travis County School' },
    workersCompClassCode: '5183',
    glCostCode: '01-100',
    location: { lat: 30.2711, lng: -97.7437, radiusMeters: 200 }, // geofenced job site
  };
  const privateJob: Job = { id: 'J2', companyId: 'shop-1', name: 'Elm St service call', workState: 'TX', workersCompClassCode: '5183', glCostCode: '02-200' };

  saveCompany(company);
  saveEmployees([baseEmployee('joe', 'Joe', 30), baseEmployee('amy', 'Amy', 22)]);
  saveWageDetermination(determination);
  saveJob(publicJob);
  saveJob(privateJob);
  saveWorkerProfile({
    employeeId: 'joe',
    classificationRates: [{ classificationCode: 'PLUMBER', baseRateCents: dollars(40) }],
    fringeCredits: [{ plan: 'Health & Welfare', ratePerHourCents: dollars(5) }],
    employmentType: 'regular',
    phone: '+15125550101',
  });
  saveWorkerProfile({
    employeeId: 'amy',
    classificationRates: [{ classificationCode: 'PLUMBER_APPRENTICE', baseRateCents: dollars(22) }],
    fringeCredits: [],
    employmentType: 'regular',
    phone: '+15125550102',
  });
  // A seasonal helper — no hours logged yet, so the nudge and seasonal-roster
  // features have something to show.
  saveEmployee({ ...baseEmployee('sam', 'Sam', 18), lastName: 'Summers' });
  saveWorkerProfile({ employeeId: 'sam', classificationRates: [], fringeCredits: [], employmentType: 'seasonal', seasonEndDate: '2026-03-31', phone: '+15125550103' });

  addWorkedHours([
    { employeeId: 'joe', jobId: 'J1', date: '2026-01-05', classificationCode: 'PLUMBER', hours: 10 },
    { employeeId: 'joe', jobId: 'J1', date: '2026-01-06', classificationCode: 'PLUMBER', hours: 10 },
    { employeeId: 'joe', jobId: 'J1', date: '2026-01-07', classificationCode: 'PLUMBER', hours: 10 },
    { employeeId: 'joe', jobId: 'J1', date: '2026-01-08', classificationCode: 'PLUMBER', hours: 10 },
    { employeeId: 'joe', jobId: 'J2', date: '2026-01-09', classificationCode: 'SERVICE', hours: 8 },
    { employeeId: 'amy', jobId: 'J1', date: '2026-01-05', classificationCode: 'PLUMBER_APPRENTICE', hours: 8 },
    { employeeId: 'amy', jobId: 'J1', date: '2026-01-06', classificationCode: 'PLUMBER_APPRENTICE', hours: 8 },
  ]);

  return { companyId: 'shop-1', jobIds: ['J1', 'J2'], employeeIds: ['joe', 'amy', 'sam'] };
}

/** A run request built from a query string or a JSON body sharing the same field names. */
function runRequestFrom(companyId: string, source: Record<string, string | undefined>) {
  return {
    companyId,
    periodStart: source.periodStart ?? '',
    periodEnd: source.periodEnd ?? '',
    checkDate: source.checkDate ?? '',
    weekStartsOn: source.weekStartsOn !== undefined ? Number(source.weekStartsOn) : undefined,
  };
}

/** A run summary that's useful over the wire without dumping every resolved entry. Includes the per-worker split-rate / multi-role breakdown (hours and pay by classification), so the same person can show up as, say, plumber AND foreman in one week. */
function summarizeRun(result: ReturnType<typeof draftWeeklyTradesRun>) {
  const roleBreakdown = result.employees
    .filter((e) => e.prevailingWage)
    .map((e) => {
      const byRole = new Map<string, { classification: string; hours: number; grossCents: number }>();
      for (const week of e.prevailingWage!.weeks) {
        for (const entry of week.entries) {
          const r = byRole.get(entry.classificationCode) ?? { classification: entry.classificationCode, hours: 0, grossCents: 0 };
          r.hours += entry.straightHours + entry.overtimeHours + entry.doubleTimeHours;
          r.grossCents += entry.grossCashCents;
          byRole.set(entry.classificationCode, r);
        }
      }
      return { employeeId: e.employee.id, roles: [...byRole.values()].sort((a, b) => b.hours - a.hours) };
    })
    .filter((e) => e.roles.length > 0);

  return {
    runId: result.run.id,
    status: result.run.status,
    checkDate: result.run.checkDate,
    lines: result.run.lines.map((l) => ({ employeeId: l.employeeId, grossPay: l.grossPay, netPay: l.netPay })),
    adjustments: result.employees.flatMap((e) => e.prevailingWage?.adjustments ?? []),
    roleBreakdown,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const params = Object.fromEntries(url.searchParams.entries());

  try {
    // Three front doors: the marketing site, the owner console, the crew app.
    if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/home')) {
      return sendHtml(res, 'trades-landing.html');
    }
    if (method === 'GET' && (path === '/owner' || path === '/app' || path === '/admin')) {
      return sendHtml(res, 'trades-app.html');
    }
    if (method === 'GET' && (path === '/me' || path === '/crew' || path === '/worker')) {
      return sendHtml(res, 'trades-employee.html');
    }
    if (method === 'GET' && (path === '/login' || path === '/signin' || path === '/signup' || path === '/register')) {
      return sendHtml(res, 'trades-login.html');
    }
    if (method === 'POST' && path === '/api/demo/seed') {
      const seed = seedDemo();
      // The demo walks in as the sample shop's owner, so the console works out of the box.
      setSessionCookie(res, createSession(ensureDemoOwner().id));
      return sendJson(res, 200, seed);
    }

    // ---- accounts ----
    if (method === 'POST' && path === '/api/auth/signup') {
      const b = await readJson<{
        email?: string; password?: string; name?: string; role?: string;
        shopName?: string; homeState?: string; ein?: string; joinCode?: string; hourlyRate?: number;
      }>(req);
      const user = b.role === 'worker'
        ? signUpWorker({ email: b.email ?? '', password: b.password ?? '', name: b.name ?? '', joinCode: b.joinCode ?? '', hourlyRate: Number(b.hourlyRate ?? 25) })
        : signUpOwner({ email: b.email ?? '', password: b.password ?? '', name: b.name ?? '', shopName: b.shopName ?? '', homeState: b.homeState, ein: b.ein });
      setSessionCookie(res, createSession(user.id));
      return sendJson(res, 201, { user: { id: user.id, name: user.name, role: user.role, companyId: user.companyId } });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      const b = await readJson<{ email?: string; password?: string }>(req);
      try {
        const user = logIn(b.email ?? '', b.password ?? '');
        setSessionCookie(res, createSession(user.id));
        return sendJson(res, 200, { user: { id: user.id, name: user.name, role: user.role, companyId: user.companyId } });
      } catch (err) {
        if (err instanceof AuthError) return sendJson(res, 401, { error: err.message });
        throw err;
      }
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = cookieValue(req, SESSION_COOKIE);
      if (token) logOut(token);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/auth/me') {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const company = getCompany(user.companyId);
      return sendJson(res, 200, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.companyId, employeeId: user.employeeId ?? null },
        company: company ? { id: company.id, name: company.legalName } : null,
        joinCode: joinCodeForCompany(user.companyId),
        demo: user.companyId === 'shop-1',
      });
    }
    if (method === 'POST' && path === '/api/determinations') {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only the shop owner can change shop data.' });
      const det = await readJson<WageDetermination>(req);
      saveWageDetermination(det);
      return sendJson(res, 201, { ok: true, id: det.id });
    }
    if (method === 'POST' && path === '/api/jobs') {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only the shop owner can change shop data.' });
      const job = await readJson<Job>(req);
      if (job.companyId !== user.companyId) return sendJson(res, 403, { error: 'That job belongs to a different shop.' });
      saveJob(job);
      return sendJson(res, 201, { ok: true, id: job.id });
    }
    if (method === 'POST' && path === '/api/profiles') {
      const profile = await readJson<TradeWorkerProfile>(req);
      saveWorkerProfile(profile);
      return sendJson(res, 201, { ok: true, employeeId: profile.employeeId });
    }
    if (method === 'POST' && path === '/api/hours') {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only the shop owner can change shop data.' });
      const body = await readJson<{ entries: WorkedHours[] }>(req);
      for (const entry of body.entries ?? []) {
        if (getJob(entry.jobId)?.companyId !== user.companyId) return sendJson(res, 403, { error: 'Those hours belong to a different shop.' });
      }
      addWorkedHours(body.entries ?? []);
      return sendJson(res, 201, { ok: true, added: body.entries?.length ?? 0 });
    }

    // Everything under /api/companies/:id/… is that shop's data — served only
    // to a signed-in account OF that shop.
    const shopMatch = path.match(/^\/api\/companies\/([^/]+)(?:\/|$)/);
    if (shopMatch) {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.companyId !== decodeURIComponent(shopMatch[1])) return sendJson(res, 403, { error: 'That shop belongs to a different account.' });
    }

    const jobsMatch = path.match(/^\/api\/companies\/([^/]+)\/jobs$/);
    if (method === 'GET' && jobsMatch) {
      return sendJson(res, 200, { jobs: jobsForCompany(decodeURIComponent(jobsMatch[1])) });
    }

    // Add a worker — regular crew or a seasonal helper. Creates the payroll
    // Employee and the trades profile (per-role rates, phone for nudges) in one
    // call, so the shop can grow its crew from the UI, not just the demo seed.
    if (method === 'POST' && path === '/api/employees') {
      const b = await readJson<{
        companyId?: string; firstName?: string; lastName?: string; hourlyRate?: number; workersCompClassCode?: string;
        phone?: string; employmentType?: 'regular' | 'seasonal'; seasonEndDate?: string; workState?: string;
      }>(req);
      const companyId = (b.companyId ?? '').trim();
      const firstName = (b.firstName ?? '').trim();
      if (!companyId || !firstName || !(Number(b.hourlyRate) > 0)) {
        return sendJson(res, 400, { error: 'companyId, firstName and a positive hourlyRate are required.' });
      }
      if (!getCompany(companyId)) return sendJson(res, 404, { error: `No company "${companyId}".` });
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only the shop owner can add crew.' });
      if (companyId !== user.companyId) return sendJson(res, 403, { error: 'That shop belongs to a different account.' });
      const id = `emp_${randomUUID().slice(0, 8)}`;
      const employee: Employee = {
        id, companyId, firstName, lastName: (b.lastName ?? '').trim() || 'Crew',
        hireDate: new Date().toISOString().slice(0, 10),
        terminationDate: b.employmentType === 'seasonal' ? b.seasonEndDate : undefined,
        employmentCategory: 'standard',
        payType: { kind: 'hourly', hourlyRate: dollars(Number(b.hourlyRate)) },
        workersCompClassCode: b.workersCompClassCode || '5183',
        residenceState: { code: b.workState || 'TX' },
        federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
        deductionPlans: [], directDepositAccounts: [], garnishmentOrders: [],
        ytd: freshYearToDate(), ytdYear: new Date().getUTCFullYear(),
      };
      saveEmployee(employee);
      saveWorkerProfile({ employeeId: id, classificationRates: [], fringeCredits: [], employmentType: b.employmentType ?? 'regular', seasonEndDate: b.seasonEndDate, phone: b.phone });
      return sendJson(res, 201, { ok: true, id });
    }

    const employeesMatch = path.match(/^\/api\/companies\/([^/]+)\/employees$/);
    if (method === 'GET' && employeesMatch) {
      const crew = employeesForCompany(decodeURIComponent(employeesMatch[1])).map((e) => {
        const p = getWorkerProfile(e.id);
        return {
          id: e.id,
          name: `${e.firstName} ${e.lastName}`,
          payType: e.payType.kind,
          hourlyRateCents: e.payType.kind === 'hourly' ? e.payType.hourlyRate : null,
          employmentType: p?.employmentType ?? 'regular',
          seasonEndDate: p?.seasonEndDate ?? null,
          phone: p?.phone ?? null,
        };
      });
      return sendJson(res, 200, { employees: crew });
    }

    const hoursMatch = path.match(/^\/api\/companies\/([^/]+)\/hours$/);
    if (method === 'GET' && hoursMatch) {
      const entries = workedHoursForCompanyInRange(decodeURIComponent(hoursMatch[1]), params.start ?? '', params.end ?? '');
      return sendJson(res, 200, { entries });
    }

    // One worker's own week — what the crew-facing app (/me) needs and nothing
    // more: this employee's hours for the period (with a per-job breakdown),
    // their rate, and a rough gross estimate. A worker never pulls the whole
    // roster's data; this route is scoped to the one person.
    const meMatch = path.match(/^\/api\/companies\/([^/]+)\/employees\/([^/]+)\/me$/);
    if (method === 'GET' && meMatch) {
      const companyId = decodeURIComponent(meMatch[1]);
      const employeeId = decodeURIComponent(meMatch[2]);
      const emp = employeesForCompany(companyId).find((e) => e.id === employeeId);
      if (!emp) return sendJson(res, 404, { error: `No worker "${employeeId}".` });
      // A worker only ever pulls their own week — never a roster-mate's.
      const user = sessionUser(req);
      if (user?.role === 'worker' && user.employeeId !== employeeId) return sendJson(res, 403, { error: 'You can only view your own week.' });
      const profile = getWorkerProfile(employeeId);
      const start = params.start ?? '';
      const end = params.end ?? '';
      const entries = workedHoursForCompanyInRange(companyId, start, end).filter((e) => e.employeeId === employeeId);
      const byJob = new Map<string, { jobId: string; name: string; hours: number }>();
      let totalHours = 0;
      for (const e of entries) {
        totalHours += e.hours;
        const row = byJob.get(e.jobId) ?? { jobId: e.jobId, name: getJob(e.jobId)?.name ?? e.jobId, hours: 0 };
        row.hours += e.hours;
        byJob.set(e.jobId, row);
      }
      const rateCents = emp.payType.kind === 'hourly' ? emp.payType.hourlyRate : null;
      return sendJson(res, 200, {
        employee: {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          firstName: emp.firstName,
          hourlyRateCents: rateCents,
          employmentType: profile?.employmentType ?? 'regular',
          seasonEndDate: profile?.seasonEndDate ?? null,
        },
        week: { start, end, totalHours, jobs: [...byJob.values()].sort((a, b) => b.hours - a.hours) },
        entries: entries.sort((a, b) => a.date.localeCompare(b.date)),
        estimateGrossCents: rateCents != null ? Math.round(totalHours * rateCents) : null,
      });
    }

    // Geofenced clock-in / out: verify the device's coordinates against the
    // job's fence, record the punch (flagged if off-site), and return the check.
    if (method === 'POST' && path === '/api/clock') {
      const b = await readJson<{ companyId?: string; employeeId?: string; jobId?: string; type?: 'in' | 'out'; lat?: number; lng?: number }>(req);
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      if (user.companyId !== b.companyId) return sendJson(res, 403, { error: 'That shop belongs to a different account.' });
      if (user.role === 'worker' && user.employeeId !== b.employeeId) return sendJson(res, 403, { error: 'You can only clock yourself in and out.' });
      const job = b.jobId ? getJob(b.jobId) : null;
      if (!job) return sendJson(res, 404, { error: `No job "${b.jobId}".` });
      const coords: GeoPoint | null = Number.isFinite(b.lat) && Number.isFinite(b.lng) ? { lat: Number(b.lat), lng: Number(b.lng) } : null;
      const check = verifyClockIn(job, coords);
      const event: ClockEvent = {
        id: `clk_${randomUUID().slice(0, 8)}`,
        companyId: b.companyId ?? job.companyId,
        employeeId: b.employeeId ?? '',
        jobId: job.id,
        type: b.type === 'out' ? 'out' : 'in',
        at: new Date().toISOString(),
        coords,
        onSite: check.onSite,
        distanceMeters: check.distanceMeters,
        note: check.note,
      };
      addClockEvent(event);
      return sendJson(res, 201, { event, verification: check });
    }

    const clockMatch = path.match(/^\/api\/companies\/([^/]+)\/clock$/);
    if (method === 'GET' && clockMatch) {
      const day = params.date ?? new Date().toISOString().slice(0, 10);
      return sendJson(res, 200, { events: clockEventsForCompanyInRange(decodeURIComponent(clockMatch[1]), day, day) });
    }

    // The daily 5 PM nudge: who was on the active roster today and logged
    // nothing, plus the reminder each would receive (staged, see nudge.ts).
    const nudgeMatch = path.match(/^\/api\/companies\/([^/]+)\/nudges$/);
    if (method === 'POST' && nudgeMatch) {
      const companyId = decodeURIComponent(nudgeMatch[1]);
      const date = params.date ?? new Date().toISOString().slice(0, 10);
      const active = activeEmployeesFor(getCompany(companyId) ?? ({ id: companyId } as never), employeesForCompany(companyId), date);
      const roster: NudgeWorker[] = active.map((e) => {
        const p = getWorkerProfile(e.id);
        return { employeeId: e.id, name: `${e.firstName} ${e.lastName}`, phone: p?.phone };
      });
      const logged = workedHoursForCompanyInRange(companyId, date, date).map((w) => w.employeeId);
      const candidates = computeMissingHoursNudges(roster, logged, date);
      const results = sendNudges(candidates);
      return sendJson(res, 200, { date, nudged: results });
    }

    const billingMatch = path.match(/^\/api\/companies\/([^/]+)\/billing$/);
    if (method === 'GET' && billingMatch) {
      const companyId = decodeURIComponent(billingMatch[1]);
      const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
      const company = getCompany(companyId);
      const active = company ? activeEmployeesFor(company, employeesForCompany(companyId), asOf) : [];
      return sendJson(res, 200, { asOf, ...monthlyBill(active.length) });
    }

    // One call that runs the whole week: draft (persisted), compliance, certified
    // payroll, and — when a workers'-comp rate is supplied — job costs. This is
    // what the UI's single "Run payroll" button hits.
    const runWeekMatch = path.match(/^\/api\/companies\/([^/]+)\/run-week$/);
    if (method === 'POST' && runWeekMatch) {
      const companyId = decodeURIComponent(runWeekMatch[1]);
      const body = await readJson<Record<string, string>>(req);
      const req0 = runRequestFrom(companyId, body);
      const draft = draftWeeklyTradesRun(req0);
      const compliance = weeklyComplianceReport(req0);
      const certifiedPayroll = weeklyCertifiedPayroll(req0);

      let jobCosts: unknown = null;
      const ratePerHundred = body.wcRatePerHundred !== undefined ? Number(body.wcRatePerHundred) : NaN;
      if (Number.isFinite(ratePerHundred) && ratePerHundred > 0) {
        const experienceMod = body.experienceMod !== undefined ? Number(body.experienceMod) : 1;
        // Apply the shop's single comp rate to every class code its jobs use.
        const classCodes = new Set(
          jobsForCompany(companyId).map((j) => j.workersCompClassCode).filter((c): c is string => Boolean(c)),
        );
        for (const e of employeesForCompany(companyId)) if (e.workersCompClassCode) classCodes.add(e.workersCompClassCode);
        const ratings = new Map<string, WorkersCompRating>(
          [...classCodes].map((code) => [code, { classCode: code, ratePerHundredOfPayrollCents: dollars(ratePerHundred), experienceModificationFactor: experienceMod }]),
        );
        jobCosts = weeklyJobCosts(req0, ratings);
      }

      return sendJson(res, 200, { run: summarizeRun(draft), compliance, certifiedPayroll, jobCosts });
    }

    const draftMatch = path.match(/^\/api\/companies\/([^/]+)\/runs\/draft$/);
    if (method === 'POST' && draftMatch) {
      const body = await readJson<Record<string, string>>(req);
      const result = draftWeeklyTradesRun(runRequestFrom(decodeURIComponent(draftMatch[1]), body));
      return sendJson(res, 200, summarizeRun(result));
    }

    const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
    if (method === 'POST' && approveMatch) {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sign in first.' });
      const run = getPayRun(decodeURIComponent(approveMatch[1]));
      if (!run || run.companyId !== user.companyId) return sendJson(res, 403, { error: 'That run belongs to a different shop.' });
      const approved = approveRunById(decodeURIComponent(approveMatch[1]));
      return sendJson(res, 200, { runId: approved.run.id, status: approved.run.status, employeesUpdated: approved.updatedEmployees.length });
    }

    const cprMatch = path.match(/^\/api\/companies\/([^/]+)\/certified-payroll$/);
    if (method === 'GET' && cprMatch) {
      const reports = weeklyCertifiedPayroll(runRequestFrom(decodeURIComponent(cprMatch[1]), params));
      return sendJson(res, 200, { reports });
    }

    const costsMatch = path.match(/^\/api\/companies\/([^/]+)\/job-costs$/);
    if (method === 'POST' && costsMatch) {
      const body = await readJson<Record<string, string> & { wcRatings?: WorkersCompRating[] }>(req);
      const ratings = new Map((body.wcRatings ?? []).map((r) => [r.classCode, r]));
      const costs = weeklyJobCosts(runRequestFrom(decodeURIComponent(costsMatch[1]), body), ratings);
      return sendJson(res, 200, { jobCosts: costs });
    }

    const complianceMatch = path.match(/^\/api\/companies\/([^/]+)\/compliance$/);
    if (method === 'POST' && complianceMatch) {
      const body = await readJson<Record<string, string> & { apprenticePrograms?: unknown[]; fringeAudits?: unknown[] }>(req);
      const report = weeklyComplianceReport(runRequestFrom(decodeURIComponent(complianceMatch[1]), body), {
        apprenticePrograms: body.apprenticePrograms as never,
        fringeAudits: body.fringeAudits as never,
      });
      return sendJson(res, 200, report);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof UnknownCompanyError) return sendJson(res, 404, { error: err.message });
    return sendJson(res, 400, { error: err instanceof Error ? err.message : 'Request failed.' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Crewtally — time & pay for the trades`);
  console.log(`  Landing page:   http://localhost:${PORT}/`);
  console.log(`  Owner console:  http://localhost:${PORT}/owner`);
  console.log(`  Crew app:       http://localhost:${PORT}/me`);
  console.log(`  (On the landing page, click "See the live demo" to load a sample shop.)\n`);
});
