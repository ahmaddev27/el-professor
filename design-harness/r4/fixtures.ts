/**
 * Design remake, batch R4: invented data for the platform panel (AdminLayout).
 *
 * The panel talks to the database through audited read models (RPCs answering
 * `{ ok: true, items, total, … }`) and, for a few lists, straight to tables
 * (`companies`, `subscription_plans`, the three code tables). This file answers
 * both for the r4 screens only and is empty on every other batch's. The session
 * is an `owner` platform account with every capability (fakes/SuperAdminContext).
 *
 * Nothing here is a real person, address or company: addresses are @example.com,
 * the companies are fictional. Dates are fixed around the capture clock
 * (Monday 14.09.2026).
 */
import type { Row } from '../fixtures';
import { HARNESS_USER_ID } from '../scenario';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK } from '../../src/lib/appConfigSeed';

export type R4Screen =
  | 'r4-dashboard' | 'r4-companies' | 'r4-billing' | 'r4-team' | 'r4-audit'
  | 'r4-directories' | 'r4-settings' | 'r4-plans' | 'r4-abnahme';

const SCREENS: readonly string[] = [
  'r4-dashboard', 'r4-companies', 'r4-billing', 'r4-team', 'r4-audit',
  'r4-directories', 'r4-settings', 'r4-plans', 'r4-abnahme',
];
const requested = new URLSearchParams(window.location.search).get('screen');
export const r4Screen: R4Screen | null = SCREENS.includes(requested ?? '') ? (requested as R4Screen) : null;

type RpcAnswer = { data: unknown; error: null };
const ok = (data: unknown): RpcAnswer => ({ data, error: null });

