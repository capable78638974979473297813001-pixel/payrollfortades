/**
 * Real accounts — signup, login, and sessions for Crewtally.
 *
 * The rest of the app is deliberate about what it invents and what it doesn't;
 * this module holds the one thing a product can never fake: who you are.
 * Passwords are hashed with scrypt (the password itself is never stored),
 * sessions are opaque random tokens kept server-side in the same JSON-file
 * store pattern trades/store.ts uses, and a shop's crew joins via a per-shop
 * join code the owner sees in their console — the same thing an invite link
 * would carry, without the email plumbing a self-hosted app doesn't have.
 *
 * Two roles, two doors: an OWNER signs up and their shop is created with them
 * (they land in the owner console); a WORKER signs up with a shop's join code
 * and is hired into that shop as a new Employee — same record the owner would
 * create, editable by the owner like any hire — and lands in the crew app.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dollars } from '../src/money.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import { getCompany, saveCompany, saveEmployee } from '../payroll/store.ts';
import type { Company, Employee } from '../payroll/types.ts';
import { saveWorkerProfile } from './store.ts';

/** Everything a user can fix in the form — the API maps it to a 400/401 with this message. */
export class AuthError extends Error {}

export interface AuthUser {
  id: string;
  /** Lowercased — the unique login handle. */
  email: string;
  name: string;
  role: 'owner' | 'worker';
  companyId: string;
  /** Set for workers — the shop's Employee record they are. */
  employeeId?: string;
  /** scrypt hash + its own random salt. */
  passwordHash: string;
  salt: string;
  createdAt: string;
}

interface AuthSession {
  userId: string;
  createdAt: string;
}

interface AuthDB {
  users: Record<string, AuthUser>;
  /** Opaque session token -> session. Server-side only; the browser cookie is HttpOnly. */
  sessions: Record<string, AuthSession>;
  /** Join code -> companyId. A worker signs up with the code their owner shares. */
  joinCodes: Record<string, string>;
}

/** Same lazy override shape as trades/store.ts and payroll/store.ts, for tests and isolation. */
function dataDir(): string {
  return process.env.CREWTALLY_AUTH_DB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data');
}
function dbFile(): string {
  return join(dataDir(), 'auth-db.json');
}
function loadDb(): AuthDB {
  try {
    return JSON.parse(readFileSync(dbFile(), 'utf8')) as AuthDB;
  } catch {
    return { users: {}, sessions: {}, joinCodes: {} };
  }
}
function saveDb(db: AuthDB): void {
  if (!existsSync(dataDir())) mkdirSync(dataDir(), { recursive: true });
  writeFileSync(dbFile(), JSON.stringify(db, null, 2));
}
function withDb<T>(fn: (db: AuthDB) => T): T {
  const db = loadDb();
  const out = fn(db);
  saveDb(db);
  return out;
}

