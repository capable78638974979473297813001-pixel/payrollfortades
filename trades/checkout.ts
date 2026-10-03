/**
 * Collecting the bill — Stripe Checkout, no SDK, no dependencies.
 *
 * The pricing lives in trades/billing.ts ($5 per active employee per month);
 * this module is only the money-moving half: it opens a Stripe Checkout
 * session for the current bill, verifies the webhook Stripe sends back, and
 * records the receipt in trades/.data/billing-db.json. Credentials come from
 * the environment (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) — when they are
 * absent the feature reports itself as not configured rather than pretending
 * to collect money.
 *
 * Same pattern as trades/checks.ts: the derived thing (the bill) is computed
 * fresh, and only what derivation can't know — the payments actually received
 * — is persisted.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StripeCheckoutInput {
  companyId: string;
  shopName: string;
  ownerEmail?: string;
  headcount: number;
  perEmployeeCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingPayment {
  /** Stripe Checkout session id — the receipt's primary key. */
  sessionId: string;
  companyId: string;
  amountCents: number;
  headcount: number;
  paidAt: string;
  paymentIntentId: string | null;
}

// ---- receipt store ----

/** Resolved lazily on each call — the same override shape every store in this app uses. */
function dataDir(): string {
  return process.env.CREWTALLY_BILLING_DB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data');
}
function dbFile(): string {
  return join(dataDir(), 'billing-db.json');
}
interface BillingDB {
  payments: Record<string, BillingPayment>;
}
function loadDb(): BillingDB {
  try {
    return JSON.parse(readFileSync(dbFile(), 'utf8')) as BillingDB;
  } catch {
    return { payments: {} };
  }
}
function saveDb(db: BillingDB): void {
  if (!existsSync(dataDir())) mkdirSync(dataDir(), { recursive: true });
  writeFileSync(dbFile(), JSON.stringify(db, null, 2));
}
function withDb<T>(fn: (db: BillingDB) => T): T {
  const db = loadDb();
  const out = fn(db);
  saveDb(db);
  return out;
}

// ---- configuration ----

/** The Stripe secret key — absent means "card payments aren't set up yet", not an error to crash on. */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** Where Stripe sends the owner back after the redirect, and where it posts webhooks. */
export function publicOrigin(port: number): string {
  if (process.env.CREWTALLY_PUBLIC_ORIGIN?.trim()) return process.env.CREWTALLY_PUBLIC_ORIGIN.trim();
  if (process.env.BASE44_PUBLIC_HOST_SUFFIX?.trim()) return `https://3000-${process.env.BASE44_PUBLIC_HOST_SUFFIX.trim()}`;
  return `http://localhost:${port}`;
}

// ---- Stripe REST calls over fetch (form-encoded, like the API expects) ----

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Open a Checkout session for this month's bill: one line item, unit price
 * $5/employee × active headcount. The company rides along in
 * client_reference_id and metadata so the webhook can attribute the payment.
 */
export async function createCheckoutSession(input: StripeCheckoutInput): Promise<{ url: string; sessionId: string }> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new BillingNotConfiguredError();
  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const body = formEncode({
    mode: 'payment',
    client_reference_id: input.companyId,
    'line_items[0][quantity]': String(Math.max(1, input.headcount)),
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(input.perEmployeeCents),
    'line_items[0][price_data][product_data][name]': 'Crewtally — time & pay for the trades',
    'line_items[0][price_data][product_data][description]': `${input.shopName}: ${input.headcount} active crew × $${(input.perEmployeeCents / 100).toFixed(2)} — ${month}`,
    'metadata[companyId]': input.companyId,
    'metadata[headcount]': String(input.headcount),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(input.ownerEmail ? { customer_email: input.ownerEmail } : {}),
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = (await res.json()) as { url?: string; id?: string; error?: { message?: string } };
  if (!res.ok || !data.url || !data.id) {
    throw new Error(data.error?.message ?? 'Stripe could not open a checkout session.');
  }
  return { url: data.url, sessionId: data.id };
}

// ---- webhooks ----

/**
 * Verify Stripe's Stripe-Signature header: HMAC-SHA256 over
 * `${timestamp}.${payload}` signed with the webhook secret, inside a 5-minute
 * window. Returns the parsed event, or throws when the signature doesn't
 * belong to Stripe.
 */
export function parseStripeEvent(payload: string, signatureHeader: string | null): { id: string; type: string; data: { object: Record<string, unknown> } } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new BillingNotConfiguredError();
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header.');

  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]));
  const timestamp = parts.t;
  const signatures = signatureHeader.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!timestamp || signatures.length === 0) throw new Error('Malformed Stripe-Signature header.');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('Stripe signature is too old.');

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const ok = signatures.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === a.length && timingSafeEqual(a, b);
  });
  if (!ok) throw new Error('Stripe signature does not match — ignoring this webhook.');

  return JSON.parse(payload) as { id: string; type: string; data: { object: Record<string, unknown> } };
}

/**
 * Record a completed checkout as a receipt. Idempotent: Stripe redelivers
 * webhooks, and the first arrival's timestamp is the one that sticks.
 */
export function recordCompletedCheckout(event: { id: string; type: string; data: { object: Record<string, unknown> } }): BillingPayment | null {
  if (event.type !== 'checkout.session.completed') return null;
  const session = event.data.object;
  const sessionId = String(session.id ?? event.id);
  if (!sessionId) return null;
  return withDb((db) => {
    if (db.payments[sessionId]) return db.payments[sessionId];
    const meta = (session.metadata ?? {}) as Record<string, string>;
    const payment: BillingPayment = {
      sessionId,
      companyId: String(meta.companyId ?? session.client_reference_id ?? ''),
      amountCents: Number(session.amount_total ?? 0),
      headcount: Number(meta.headcount ?? 0),
      paidAt: new Date().toISOString(),
      paymentIntentId: session.payment_intent ? String(session.payment_intent) : null,
    };
    if (!payment.companyId) return null; // nothing to attribute the money to
    db.payments[sessionId] = payment;
    return payment;
  });
}

/** Every payment this shop has made, newest first. */
export function paymentsForCompany(companyId: string): BillingPayment[] {
  return Object.values(loadDb().payments)
    .filter((p) => p.companyId === companyId)
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
}

/** The error the routes turn into a plain-language 503, never a crash. */
export class BillingNotConfiguredError extends Error {
  constructor() {
    super('Card payments aren’t set up yet — add your Stripe keys and they will be.');
    this.name = 'BillingNotConfiguredError';
  }
}
