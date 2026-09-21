/**
 * Invented rows for the batch-4 screens, shaped like what each one reads.
 *
 * The company and the signed-in admin are the design preview's (Stadttaxi
 * Lindner GmbH, Katrin Lindner), so these screens sit beside batch 1's in the
 * same invented world. Nothing here is a real company or a real person; every
 * address is @example.com.
 */
import { PAGE_DEFINITIONS } from '../../src/types/role';
import { PREVIEW_COMPANY, PREVIEW_USER } from '../../src/design-preview/sampleData';
import { HARNESS_COMPANY_ID, HARNESS_EMAIL, HARNESS_OTHER_COMPANY_ID, HARNESS_USER_ID, scenario } from './scenario';

export type Row = Record<string, unknown>;

const CREATED_AT = '2026-01-12T08:30:00+00:00';

/** What `manage-users/list` answers: one company's accounts, the admin first. */
export function userRows(): Row[] {
  const people: Array<[string, string, string, string, Partial<Row>]> = [
    ['a1', PREVIEW_USER.name, HARNESS_EMAIL, 'admin', { status: 'active', email_confirmed_at: CREATED_AT }],
    ['a2', 'Svenja Krüger', 'svenja.krueger@example.com', 'supervisor', { status: 'active', email_confirmed_at: CREATED_AT }],
    ['a3', 'Jonas Albrecht', 'jonas.albrecht@example.com', 'editor', { status: 'active', email_confirmed_at: CREATED_AT, must_change_password: true }],
    ['a4', 'Katarzyna Nowak', 'katarzyna.nowak@example.com', 'viewer', { status: 'pending_invite', invited_at: '2026-09-10T09:00:00+02:00' }],
    ['a5', 'Thomas Wendt', 'thomas.wendt@example.com', 'viewer', { status: 'inactive', email_confirmed_at: CREATED_AT }],
    ['a6', 'Mehmet Yıldız', 'mehmet.yildiz@example.com', 'Disponent', { status: 'active', email_confirmed_at: CREATED_AT, role_name: 'Disponent' }],
  ];
  return people.map(([id, fullName, email, role, extra]) => ({
    id: id === 'a1' ? HARNESS_USER_ID : `00000000-0000-4000-8000-0000000000${id}`,
    email,
    full_name: fullName,
    role,
    created_at: CREATED_AT,
    company_id: HARNESS_COMPANY_ID,
    is_super_admin: false,
    ...extra,
  }));
}