// ── Companies ───────────────────────────────────────────────────────────────
const cid = (n: number) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`;

interface CompanySpec {
  n: number; name: string; city: string; plan: 'basic' | 'advanced' | 'premium';
  status: string; approval: string; subscription: string; expires: string | null;
  users: number; drivers: number; vehicles: number; created: string; reason?: string; referral?: string;
}

const COMPANIES: CompanySpec[] = [
  { n: 1, name: 'Taxi Rheinblick GmbH', city: 'Köln', plan: 'premium', status: 'active', approval: 'approved', subscription: 'active', expires: null, users: 6, drivers: 14, vehicles: 9, created: '2026-01-12T09:00:00Z' },
  { n: 2, name: 'Mietwagen Nordstern UG', city: 'Hamburg', plan: 'advanced', status: 'active', approval: 'approved', subscription: 'active', expires: '2026-09-30T00:00:00Z', users: 3, drivers: 7, vehicles: 5, created: '2026-03-02T10:30:00Z' },
  { n: 3, name: 'Funk-Taxi Südpfalz e.K.', city: 'Landau', plan: 'basic', status: 'active', approval: 'approved', subscription: 'active', expires: '2027-03-01T00:00:00Z', users: 2, drivers: 4, vehicles: 3, created: '2026-04-18T08:15:00Z', referral: 'FRUEHJAHR26' },
  { n: 4, name: 'Stadtfahrten Elbe GmbH', city: 'Dresden', plan: 'advanced', status: 'suspended', approval: 'approved', subscription: 'expired', expires: '2026-08-15T00:00:00Z', users: 4, drivers: 9, vehicles: 6, created: '2026-02-09T14:00:00Z' },
  { n: 5, name: 'Beispiel Mobil GmbH', city: 'Leipzig', plan: 'basic', status: 'inactive', approval: 'pending', subscription: 'inactive', expires: null, users: 1, drivers: 0, vehicles: 0, created: '2026-09-11T16:45:00Z' },
  { n: 6, name: 'Taxi Bergblick GmbH & Co. KG', city: 'Freiburg', plan: 'basic', status: 'inactive', approval: 'rejected', subscription: 'inactive', expires: null, users: 1, drivers: 0, vehicles: 0, created: '2026-08-21T11:20:00Z', reason: 'Gewerbenachweis fehlt' },
  { n: 7, name: 'Alte Fuhrbetriebe GmbH', city: 'Bremen', plan: 'basic', status: 'archived', approval: 'approved', subscription: 'expired', expires: '2026-02-28T00:00:00Z', users: 2, drivers: 3, vehicles: 2, created: '2025-11-03T09:00:00Z' },
  { n: 8, name: 'Kurier & Chauffeur Mitte GmbH', city: 'Kassel', plan: 'advanced', status: 'active', approval: 'approved', subscription: 'active', expires: '2027-01-15T00:00:00Z', users: 5, drivers: 11, vehicles: 8, created: '2026-05-27T13:10:00Z' },
];

function companyRows(): Row[] {
  return COMPANIES.map(c => ({
    id: cid(c.n),
    name: c.name,
    slug: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    legal_name: c.name,
    email: `kontakt@firma${c.n}.example.com`,
    phone: `+49 30 5550${c.n}00`,
    address: `Musterstraße ${c.n * 3}`,
    city: c.city,
    postal_code: `${10000 + c.n * 4321}`,
    country: 'Deutschland',
    logo_url: null,
    status: c.status,
    approval_status: c.approval,
    rejection_reason: c.reason ?? null,
    plan: c.plan,
    billing_cycle: c.n % 3 === 0 ? 'yearly' : 'monthly',
    subscription_car_limit: Math.max(3, c.vehicles),
    referral_code_used: c.referral ?? null,
    subscription_status: c.subscription,
    subscription_expires_at: c.expires,
    subscription_started_at: c.subscription === 'inactive' ? null : c.created,
    subscription_duration_type: c.expires ? '1_jahr' : null,
    created_at: c.created,
    updated_at: c.created,
  }));
}

function companyReadModel(): Row[] {
  return COMPANIES.map(c => ({
    id: cid(c.n), name: c.name, slug: null, status: c.status, approval_status: c.approval, plan: c.plan,
    trial_state: null, subscription_status: c.subscription, subscription_expires_at: c.expires,
    open_invoice_count: c.n === 2 ? 1 : c.n === 4 ? 2 : 0, overdue_invoice_count: c.n === 4 ? 1 : 0,
    user_count: c.users, active_driver_count: c.drivers, active_vehicle_count: c.vehicles,
    drivers_per_car_limit: c.n % 2 === 0 ? 4 : null,
  }));
}

// ── Billing ─────────────────────────────────────────────────────────────────
const PLAN_PRICE: Record<string, number> = { basic: 59, advanced: 119, premium: 249 };
const planId = (plan: string) => `r4-plan-${plan}`;
const PLAN_NAME: Record<string, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };

type InvoiceSpec = [n: number, status: string, due: string, paidAt: string | null, cash: number | null, note: string | null];
const INVOICES: InvoiceSpec[] = [
  [1, 'paid', '2026-09-10', '2026-09-08T10:12:00Z', null, null],
  [2, 'open', '2026-09-30', null, null, null],
  [3, 'paid', '2026-09-10', '2026-09-12T15:40:00Z', 59, 'Bar im Büro bezahlt'],
  [4, 'open', '2026-09-05', null, null, null],
  [5, 'canceled', '2026-09-10', null, null, 'Stornierung auf Kundenwunsch'],
  [8, 'open', '2026-09-20', null, null, null],
];

function invoiceRows(): Row[] {
  return INVOICES.map(([n, status, due, paidAt, cash, note]) => {
    const company = COMPANIES.find(c => c.n === n)!;
    return {
      id: `r4-inv-${n}`, company_id: cid(n), company_name: company.name,
      company_address: `Musterstraße ${n * 3}`, company_postal_code: `${10000 + n * 4321}`, company_city: company.city,
      plan_name: PLAN_NAME[company.plan], invoice_month: 9, invoice_year: 2026,
      invoice_number: `INV-2026-${String(n).padStart(4, '0')}`, amount: PLAN_PRICE[company.plan],
      status, due_date: due, paid_at: paidAt, cash_received_amount: cash, receipt_note: note,
      created_at: '2026-09-01T06:00:00Z',
    };
  });
}

function subscriptionRows(): Row[] {
  return COMPANIES.filter(c => c.n !== 5 && c.n !== 6).map(c => ({
    id: `r4-sub-${c.n}`, company_id: cid(c.n), company_name: c.name, plan_id: planId(c.plan), plan_name: PLAN_NAME[c.plan],
    status: c.n === 7 ? 'cancelled' : c.n === 4 ? 'paused' : 'active', starts_at: c.created.slice(0, 10),
    billing_day: 1 + (c.n % 5), monthly_price: PLAN_PRICE[c.plan],
  }));
}

function subscriptionPlanTable(): Row[] {
  return (['basic', 'advanced', 'premium'] as const).map(plan => ({
    id: planId(plan), name: PLAN_NAME[plan], monthly_price: PLAN_PRICE[plan],
    included_cars: plan === 'basic' ? 3 : plan === 'advanced' ? 8 : 20, drivers_per_car_limit: 4,
    features_json: {}, is_active: true,
  }));
}

// ── Codes ───────────────────────────────────────────────────────────────────
function discountCodes(): Row[] {
  return [
    { id: 'r4-dc-1', code: 'HERBST15', description: 'Herbstaktion, 15 % im ersten Jahr', discount_type: 'percentage', discount_value: 15, usage_mode: 'once', audience_type: 'multiple', max_redemptions: 50, used_count: 12, valid_from: '2026-09-01', valid_until: '2026-11-30', active: true, applies_to_plan: 'all', applies_to_billing_cycle: 'yearly', min_cars: null, max_cars: null, assigned_company_id: null, created_at: '2026-08-28T09:00:00Z', updated_at: '2026-08-28T09:00:00Z' },
    { id: 'r4-dc-2', code: 'NORDSTERN-20', description: 'Individueller Nachlass', discount_type: 'fixed', discount_value: 20, usage_mode: 'monthly', audience_type: 'single', max_redemptions: null, used_count: 3, valid_from: null, valid_until: null, active: true, applies_to_plan: 'advanced', applies_to_billing_cycle: 'all', min_cars: 3, max_cars: 10, assigned_company_id: cid(2), created_at: '2026-06-14T12:00:00Z', updated_at: '2026-06-14T12:00:00Z' },
    { id: 'r4-dc-3', code: 'START2025', description: 'Abgelaufene Startaktion', discount_type: 'percentage', discount_value: 10, usage_mode: 'once', audience_type: 'multiple', max_redemptions: 100, used_count: 100, valid_from: '2025-10-01', valid_until: '2025-12-31', active: false, applies_to_plan: 'all', applies_to_billing_cycle: 'all', min_cars: null, max_cars: null, assigned_company_id: null, created_at: '2025-09-20T08:00:00Z', updated_at: '2026-01-02T08:00:00Z' },
  ];
}

function referralCodes(): Row[] {
  return [
    { id: 'r4-rf-1', ref_code: 'FRUEHJAHR26', name: 'Frühjahrsmesse 2026', description: 'Messestand Hannover', is_active: true, created_at: '2026-03-10T09:00:00Z' },
    { id: 'r4-rf-2', ref_code: 'PARTNER-NORD', name: 'Partnerverband Nord', description: null, is_active: true, created_at: '2026-05-02T09:00:00Z' },
    { id: 'r4-rf-3', ref_code: 'ALT2025', name: 'Kampagne 2025', description: 'Beendet', is_active: false, created_at: '2025-10-05T09:00:00Z' },
  ];
}

function activationCodes(): Row[] {
  const base = { custom_days: null, custom_expires_at: null, deleted_at: null, hidden_at: null, hidden_reason: null, revoked_at: null, used_at: null, used_company_id: null, target_email: null, company_id: null };
  return [
    { ...base, id: 'r4-ac-1', code_last4: '7K2F', company_id: cid(2), target_email: 'inhaber@firma2.example.com', duration_type: '1_jahr', expires_at: '2026-09-14T10:02:00Z', status: 'active', created_at: '2026-09-14T09:59:00Z' },
    { ...base, id: 'r4-ac-2', code_last4: 'Q9XD', company_id: cid(3), duration_type: '3_monate', expires_at: '2026-09-02T12:02:00Z', status: 'used', used_at: '2026-09-02T12:00:00Z', used_company_id: cid(3), created_at: '2026-09-02T11:58:00Z' },
    { ...base, id: 'r4-ac-3', code_last4: 'B4LM', company_id: cid(8), duration_type: '1_monat', expires_at: '2026-08-20T08:02:00Z', status: 'expired', created_at: '2026-08-20T08:00:00Z' },
    { ...base, id: 'r4-ac-4', code_last4: 'W3TR', company_id: cid(4), duration_type: 'benutzerdefiniert', custom_days: 45, expires_at: '2026-08-11T09:02:00Z', status: 'revoked', revoked_at: '2026-08-11T09:01:00Z', created_at: '2026-08-11T09:00:00Z' },
  ];
}

// ── Directories ─────────────────────────────────────────────────────────────
const ACTIVE = COMPANIES.filter(c => c.vehicles > 0);

function vehicleRows(): Row[] {
  const rows: Row[] = [];
  ACTIVE.forEach(c => {
    for (let i = 0; i < Math.min(c.vehicles, 3); i += 1) {
      rows.push({
        id: `r4-v-${c.n}-${i}`, company_id: cid(c.n), company_name: c.name,
        kennzeichen: `${c.city.slice(0, c.city.length > 2 ? 2 : 1).toUpperCase()}-TX ${c.n}${i}0${i + 1}`,
        status: (c.n + i) % 5 === 0 ? 'inactive' : 'active',
        tuev_gueltig_bis: `2027-0${1 + ((c.n + i) % 8)}-15`, letzte_hu: `2025-0${1 + ((c.n + i) % 8)}-15`,
        created_at: `2026-0${1 + (i % 6)}-1${i}T09:00:00Z`,
      });
    }
  });
  return rows;
}

const DRIVER_NAMES = ['Lena Hartmann', 'Tobias Kessler', 'Selin Aydın', 'Marek Zielinski', 'Birgit Sandmann', 'Florian Wegener', 'Nadia Rahimi', 'Jonas Brandt', 'Clara Neumann', 'Dennis Vogel'];

function driverRows(): Row[] {
  return DRIVER_NAMES.map((name, i) => {
    const c = ACTIVE[i % ACTIVE.length];
    return {
      id: `r4-d-${i}`, company_id: cid(c.n), company_name: c.name, name,
      status: i % 7 === 6 ? 'inactive' : 'active',
      driver_usage_type: i % 4 === 3 ? 'company_owner' : 'employee', created_at: `2026-0${1 + (i % 8)}-0${1 + (i % 9)}T08:00:00Z`,
    };
  });
}

function userRows(): Row[] {
  return COMPANIES.slice(0, 7).flatMap((c, i) => [
    {
      user_id: `r4-u-${c.n}a`, email: `admin@firma${c.n}.example.com`, full_name: `Admin ${c.city}`,
      company_id: cid(c.n), company_name: c.name, role: 'admin', role_name: 'Administrator',
      status: c.status === 'suspended' ? 'suspended' : c.approval === 'pending' ? 'pending_invite' : 'active',
      created_at: c.created, invited_at: c.created, activated_at: c.approval === 'pending' ? null : c.created,
      email_confirmed_at: c.approval === 'pending' ? null : c.created, last_sign_in_at: i % 3 === 0 ? '2026-09-13T17:22:00Z' : '2026-09-01T07:05:00Z',
    },
    {
      user_id: `r4-u-${c.n}b`, email: `disposition@firma${c.n}.example.com`, full_name: `Disposition ${c.city}`,
      company_id: cid(c.n), company_name: c.name, role: 'editor', role_name: 'Disponent',
      status: 'active', created_at: c.created, invited_at: c.created, activated_at: c.created, email_confirmed_at: c.created, last_sign_in_at: null,
    },
  ]);
}

/** Applies the directory arguments the screens send: company, status, search. */
function directoryPage(rows: Row[], args: Record<string, unknown>, searchColumns: string[]): RpcAnswer {
  let kept = rows;
  if (typeof args.p_company_id === 'string') kept = kept.filter(r => r.company_id === args.p_company_id);
  if (typeof args.p_status === 'string') kept = kept.filter(r => r.status === args.p_status);
  if (typeof args.p_search === 'string') {
    const needle = args.p_search.toLowerCase();
    kept = kept.filter(r => searchColumns.some(c => String(r[c] ?? '').toLowerCase().includes(needle)));
  }
  const offset = Number(args.p_offset ?? 0);
  const limit = Number(args.p_limit ?? 100);
  return ok({ ok: true, total: kept.length, limit, offset, items: kept.slice(offset, offset + limit) });
}

// ── Team ────────────────────────────────────────────────────────────────────
function staffRows(): Row[] {
  const row = (id: string, email: string, role: string, extra: Row = {}): Row => ({
    user_id: id, email, role, status: 'active', disabled_at: null, note: null, created_at: '2026-02-03T08:00:00Z',
    created_by: HARNESS_USER_ID, created_by_email: 'jana.brenner@example.com', invitation_pending: false, ...extra,
  });
  return [
    row(HARNESS_USER_ID, 'jana.brenner@example.com', 'owner', { created_by: null, created_by_email: null, note: 'Gründerin' }),
    row('r4-s-2', 'tim.albrecht@example.com', 'owner', { created_at: '2026-02-10T08:00:00Z' }),
    row('r4-s-3', 'mira.sauer@example.com', 'support', { note: 'Kundensupport Früh', created_at: '2026-04-06T08:00:00Z' }),
    row('r4-s-4', 'paul.engel@example.com', 'billing', { created_at: '2026-05-19T08:00:00Z' }),
    row('r4-s-5', 'sofia.wirth@example.com', 'read_only', { created_at: '2026-07-01T08:00:00Z' }),
    row('r4-s-6', 'karl.berger@example.com', 'support', { status: 'disabled', disabled_at: '2026-08-31T12:00:00Z', note: 'Ausgeschieden', created_at: '2026-03-02T08:00:00Z' }),
    row('r4-s-7', 'ines.lorenz@example.com', 'read_only', { invitation_pending: true, created_at: '2026-09-12T08:00:00Z' }),
  ];
}

// ── Audit ───────────────────────────────────────────────────────────────────
function auditRows(): Row[] {
  const actor = { actor_user_id: HARNESS_USER_ID, actor_email: 'jana.brenner@example.com', actor_role: 'owner', session_id: 'r4-session-1' };
  const spec: Array<[string, string, string, string, number | null, string | null, unknown, unknown]> = [
    ['2026-09-14T09:41:00Z', 'read', 'platform_read.companies_list', 'ok', null, 'company', null, null],
    ['2026-09-14T09:38:00Z', 'write', 'platform_company_lifecycle.suspend', 'ok', 4, 'company', { status: 'active' }, { status: 'suspended' }],
    ['2026-09-14T09:12:00Z', 'support', 'support_session.open', 'ok', 2, 'company', null, { mode: 'support', reason: 'Rückfrage zur Abrechnung' }],
    ['2026-09-14T08:55:00Z', 'write', 'platform_invoice_mark_paid', 'ok', 3, 'invoice', { status: 'open' }, { status: 'paid', cash_received_amount: 59 }],
    ['2026-09-13T17:30:00Z', 'settings', 'platform_settings.put', 'ok', null, 'setting', { version: 4 }, { version: 5 }],
    ['2026-09-13T15:02:00Z', 'staff', 'platform_staff.add', 'ok', null, 'platform_staff', null, { role: 'read_only' }],
    ['2026-09-13T10:20:00Z', 'write', 'platform_company_set_plan', 'error', 8, 'company', null, null],
    ['2026-09-12T16:45:00Z', 'read', 'platform_read.audit_list', 'denied', null, null, null, null],
    ['2026-09-12T11:00:00Z', 'write', 'platform_invoice_cancel', 'attempt', 5, 'invoice', null, null],
    ['2026-09-12T11:00:01Z', 'write', 'platform_invoice_cancel', 'ok', 5, 'invoice', { status: 'open' }, { status: 'canceled' }],
    ['2026-09-11T08:15:00Z', 'auth', 'auth.platform_email_change', 'ok', null, 'user', null, null],
    ['2026-09-10T13:33:00Z', 'staff', 'platform_staff.disable', 'ok', null, 'platform_staff', { disabled_at: null }, { disabled_at: '2026-08-31T12:00:00Z' }],
    ['2026-09-09T09:00:00Z', 'legacy', 'legacy.company_status_change', 'ok', 7, 'company', null, null],
    ['2026-09-08T18:10:00Z', 'support', 'support_write.drivers.update', 'ok', 2, 'drivers', { name: 'M. Zielinski' }, { name: 'Marek Zielinski' }],
  ];
  return spec.map(([at, category, action, outcome, n, targetType, before, after], i) => ({
    id: 900 - i, occurred_at: at, ...actor, category, action, outcome,
    company_id: n ? cid(n) : null, company_name: n ? COMPANIES.find(c => c.n === n)!.name : null,
    target_type: targetType, target_id: n ? cid(n) : null, before_value: before, after_value: after,
  }));
}

// ── Plans ───────────────────────────────────────────────────────────────────
function planCatalogue() {
  const order = ['basic', 'advanced', 'premium'];
  const featureKeys = Object.keys(SEED_PLAN_FEATURES);
  const plans = order.map((slug, rank) => ({
    slug, name: PLAN_NAME[slug], rank: rank + 1, price_per_car_cents: SEED_PRICE_BOOK.price_per_car_cents[slug as 'basic'],
    features: featureKeys.filter(k => order.indexOf((SEED_PLAN_FEATURES as Record<string, string>)[k]) <= rank), is_active: true,
  }));
  return ok({ ok: true, version: 3, fixed_slugs: order, feature_keys: featureKeys, plans });
}

// ── Settings ────────────────────────────────────────────────────────────────
const SELLER = {
  name: 'El-Professor Software GmbH', street: 'Beispielallee', house_number: '12', postal_code: '10115', city: 'Berlin',
  vat_id: 'DE000000000', tax_number: '00/000/00000', bank_name: 'Beispielbank', iban: 'DE00 0000 0000 0000 0000 00',
  bic: 'EXAMPLEXXX', account_holder: 'El-Professor Software GmbH',
};

function settingValue(key: string): unknown {
  switch (key) {
    case 'price_book': return SEED_PRICE_BOOK;
    case 'plan_features': return SEED_PLAN_FEATURES;
    case 'seller': return SELLER;
    case 'invoice': return { number_prefix: 'INV', number_digits: 4, default_payment_method: 'bank_transfer' };
    case 'mail.sender': return { name: 'El-Professor' };
    case 'feature_flags': return {};
    case 'legal.impressum': case 'legal.privacy': return {};
    default: return {};
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────
export function r4Tables(): Array<[string, Row[]]> {
  if (!r4Screen) return [];
  return [
    ['companies', companyRows()],
    ['subscription_plans', subscriptionPlanTable()],
    ['discount_codes', discountCodes()],
    ['referrals', referralCodes()],
    ['activation_codes', activationCodes()],
  ];
}

function billingPage(rows: Row[], args: Record<string, unknown>): RpcAnswer {
  let kept = rows;
  if (typeof args.p_company_id === 'string') kept = kept.filter(r => r.company_id === args.p_company_id);
  if (typeof args.p_status === 'string') kept = kept.filter(r => r.status === args.p_status);
  if (typeof args.p_month === 'number') kept = kept.filter(r => r.invoice_month === args.p_month);
  if (typeof args.p_year === 'number') kept = kept.filter(r => r.invoice_year === args.p_year);
  if (typeof args.p_search === 'string') {
    const needle = args.p_search.toLowerCase();
    kept = kept.filter(r => `${r.company_name} ${r.invoice_number}`.toLowerCase().includes(needle));
  }
  return { data: { ok: true, total: kept.length, limit: 100, offset: 0, items: kept }, error: null };
}

function invoiceAnswer(args: Record<string, unknown>): RpcAnswer {
  const all = invoiceRows();
  const page = billingPage(all, args).data as { items: Row[] } & Record<string, unknown>;
  const today = '2026-09-14';
  const sum = (rows: Row[], pick: (r: Row) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const summary = {
    open_count: all.filter(r => r.status === 'open').length,
    overdue_count: all.filter(r => r.status === 'open' && String(r.due_date) < today).length,
    paid_this_month_count: all.filter(r => r.status === 'paid').length,
    filtered_amount: sum(page.items, r => Number(r.amount)),
    filtered_collected: sum(page.items.filter(r => r.status === 'paid'), r => Number(r.cash_received_amount || r.amount)),
    years: [2026, 2025],
  };
  return ok({ ...page, summary });
}

function subscriptionAnswer(args: Record<string, unknown>): RpcAnswer {
  const all = subscriptionRows();
  const page = billingPage(all, { ...args, p_month: undefined, p_year: undefined, p_search: undefined }).data as Record<string, unknown>;
  const active = all.filter(r => r.status === 'active');
  const byPlan: Record<string, number> = {};
  active.forEach(r => { byPlan[String(r.plan_id)] = (byPlan[String(r.plan_id)] ?? 0) + 1; });
  return ok({ ...page, summary: { active_count: active.length, active_by_plan: byPlan } });
}

/** The RPCs this batch's screens call; null for any other name or any other batch's screen. */
export function r4Rpc(name: string, args: Record<string, unknown> = {}): RpcAnswer | null {
  if (!r4Screen) return null;
  switch (name) {
    case 'platform_companies_list': return directoryPage(companyReadModel(), args, ['name']);
    case 'platform_vehicles_list': return directoryPage(vehicleRows(), args, ['kennzeichen', 'company_name']);
    case 'platform_drivers_list': return directoryPage(driverRows(), args, ['name', 'company_name']);
    case 'platform_users_list': return directoryPage(userRows(), args, ['email', 'full_name', 'company_name']);
    case 'platform_staff_list': return directoryPage(staffRows(), args, ['email']);
    case 'platform_invoices_list': return invoiceAnswer(args);
    case 'platform_subscriptions_list': return subscriptionAnswer(args);
    case 'platform_invoice_quotes':
      return ok({
        ok: true,
        items: subscriptionRows().filter(r => r.status === 'active').map(r => ({
          subscription_id: r.id, company_id: r.company_id, first_invoice: r.company_id === cid(8),
          amount_cents: r.company_id === cid(8) ? 20000 : Number(r.monthly_price) * 100, active_cars: 3 + (Number(String(r.company_id).slice(-2)) % 5),
        })),
      });
    case 'platform_audit_list': {
      let rows = auditRows();
      (['category', 'outcome', 'company_id'] as const).forEach(k => {
        const v = args[`p_${k}`];
        if (typeof v === 'string') rows = rows.filter(r => r[k] === v);
      });
      if (typeof args.p_action_prefix === 'string') rows = rows.filter(r => String(r.action).startsWith(String(args.p_action_prefix)));
      return ok({ ok: true, scope: 'all', items: rows, next_cursor: null });
    }
    case 'platform_plans_list': return planCatalogue();
    case 'platform_settings_get': {
      const key = String(args.p_key);
      return ok({ ok: true, key, value: settingValue(key), version: 5, updated_at: '2026-09-13T17:30:00Z', updated_by: HARNESS_USER_ID });
    }
    case 'platform_announcements_list': return ok({ ok: true, items: [] });
    default: return null;
  }
}
