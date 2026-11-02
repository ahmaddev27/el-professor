/**
 * The platform panel on invented data, for the responsive sweep.
 *
 * The sweep signs in as the DEMO company's administrator, who is not platform
 * staff, and that is deliberate: no platform credential belongs in e2e/.env.local.
 * So the browser is told a story here. The profile comes back with the platform
 * flag, platform_whoami answers an owner, and every read model answers the rows
 * below. All of it is fulfilled in the browser: none of these requests reaches
 * staging, and no row here describes a real company, person or vehicle.
 *
 * The long names are there on purpose. A column only shows its problem when
 * something wide is in it.
 */
const COMPANY_NAMES = [
  'Taxi- und Mietwagenzentrale Musterstadt-Nordrhein-Westfalen GmbH & Co. KG',
  'Mietwagen Beispiel UG (haftungsbeschränkt)',
  'Fahrdienst Testhausen GmbH',
];
const uuid = i => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const pick = (list, i) => list[i % list.length];
const AT = '2026-10-15T10:00:00Z';

const companyRow = i => ({
  id: uuid(i), name: pick(COMPANY_NAMES, i), slug: `firma-${i}`,
  status: pick(['active', 'suspended', 'inactive'], i), approval_status: pick(['approved', 'pending', 'rejected'], i),
  plan: pick(['premium', 'advanced', 'basic'], i), subscription_status: pick(['active', 'expired', 'inactive'], i),
  subscription_expires_at: '2026-12-31T00:00:00Z', subscription_started_at: '2026-01-01T00:00:00Z',
  subscription_duration_type: '1_month', trial_start: null, trial_end: null, trial_state: 'none',
  email: `kontakt-mit-langer-adresse-${i}@example.com`, phone: '+49 211 00000000', address: 'Musterstraße 123',
  postal_code: '40210', city: 'Düsseldorf', country: 'Deutschland', billing_cycle: 'monthly',
  car_limit: 25, drivers_per_car_limit: 2, created_at: AT, updated_at: AT,
  open_invoice_count: i, overdue_invoice_count: i % 2, user_count: 12, active_driver_count: 48, active_vehicle_count: 24,
});

const page = items => ({ ok: true, total: items.length, limit: 50, offset: 0, items });
const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i));

const INVOICE_SUMMARY = {
  open_count: 3, overdue_count: 1, paid_this_month_count: 2, filtered_amount: 123456.78, filtered_collected: 98765.43,
  years: [2025, 2026],
};