/** System roles have no company; the custom one is this company's own. */
export function roleRows(): Row[] {
  const roles: Array<[string, string, string, boolean]> = [
    ['r-admin', 'admin', 'Voller Zugriff auf alle Bereiche', true],
    ['r-supervisor', 'supervisor', 'Bearbeiten ohne Benutzerverwaltung', true],
    ['r-editor', 'editor', 'Erfassen und bearbeiten', true],
    ['r-viewer', 'viewer', 'Nur lesen', true],
    ['r-dispo', 'Disponent', 'Fahrer, Fahrzeuge und Monatsplanung', false],
  ];
  return roles.map(([id, name, description, isSystem]) => ({
    id,
    name,
    description,
    is_system: isSystem,
    company_id: isSystem ? null : HARNESS_COMPANY_ID,
    created_by: isSystem ? null : HARNESS_USER_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
}

export function rolePermissionRows(): Row[] {
  const grants: Record<string, { view: string[]; edit: string[] }> = {
    'r-admin': { view: PAGE_DEFINITIONS.map(page => page.key), edit: PAGE_DEFINITIONS.map(page => page.key) },
    'r-supervisor': {
      view: ['overview', 'drivers', 'income', 'receipts', 'fixed-costs', 'salaries', 'cash-balance', 'cars', 'werkstatt', 'notes'],
      edit: ['drivers', 'income', 'receipts', 'fixed-costs', 'cars', 'werkstatt', 'notes'],
    },
    'r-editor': { view: ['overview', 'drivers', 'income', 'receipts', 'cars'], edit: ['income', 'receipts'] },
    'r-viewer': { view: ['overview', 'drivers', 'income', 'receipts', 'cars'], edit: [] },
    'r-dispo': { view: ['overview', 'drivers', 'cars', 'werkstatt', 'documents'], edit: ['drivers', 'cars'] },
  };
  return Object.entries(grants).flatMap(([roleId, { view, edit }]) =>
    view.map(pageKey => ({
      id: `${roleId}-${pageKey}`,
      role_id: roleId,
      page_key: pageKey,
      can_view: true,
      can_edit: edit.includes(pageKey),
      created_at: CREATED_AT,
    })),
  );
}

/** The company's settings row, as CompanySettingsContext would hold it. */
export function companySettings(): Row {
  return {
    id: 'cs-1',
    company_id: HARNESS_COMPANY_ID,
    company_name: PREVIEW_COMPANY,
    legal_company_name: 'Stadttaxi Lindner GmbH',
    slogan: 'Sicher ans Ziel, seit 1998',
    email: 'buero@stadttaxi-lindner.example.com',
    phone: '030 555 01 23',
    mobile: '0170 555 01 24',
    website: 'https://stadttaxi-lindner.example.com',
    support_email: 'hilfe@stadttaxi-lindner.example.com',
    street: 'Kastanienallee',
    house_number: '12',
    postal_code: '10435',
    city: 'Berlin',
    state: 'Berlin',
    country: 'Deutschland',
    manager_name: PREVIEW_USER.name,
    owner_name: PREVIEW_USER.name,
    authorized_representative: '',
    vat_id: 'DE000000000',
    tax_number: '30/000/00000',
    commercial_register: 'HRB 000000 B',
    court_of_registration: 'Amtsgericht Charlottenburg',
    bank_name: 'Beispielbank Berlin',
    iban: 'DE00 0000 0000 0000 0000 00',
    bic: 'BEISDEBBXXX',
    account_holder: 'Stadttaxi Lindner GmbH',
    logo_url: null,
    primary_color: '#2563eb',
    secondary_color: '#64748b',
    default_signature_city: 'Berlin',
    default_footer_text: 'Stadttaxi Lindner GmbH · Kastanienallee 12 · 10435 Berlin',
    default_email_signature: 'Mit freundlichen Grüßen\nIhr Team von Stadttaxi Lindner',
    default_print_header: '',
    default_print_footer: '',
    drivers_per_car_limit: 4,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

/**
 * The subscription as the database derives it (recompute_company_subscription).
 * `data` picks the state: active by default, or expired / inactive / inactive
 * with an earlier activation in its history.
 */
export function companyRows(): Row[] {
  const base = {
    id: HARNESS_COMPANY_ID,
    name: PREVIEW_COMPANY,
    subscription_started_at: '2026-07-01T10:00:00+02:00',
    subscription_duration_type: '3_monate',
    last_activation_code_id: 'ac-3',
  };
  const state: Row =
    scenario.data === 'expired'
      ? { subscription_status: 'expired', subscription_expires_at: '2026-09-01T00:00:00+02:00' }
      : scenario.data === 'inactive' || scenario.data === 'history'
        ? { subscription_status: 'inactive', subscription_expires_at: null, last_activation_code_id: null, subscription_started_at: null, subscription_duration_type: null }
        : { subscription_status: 'active', subscription_expires_at: '2026-10-01T10:00:00+02:00' };
  return [
    { ...base, ...state },
    { id: HARNESS_OTHER_COMPANY_ID, name: 'Taxi Brandt & Söhne', subscription_status: 'active', subscription_expires_at: null },
  ];
}

export function activationCodeRows(): Row[] {
  if (scenario.data === 'inactive') return [];
  const rows: Row[] = [
    {
      id: 'ac-3', code_last4: '4821', duration_type: '3_monate', used_at: '2026-07-01T10:00:00+02:00', status: 'used',
      applied_subscription_started_at: '2026-07-01T10:00:00+02:00', applied_subscription_expires_at: '2026-10-01T10:00:00+02:00',
    },
    {
      id: 'ac-2', code_last4: '1177', duration_type: '1_monat', used_at: '2026-05-28T16:42:00+02:00', status: 'used',
      applied_subscription_started_at: '2026-06-01T00:00:00+02:00', applied_subscription_expires_at: '2026-07-01T00:00:00+02:00',
    },
    {
      id: 'ac-1', code_last4: '0930', duration_type: 'benutzerdefiniert', used_at: '2026-03-02T09:15:00+01:00', status: 'used',
      applied_subscription_started_at: '2026-03-02T09:15:00+01:00', applied_subscription_expires_at: '2026-06-01T00:00:00+02:00',
    },
  ];
  // An expired subscription ended with the period its last code applied.
  if (scenario.data === 'expired') rows[0].applied_subscription_expires_at = '2026-09-01T00:00:00+02:00';
  return rows.map(row => ({ ...row, used_company_id: HARNESS_COMPANY_ID, hidden_at: null, deleted_at: null }));
}

/** What SetPasswordPage reads about the account whose session it holds. */
export function userProfileRows(): Row[] {
  return [{
    user_id: HARNESS_USER_ID,
    company_id: HARNESS_COMPANY_ID,
    status: scenario.invite ? 'pending_invite' : 'active',
    is_super_admin: false,
  }];
}