// ---- passwords ----

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(user: AuthUser, password: string): boolean {
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

// ---- validation ----

function cleanEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError('Enter a valid email address.');
  return e;
}
function cleanPassword(password: string): string {
  if (password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  return password;
}
function assertEmailFree(db: AuthDB, email: string): void {
  if (Object.values(db.users).some((u) => u.email === email)) {
    throw new AuthError('An account with that email already exists — log in instead.');
  }
}
function newUserId(): string {
  return `usr_${randomUUID().slice(0, 8)}`;
}
function newJoinCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

// ---- lookups & sessions ----

export function userForEmail(email: string): AuthUser | null {
  const e = email.trim().toLowerCase();
  return withDb((db) => Object.values(db.users).find((u) => u.email === e) ?? null);
}

export function sessionUserFor(token: string): AuthUser | null {
  return withDb((db) => {
    const session = db.sessions[token];
    return session ? db.users[session.userId] ?? null : null;
  });
}

export function createSession(userId: string): string {
  const token = randomUUID().replace(/-/g, '') + randomBytes(16).toString('hex');
  withDb((db) => {
    db.sessions[token] = { userId, createdAt: new Date().toISOString() };
  });
  return token;
}

export function logOut(token: string): void {
  withDb((db) => {
    delete db.sessions[token];
  });
}

export function logIn(email: string, password: string): AuthUser {
  const user = userForEmail(email);
  if (!user || !verifyPassword(user, password)) throw new AuthError('Email or password is incorrect.');
  return user;
}

// ---- join codes ----

/** The shop's crew join code — created on first ask, then stable. */
export function joinCodeForCompany(companyId: string): string {
  return withDb((db) => {
    const existing = Object.entries(db.joinCodes).find(([, c]) => c === companyId)?.[0];
    if (existing) return existing;
    const code = newJoinCode();
    db.joinCodes[code] = companyId;
    return code;
  });
}

export function companyForJoinCode(code: string): string | null {
  const c = code.trim().toUpperCase();
  return withDb((db) => db.joinCodes[c] ?? null);
}

// ---- signup ----

export function signUpOwner(input: {
  email: string;
  password: string;
  name: string;
  shopName: string;
  homeState?: string;
  ein?: string;
}): AuthUser {
  const email = cleanEmail(input.email);
  const password = cleanPassword(input.password);
  const name = input.name.trim();
  const shopName = input.shopName.trim();
  if (!name) throw new AuthError('Enter your name.');
  if (!shopName) throw new AuthError("Enter your shop's name.");
  return withDb((db) => {
    assertEmailFree(db, email);
    const companyId = `co_${randomUUID().slice(0, 8)}`;
    const company: Company = {
      id: companyId,
      legalName: shopName,
      ein: (input.ein ?? '').trim() || '00-0000000',
      homeState: (input.homeState ?? '').trim().toUpperCase() || 'TX',
      paySchedule: { frequency: 'weekly', anchorPeriodStart: sundayOf(new Date()), checkDateLagDays: 5 },
    };
    saveCompany(company);
    const salt = randomBytes(16).toString('hex');
    const user: AuthUser = {
      id: newUserId(),
      email,
      name,
      role: 'owner',
      companyId,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    db.users[user.id] = user;
    db.joinCodes[newJoinCode()] = companyId;
    return user;
  });
}

export function signUpWorker(input: {
  email: string;
  password: string;
  name: string;
  joinCode: string;
  hourlyRate: number;
}): AuthUser {
  const email = cleanEmail(input.email);
  const password = cleanPassword(input.password);
  const name = input.name.trim();
  if (!name) throw new AuthError('Enter your name.');
  const companyId = companyForJoinCode(input.joinCode);
  if (!companyId) throw new AuthError('No shop matches that join code — ask your foreman for the code from their console.');
  const rate = Number(input.hourlyRate);
  if (!(rate > 0)) throw new AuthError('Enter your hourly rate.');
  return withDb((db) => {
    assertEmailFree(db, email);
    const shop = getCompany(companyId);
    // Hired into the shop the same way the owner's own "Add a worker" flow does,
    // so the record is one the owner already knows how to edit.
    const id = `emp_${randomUUID().slice(0, 8)}`;
    const employee: Employee = {
      id,
      companyId,
      firstName: name.split(/\s+/)[0],
      lastName: name.split(/\s+/).slice(1).join(' ') || 'Crew',
      hireDate: new Date().toISOString().slice(0, 10),
      employmentCategory: 'standard',
      payType: { kind: 'hourly', hourlyRate: dollars(rate) },
      workersCompClassCode: '5183',
      residenceState: { code: shop?.homeState ?? 'TX' },
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      deductionPlans: [],
      directDepositAccounts: [],
      garnishmentOrders: [],
      ytd: freshYearToDate(),
      ytdYear: new Date().getUTCFullYear(),
    };
    saveEmployee(employee);
    saveWorkerProfile({ employeeId: id, classificationRates: [], fringeCredits: [], employmentType: 'regular' });
    const salt = randomBytes(16).toString('hex');
    const user: AuthUser = {
      id: newUserId(),
      email,
      name,
      role: 'worker',
      companyId,
      employeeId: id,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    db.users[user.id] = user;
    return user;
  });
}

// ---- the demo door ----

/** The "See the live demo" walk-in: the sample shop's owner account, created once and returned so the visitor is signed in as the demo owner. */
export const DEMO_EMAIL = 'demo@crewtally.local';

export function ensureDemoOwner(): AuthUser {
  return withDb((db) => {
    const existing = Object.values(db.users).find((u) => u.email === DEMO_EMAIL);
    if (existing) return existing;
    const salt = randomBytes(16).toString('hex');
    const user: AuthUser = {
      id: newUserId(),
      email: DEMO_EMAIL,
      name: 'Demo Owner',
      role: 'owner',
      companyId: 'shop-1',
      salt,
      passwordHash: hashPassword('demo', salt),
      createdAt: new Date().toISOString(),
    };
    db.users[user.id] = user;
    if (!Object.values(db.joinCodes).includes('shop-1')) db.joinCodes[newJoinCode()] = 'shop-1';
    return user;
  });
}

/** Sunday of the week `d` falls in, ISO yyyy-mm-dd — a new shop's pay-week anchor. */
function sundayOf(d: Date): string {
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  return start.toISOString().slice(0, 10);
}