const ANSWERS = {
  platform_whoami: () => ({
    role: 'owner',
    capabilities: [
      'companies.read', 'business.read', 'support.session', 'company_users.manage', 'companies.lifecycle',
      'companies.hard_delete', 'billing.manage', 'pricing.manage', 'codes.manage', 'settings.read',
      'settings.manage', 'staff.manage', 'audit.read',
    ],
    company_context: null,
  }),
  platform_companies_list: () => page(rows(6, companyRow)),
  platform_vehicles_list: () => page(rows(6, i => ({
    id: uuid(i), company_id: uuid(i), company_name: pick(COMPANY_NAMES, i), kennzeichen: `XX-TE ${1000 + i}E`,
    status: 'active', tuev_gueltig_bis: '2027-03-31', letzte_hu: '2025-03-31', created_at: AT,
  }))),
  platform_drivers_list: () => page(rows(6, i => ({
    id: uuid(i), company_id: uuid(i), company_name: pick(COMPANY_NAMES, i), name: `Testfahrer Doppelname-Beispiel ${i}`,
    status: 'active', driver_usage_type: 'regular', created_at: AT,
  }))),
  platform_users_list: () => page(rows(6, i => ({
    user_id: uuid(i), email: `benutzer-mit-langer-adresse-${i}@example.com`, full_name: `Testperson Doppelname-Beispiel ${i}`,
    company_id: uuid(i), company_name: pick(COMPANY_NAMES, i), role: 'admin', role_name: 'Administrator', status: 'active',
    created_at: AT, invited_at: AT, activated_at: AT, email_confirmed_at: AT, last_sign_in_at: AT,
  }))),
  platform_staff_list: () => page(rows(4, i => ({
    user_id: uuid(i), email: `team-mit-langer-adresse-${i}@example.com`, role: pick(['owner', 'support', 'billing', 'read_only'], i),
    status: pick(['active', 'disabled'], i), disabled_at: null, note: 'Eine Notiz über dieses Teammitglied, etwas länger',
    created_at: AT, created_by: uuid(9), created_by_email: 'wer-es-angelegt-hat@example.com', invitation_pending: i === 1,
  }))),
  platform_audit_list: () => ({
    ok: true, scope: 'all', items: rows(6, i => ({
      id: i + 1, occurred_at: AT, actor_user_id: uuid(i), actor_email: `wer-es-war-mit-langer-adresse-${i}@example.com`,
      actor_role: 'owner', session_id: uuid(i), company_id: uuid(i), company_name: pick(COMPANY_NAMES, i),
      category: pick(['read', 'write', 'support', 'settings'], i), action: 'platform_company_set_subscription.manual',
      outcome: pick(['ok', 'denied', 'error'], i), target_type: 'company', target_id: uuid(i),
      before_value: { status: 'inactive' }, after_value: { status: 'active' },
    })),
  }),
  platform_invoices_list: () => ({
    ...page(rows(6, i => ({
      id: uuid(i), company_id: uuid(i), company_name: pick(COMPANY_NAMES, i), company_address: 'Musterstraße 123',
      company_postal_code: '40210', company_city: 'Düsseldorf', plan_name: 'Advanced', invoice_month: 9, invoice_year: 2026,
      invoice_number: `INV-2026-${String(i + 1).padStart(4, '0')}`, amount: 1234.56, status: pick(['open', 'paid', 'overdue'], i),
      due_date: '2026-09-30', paid_at: i % 3 === 1 ? AT : null, cash_received_amount: null, receipt_note: null, created_at: AT,
    }))),
    summary: INVOICE_SUMMARY,
  }),
  platform_subscriptions_list: () => ({
    ...page(rows(6, i => ({
      id: uuid(i), company_id: uuid(i), company_name: pick(COMPANY_NAMES, i), plan_id: uuid(i), plan_name: 'Advanced',
      status: pick(['active', 'canceled', 'expired'], i), starts_at: '2026-01-01', billing_day: 1, monthly_price: 1234.56,
    }))),
    summary: { active_count: 4, active_by_plan: { Basic: 1, Advanced: 2, Premium: 1 } },
  }),
  platform_plans_list: () => ({
    ok: true, version: 1, fixed_slugs: ['basic', 'advanced', 'premium'], feature_keys: ['overview', 'belege', 'fahrer', 'cars', 'umsaetze'], plans: ['basic', 'advanced', 'premium'].map((slug, i) => ({
      slug, name: slug[0].toUpperCase() + slug.slice(1), rank: i + 1, price_per_car_cents: 2000 * (i + 1),
      features: ['overview', 'belege', 'fahrer', 'cars', 'umsaetze'], is_active: true,
    })),
  }),
  platform_settings_get: body => ({ ok: true, key: body?.p_key, version: 1, value: SETTINGS[body?.p_key] ?? {} }),
  platform_announcements_list: () => ({ ok: true, items: [] }),
};

const SETTINGS = {
  price_book: {
    price_per_car_cents: { basic: 2000, advanced: 4000, premium: 7000 },
    fleet_discount_tiers: [{ min_cars: 6, percent: 5 }, { min_cars: 11, percent: 10 }],
    yearly_discount_percent: 10, first_month_cents: 20000,
  },
  trial: { days: 14 },
  invoice: { number_prefix: 'INV', number_digits: 4, default_payment_method: 'bank_transfer' },
  'mail.sender': { display_name: 'El-Professor' },
};

/** Installs the story on a page. Call before signing in. */
export async function installPanelStandIn(target) {
  await target.route('**/rest/v1/rpc/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const answer = ANSWERS[name];
    const body = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(answer ? answer(body) : { ok: true, total: 0, limit: 50, offset: 0, items: [] }),
    });
  });
  await target.route('**/rest/v1/user_profiles*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const data = await real.json().catch(() => null);
    const rewrite = row => (row && typeof row === 'object' ? { ...row, is_super_admin: true, company_id: null } : row);
    return route.fulfill({ response: real, body: JSON.stringify(Array.isArray(data) ? data.map(rewrite) : rewrite(data)) });
  });
  await target.route('**/rest/v1/companies*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    const data = rows(6, companyRow);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `0-5/6` }, body: JSON.stringify(single ? data[0] : data) });
  });
}

export const PANEL_ROUTES = [
  'admin', 'admin/companies', 'admin/billing', 'admin/verzeichnisse', 'admin/protokoll',
  'admin/einstellungen', 'admin/plaene', 'admin/team', 'admin/konto', 'admin/abnahme-diagnose',
];
