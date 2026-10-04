/**
 * The platform panel's six Excel exports, as values rather than as files.
 *
 * Each builder is a pure mapping, so every defect one of these exports can carry
 * is visible here: a money cell in cents, a column key that matches no row
 * property (#153's blank "Erstellt am" column), a numeric column with no `type`
 * (#150's numbers written as text), a totals row that names column 0 (which
 * `buildTableWorkbook` throws on since #152), an unknown count written as 0, and
 * — the one this slice is shaped around — a file that claims to hold a list it
 * only holds one page of.
 *
 * Nothing here touches `xlsx`: the builders return `ExportOptions`, and
 * `excelExport.ts` is imported for types only, which TypeScript erases.
 */
import { describe, expect, it } from 'vitest';
import {
  bandEuro,
  buildAuditExport,
  buildCompaniesExport,
  buildDirectoryExport,
  buildInvoicesExport,
  buildStaffExport,
  buildSubscriptionsExport,
  coversWholeSet,
  filterBand,
  pageScopeLine,
  pageSuffix,
  type PanelExportChrome,
} from './panelExports';
import type { PlatformInvoiceRow, PlatformInvoiceSummary, PlatformSubscriptionRow } from './platformBilling';
import type { PlatformDriverRow, PlatformStaffRow, PlatformUserRow, PlatformVehicleRow } from './platformReadModels';
import type { AuditRow } from './platformAuditLog';
import { EMPTY_CELL } from './platformFormat';
import type { ExportOptions } from '../utils/excelExport';

const CHROME: PanelExportChrome = {
  empty: 'No data',
  filters: 'Active filters:',
  totals: 'Total ({count} entries)',
};

const LINE = '{label}: {value}';

const SCOPE_LABELS = {
  whole: 'Whole list — {rows} rows',
  page: 'Page {page} of {pages} — {rows} of {total} rows',
};

/** What xlsx refuses in a worksheet name (#154). */
const SHEET_NAME_FORBIDDEN = [':', '\\', '/', '?', '*', '[', ']'] as const;

/** What Windows refuses in a filename; the exporter passes it straight through. */
const FILENAME_FORBIDDEN = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] as const;

// ─── The two invariants that hold for every one of the six ───────────────────

/**
 * Every column key resolves to a property on every row.
 *
 * `exportTableToExcel` reads each cell as `row[column.key]`, so a key that
 * matches nothing is a silently blank column in an operator's file — the Fahrer
 * export's "Erstellt am" defect (#153). `undefined` is the failure; an empty
 * string and an em dash are deliberate values.
 */
function expectEveryKeyPresent(options: ExportOptions): void {
  for (const row of options.rows) {
    for (const column of options.columns) {
      expect(
        Object.prototype.hasOwnProperty.call(row, column.key),
        `row is missing the column key "${column.key}"`,
      ).toBe(true);
      expect(row[column.key], `column "${column.key}" resolved to undefined`).not.toBeUndefined();
    }
  }
}

/**
 * The totals row never names the first column.
 *
 * `buildTableWorkbook` throws on that since #152 — the first cell of the totals
 * row is the row's own label — and three older callers were tripping over it. A
 * builder that picked the wrong first column would fail on the operator's first
 * click; this fails on the commit instead.
 */
function expectTotalsAvoidColumnZero(options: ExportOptions): void {
  if (!options.totals) return;
  expect(Object.keys(options.totals)).not.toContain(options.columns[0].key);
}

/** A typed column's cells are numbers, or left on the text path on purpose. */
function expectTypedCellsAreNumeric(options: ExportOptions): void {
  const typed = options.columns.filter(column => column.type && column.type !== 'text');
  for (const column of typed) {
    for (const row of options.rows) {
      const value = row[column.key];
      expect(
        typeof value === 'number' || value === '' || value === EMPTY_CELL,
        `column "${column.key}" holds ${JSON.stringify(value)}, which is neither a number nor a deliberate blank`,
      ).toBe(true);
    }
  }
}

/**
 * The filter band as an array. `ExportOptions.filterSummary` is optional, so
 * every builder here setting it is itself part of what the assertions check —
 * an empty array would mean a file that says nothing about what it holds.
 */
function band(options: ExportOptions): string[] {
  return options.filterSummary ?? [];
}

function expectHealthy(options: ExportOptions): void {
  expectEveryKeyPresent(options);
  expectTotalsAvoidColumnZero(options);
  expectTypedCellsAreNumeric(options);
  // The sheet name is `moduleName.slice(0, 31)`, and xlsx refuses those seven
  // characters and anything past 31 — #154's crash, where a customer's own tab
  // name reached that call. These names are dictionary values rather than data,
  // so what this pins is that a translator cannot reintroduce it.
  //
  // Both sets are spelled as character arrays rather than as regex literals: a
  // class holding a quote or a slash is exactly the kind of literal that confuses
  // a reader and a crude scanner alike, and this file has no need of one.
  for (const forbidden of SHEET_NAME_FORBIDDEN) {
    expect(options.moduleName.includes(forbidden), `sheet name holds ${forbidden}`).toBe(false);
  }
  expect(options.moduleName.length).toBeLessThanOrEqual(31);
  // A filename an operating system will accept, and no extension: the exporter
  // appends `.xlsx` itself.
  for (const forbidden of FILENAME_FORBIDDEN) {
    expect(options.filename.includes(forbidden), `filename holds ${forbidden}`).toBe(false);
  }
  expect(options.filename.endsWith('.xlsx')).toBe(false);
}

// ─── Decision D-C: what the file says it holds ───────────────────────────────

describe('page scope', () => {
  it('calls page 1 of a set that fits in one page the whole list', () => {
    expect(coversWholeSet({ pageIndex: 0, total: 42, rowCount: 42 })).toBe(true);
    expect(pageSuffix({ pageIndex: 0, total: 42, rowCount: 42 })).toBe('');
    expect(pageScopeLine(SCOPE_LABELS, { pageIndex: 0, total: 42, rowCount: 42 }))
      .toBe('Whole list — 42 rows');
  });

  it('calls page 1 of a longer set a page, and names the total', () => {
    const scope = { pageIndex: 0, total: 250, rowCount: 100 };
    expect(coversWholeSet(scope)).toBe(false);
    expect(pageSuffix(scope)).toBe('_seite-1');
    expect(pageScopeLine(SCOPE_LABELS, scope)).toBe('Page 1 of 3 — 100 of 250 rows');
  });

  it('never calls a later page complete, however many rows it holds', () => {
    // The trap: `rowCount >= total` alone. Page 3 of a table that shrank to 40
    // rows between the count and the read would read as the whole list.
    const scope = { pageIndex: 2, total: 40, rowCount: 40 };
    expect(coversWholeSet(scope)).toBe(false);
    expect(pageSuffix(scope)).toBe('_seite-3');
    // The page wording, not the whole-list wording. The page count it prints is
    // `directoryReachablePageCount`, the very function the on-screen pager uses,
    // so in this race the band reads exactly as "Seite 3 von 1" does on screen —
    // matching the screen beats inventing a second arithmetic here.
    expect(pageScopeLine(SCOPE_LABELS, scope)).toMatch(/^Page 3 of /);
    expect(pageScopeLine(SCOPE_LABELS, scope)).not.toContain('Whole list');
  });

  it('caps the page count where the database stops serving offsets', () => {
    // platform_read_offset refuses past 10 000, so 50 000 rows fill 500 pages of
    // which 101 are reachable. The band must not advertise the other 399.
    expect(pageScopeLine(SCOPE_LABELS, { pageIndex: 0, total: 50_000, rowCount: 100 }))
      .toBe('Page 1 of 101 — 100 of 50.000 rows');
  });

  it('formats thousands the German way and never a bare float for money', () => {
    expect(bandEuro(1234.5)).toBe('1.234,50 €');
    expect(bandEuro(0)).toBe('0,00 €');
    expect(bandEuro(-19.99)).toBe('-19,99 €');
  });

  it('drops a filter that has no value', () => {
    expect(filterBand(LINE, [
      { label: 'Month', value: 'September' },
      { label: 'Company', value: null },
      { label: 'Status', value: '' },
    ])).toEqual(['Month: September']);
  });
});

// ─── Rechnungen ──────────────────────────────────────────────────────────────

const INVOICE_LABELS = {
  sheetTitle: 'Rechnungen',
  company: 'Firma',
  plan: 'Plan',
  period: 'Monat/Jahr',
  number: 'Nr.',
  amount: 'Betrag',
  collected: 'Kassiert',
  status: 'Status',
  due: 'Fällig',
  paidOn: 'Bezahlt am',
  note: 'Notiz',
  created: 'Angelegt',
  statusNames: { open: 'Offen', paid: 'Bezahlt' },
  monthNames: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  expected: 'Erwartet',
  totalsCollected: 'Kassiert',
  scope: SCOPE_LABELS,
  chrome: CHROME,
};

function invoice(overrides: Partial<PlatformInvoiceRow> = {}): PlatformInvoiceRow {
  return {
    id: 'inv-1',
    company_id: 'c-1',
    company_name: 'Taxi Nord GmbH',
    company_address: 'Hauptstr. 1',
    company_postal_code: '20095',
    company_city: 'Hamburg',
    plan_name: 'Advanced',
    invoice_month: 9,
    invoice_year: 2026,
    invoice_number: 'INV-2026-0007',
    // EUROS. subscription_invoices.amount is numeric euros: platform_invoice_mark_paid
    // takes integer cents and stores round(cents / 100, 2).
    amount: 149.9,
    status: 'open',
    due_date: '2026-09-15',
    paid_at: null,
    cash_received_amount: null,
    receipt_note: null,
    created_at: '2026-09-01',
    ...overrides,
  };
}

const SUMMARY: PlatformInvoiceSummary = {
  openCount: 3,
  overdueCount: 1,
  paidThisMonthCount: 2,
  filteredAmount: 449.7,
  filteredCollected: 299.8,
  years: [2026],
};

describe('buildInvoicesExport', () => {
  const base = {
    summary: SUMMARY,
    filters: [{ label: 'Monat', value: 'September' }],
    filterLineTemplate: LINE,
    periodSlug: '2026-09',
    labels: INVOICE_LABELS,
  };

  it('writes euros, not cents, and keeps the money columns typed', () => {
    const options = buildInvoicesExport({
      ...base,
      rows: [invoice({ amount: 149.9, cash_received_amount: 149.9 })],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    expectHealthy(options);

    // 149,90 € — not 14990, which a cents value in a `money` cell would render
    // as 14.990,00 € and look entirely plausible.
    expect(options.rows[0].amount).toBe(149.9);
    expect(options.rows[0].collected).toBe(149.9);
    const money = options.columns.filter(c => ['amount', 'collected'].includes(c.key));
    expect(money.map(c => c.type)).toEqual(['money', 'money']);
  });

  it('leaves a cash amount that was never counted empty, never 0,00 €', () => {
    const options = buildInvoicesExport({
      ...base,
      rows: [invoice({ cash_received_amount: null })],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    // The ledger reads 0 as absent (`filtered_collected`), so a 0,00 € here
    // would claim a counted handover of nothing.
    expect(options.rows[0].collected).toBe('');
  });

  it("puts the database's two sums in the totals row only when the file holds the whole set", () => {
    const whole = buildInvoicesExport({
      ...base,
      rows: [invoice(), invoice({ id: 'inv-2', invoice_number: 'INV-2026-0008' })],
      scope: { pageIndex: 0, total: 2, rowCount: 2 },
    });
    expect(whole.totals).toEqual({ amount: 449.7, collected: 299.8 });
    // The label goes in the chrome, never in column 0 — which would throw.
    expect(Object.keys(whole.totals!)).not.toContain('company');
    expect(band(whole)).toContain('Whole list — 2 rows');
    // Not repeated in the band: it is in the totals row.
    expect(band(whole)).not.toContain('Erwartet: 449,70 €');
  });

  it('moves those sums into the band on a deeper page rather than mis-totalling it', () => {
    const page = buildInvoicesExport({
      ...base,
      rows: [invoice()],
      scope: { pageIndex: 1, total: 250, rowCount: 100 },
    });
    // The trap this refuses: writing 449,70 € under a column of one row.
    expect(page.totals).toBeUndefined();
    expect(band(page)).toContain('Erwartet: 449,70 €');
    expect(band(page)).toContain('Kassiert: 299,80 €');
    expect(band(page)).toContain('Page 2 of 3 — 100 of 250 rows');
    expect(page.filename).toBe('rechnungen_2026-09_seite-2');
  });

  it('names the period in German and dates it DD.MM.YYYY', () => {
    const options = buildInvoicesExport({
      ...base,
      rows: [invoice({ paid_at: '2026-09-14T10:32:05Z', status: 'paid' })],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    expect(options.rows[0].period).toBe('September 2026');
    expect(options.rows[0].due).toBe('15.09.2026');
    // Europe/Berlin, which vitest.config.ts pins: 10:32 UTC is 12:32 local.
    expect(options.rows[0].paidOn).toBe('14.09.2026 12:32:05');
    expect(options.rows[0].status).toBe('Bezahlt');
  });

  it('writes a status the dictionary does not know verbatim, as the screen does', () => {
    const options = buildInvoicesExport({
      ...base,
      rows: [invoice({ status: 'some_new_state' })],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    expect(options.rows[0].status).toBe('some_new_state');
  });

  it('carries no column the read model withholds', () => {
    const options = buildInvoicesExport({
      ...base,
      rows: [invoice()],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    const keys = options.columns.map(column => column.key);
    // Decision D-D: no account id, no payment method, no country, and no uuid.
    for (const forbidden of ['paid_by', 'collected_by', 'payment_method', 'subscription_id', 'id', 'company_id']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// ─── Abonnements ─────────────────────────────────────────────────────────────

const SUBSCRIPTION_LABELS = {
  sheetTitle: 'Abonnements',
  company: 'Firma',
  plan: 'Plan',
  pricePerMonth: 'Preis/Monat',
  status: 'Status',
  start: 'Start',
  billingDay: 'Abrechnungstag',
  statusNames: { active: 'Aktiv' },
  activeCount: 'Aktive Abos',
  scope: SCOPE_LABELS,
  chrome: CHROME,
};

function subscription(overrides: Partial<PlatformSubscriptionRow> = {}): PlatformSubscriptionRow {
  return {
    id: 's-1',
    company_id: 'c-1',
    company_name: 'Taxi Nord GmbH',
    plan_id: 'p-1',
    plan_name: 'Advanced',
    status: 'active',
    starts_at: '2026-03-01',
    billing_day: 5,
    // EUROS: company_subscriptions.monthly_price is numeric euros (20260607125649).
    monthly_price: 89.5,
    ...overrides,
  };
}

describe('buildSubscriptionsExport', () => {
  const base = {
    activeCount: 17,
    filters: [],
    filterLineTemplate: LINE,
    today: '2026-09-30',
    labels: SUBSCRIPTION_LABELS,
  };

  it('writes the rate in euros and the billing day as an integer', () => {
    const options = buildSubscriptionsExport({
      ...base,
      rows: [subscription()],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    expectHealthy(options);
    expect(options.rows[0].price).toBe(89.5);
    expect(options.rows[0].billingDay).toBe(5);
    expect(options.columns.find(c => c.key === 'price')?.type).toBe('money');
    expect(options.columns.find(c => c.key === 'billingDay')?.type).toBe('integer');
  });

  it('has no totals row, because the read model sums no price', () => {
    const options = buildSubscriptionsExport({
      ...base,
      rows: [subscription(), subscription({ id: 's-2' })],
      scope: { pageIndex: 0, total: 2, rowCount: 2 },
    });
    // Summing monthly_price here would be a monthly-revenue figure no screen has
    // shown, over one page, with cancelled rows in it.
    expect(options.totals).toBeUndefined();
    expect(band(options)).toContain('Aktive Abos: 17');
  });

  it('names a company the read model could not name, rather than leaving a blank', () => {
    const options = buildSubscriptionsExport({
      ...base,
      rows: [subscription({ company_name: null, plan_name: null })],
      scope: { pageIndex: 0, total: 1, rowCount: 1 },
    });
    expect(options.rows[0].company).toBe(EMPTY_CELL);
    expect(options.rows[0].plan).toBe(EMPTY_CELL);
  });
});

// ─── Unternehmen ─────────────────────────────────────────────────────────────

const COMPANY_LABELS = {
  sheetTitle: 'Unternehmen',
  name: 'Name',
  slug: 'Kürzel',
  status: 'Status',
  email: 'E-Mail',
  city: 'Stadt',
  users: 'Benutzer',
  created: 'Angelegt',
  statusNames: { trial: 'Testphase', active: 'Aktiv' },
  scopeWhole: 'Ganze Liste · {rows} Zeilen',
  countsIncomplete: 'Ohne Benutzerzahl',
  chrome: CHROME,
};

describe('buildCompaniesExport', () => {
  const base = { filters: [], filterLineTemplate: LINE, today: '2026-09-30', labels: COMPANY_LABELS };

  const row = {
    name: 'Taxi Nord GmbH',
    slug: 'taxi-nord',
    status: 'trial',
    email: 'buero@taxi-nord.de',
    city: 'Hamburg',
    created_at: '2026-02-11',
    user_count: 4,
  };

  it('writes a user count it has, and an em dash for one it has not', () => {
    const options = buildCompaniesExport({
      ...base,
      rows: [row, { ...row, name: 'Mietwagen Süd', slug: 'mw-sued', user_count: undefined }],
    });
    expectHealthy(options);
    expect(options.rows[0].users).toBe(4);
    // A 0 here would tell the owner this customer has no users at all. The
    // screen prints a dash; so does the file.
    expect(options.rows[1].users).toBe(EMPTY_CELL);
    expect(band(options)).toContain('Ohne Benutzerzahl: 1');
  });

  it('says nothing about missing counts when every row has one', () => {
    const options = buildCompaniesExport({ ...base, rows: [row] });
    expect(band(options)).toContain('Ganze Liste · 1 Zeilen');
    expect(band(options).some(line => line.startsWith('Ohne Benutzerzahl'))).toBe(false);
    // No totals row: a sum over a column with unknown cells is a wrong figure.
    expect(options.totals).toBeUndefined();
  });

  it('exports no column the screen does not show', () => {
    const keys = buildCompaniesExport({ ...base, rows: [row] }).columns.map(c => c.key);
    // `select('*')` hands the page these as well; widening the file is a data
    // protection decision, not a convenience.
    for (const withheld of ['legal_name', 'phone', 'address', 'postal_code', 'country', 'logo_url', 'id']) {
      expect(keys).not.toContain(withheld);
    }
  });
});

// ─── Verzeichnisse ───────────────────────────────────────────────────────────

const DIRECTORY_LABELS = {
  sheetTitle: 'Fahrzeuge',
  company: 'Unternehmen',
  status: 'Status',
  created: 'Angelegt',
  kennzeichen: 'Kennzeichen',
  tuev: 'TÜV gültig bis',
  lastHu: 'Letzte HU',
  name: 'Name',
  usage: 'Einsatzart',
  email: 'E-Mail',
  fullName: 'Name',
  role: 'Rolle',
  confirmed: 'E-Mail bestätigt',
  lastSignIn: 'Letzte Anmeldung',
  statusNames: { active: 'Aktiv', pending_invite: 'Einladung offen' },
  scope: SCOPE_LABELS,
  reducedNote: 'Reduzierte Spalten.',
  chrome: CHROME,
};

const vehicle: PlatformVehicleRow = {
  id: 'v-1', company_id: 'c-1', company_name: 'Taxi Nord GmbH', kennzeichen: 'HH-TN 123',
  status: 'active', tuev_gueltig_bis: '2027-04-30', letzte_hu: '2025-04-28', created_at: '2025-01-09',
};

const driver: PlatformDriverRow = {
  id: 'd-1', company_id: 'c-1', company_name: 'Taxi Nord GmbH', name: 'Ali Yilmaz',
  status: 'active', driver_usage_type: 'vollzeit', created_at: '2025-06-02',
};

const userRow: PlatformUserRow = {
  user_id: 'u-1', email: 'chef@taxi-nord.de', full_name: 'Jana Berg', company_id: 'c-1',
  company_name: 'Taxi Nord GmbH', role: 'admin', role_name: 'Administrator', status: 'active',
  created_at: '2025-01-09', invited_at: null, activated_at: null,
  email_confirmed_at: '2025-01-09T08:00:00Z', last_sign_in_at: '2026-09-29T19:45:00Z',
};

describe('buildDirectoryExport', () => {
  const base = { scope: { pageIndex: 0, total: 1, rowCount: 1 }, filters: [], filterLineTemplate: LINE, labels: DIRECTORY_LABELS };

  it('gives each tab its own columns, filename and complete rows', () => {
    const vehicles = buildDirectoryExport({ ...base, tab: 'vehicles', rows: [vehicle] });
    const drivers = buildDirectoryExport({ ...base, tab: 'drivers', rows: [driver] });
    const users = buildDirectoryExport({ ...base, tab: 'users', rows: [userRow] });

    for (const options of [vehicles, drivers, users]) {
      expectHealthy(options);
      // The reduced-column note travels with the file: read away from the panel,
      // it says why a column is missing.
      expect(band(options)).toContain('Reduzierte Spalten.');
    }

    expect(vehicles.filename).toBe('verzeichnis_fahrzeuge');
    expect(drivers.filename).toBe('verzeichnis_fahrer');
    expect(users.filename).toBe('verzeichnis_benutzer');

    expect(vehicles.columns.map(c => c.key))
      .toEqual(['kennzeichen', 'company', 'status', 'tuev', 'lastHu', 'created']);
    expect(vehicles.rows[0].tuev).toBe('30.04.2027');
    expect(drivers.rows[0].usage).toBe('vollzeit');
    expect(users.rows[0].role).toBe('Administrator');
    expect(users.rows[0].lastSignIn).toBe('29.09.2026 21:45:00');
  });

  it('adds no identifier the read models withhold', () => {
    // Three explicit calls rather than a loop: the input is a discriminated
    // union, and widening it to iterate would be the one cast this module exists
    // without.
    const columnSets = [
      buildDirectoryExport({ ...base, tab: 'vehicles', rows: [vehicle] }).columns,
      buildDirectoryExport({ ...base, tab: 'drivers', rows: [driver] }).columns,
      buildDirectoryExport({ ...base, tab: 'users', rows: [userRow] }).columns,
    ];
    for (const columns of columnSets) {
      const keys = columns.map(column => column.key);
      for (const forbidden of ['id', 'company_id', 'user_id', 'salary', 'iban', 'personalnummer']) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it('marks a page as a page in both the band and the filename', () => {
    const options = buildDirectoryExport({
      ...base,
      tab: 'drivers',
      rows: [driver],
      scope: { pageIndex: 3, total: 812, rowCount: 100 },
    });
    expect(options.filename).toBe('verzeichnis_fahrer_seite-4');
    expect(band(options)).toContain('Page 4 of 9 — 100 of 812 rows');
  });

  it('has no numeric column at all, so no cell can be a mistyped figure', () => {
    for (const options of [
      buildDirectoryExport({ ...base, tab: 'vehicles', rows: [vehicle] }),
      buildDirectoryExport({ ...base, tab: 'drivers', rows: [driver] }),
      buildDirectoryExport({ ...base, tab: 'users', rows: [userRow] }),
    ]) {
      expect(options.columns.every(column => !column.type || column.type === 'text')).toBe(true);
      expect(options.totals).toBeUndefined();
    }
  });
});

// ─── Protokoll ───────────────────────────────────────────────────────────────

const AUDIT_LABELS = {
  sheetTitle: 'Protokoll',
  time: 'Zeitpunkt',
  actor: 'Akteur',
  actorRole: 'Rolle',
  action: 'Aktion',
  category: 'Kategorie',
  outcome: 'Ergebnis',
  target: 'Ziel',
  targetId: 'Ziel-ID',
  company: 'Unternehmen',
  before: 'Vorher',
  after: 'Nachher',
  categoryNames: { read: 'Lesen', support: 'Support' },
  outcomeNames: { ok: 'OK', denied: 'Abgelehnt' },
  loadedNote: 'Geladene Zeilen: {rows}',
  ownScopeNote: null as string | null,
  chrome: CHROME,
};

function auditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 91,
    occurred_at: '2026-09-29T17:05:09Z',
    actor_user_id: '2f1d7f6a-0000-4000-8000-000000000001',
    actor_email: 'super@professor.com',
    actor_role: 'owner',
    session_id: null,
    company_id: 'c-1',
    company_name: 'Taxi Nord GmbH',
    category: 'support',
    action: 'support_write.drivers.update',
    outcome: 'ok',
    target_type: 'drivers',
    target_id: 'd-1',
    before_value: { values: { status: 'active' } },
    after_value: null,
    ...overrides,
  };
}

describe('buildAuditExport', () => {
  const base = { filters: [], filterLineTemplate: LINE, today: '2026-09-30', labels: AUDIT_LABELS };

  it('says how many rows were loaded, and claims no page number', () => {
    const options = buildAuditExport({ ...base, rows: [auditRow(), auditRow({ id: 92 })] });
    expectHealthy(options);
    expect(band(options)).toContain('Geladene Zeilen: 2');
    // The log pages by a keyset cursor, so there is no total to divide — "Seite 1
    // von N" would be invented.
    expect(band(options).some(line => /von \d/.test(line))).toBe(false);
    expect(options.filename).toBe('protokoll_2026-09-30');
    expect(options.totals).toBeUndefined();
  });

  it('writes a recorded value as JSON and an absent one as an empty cell', () => {
    const options = buildAuditExport({ ...base, rows: [auditRow()] });
    expect(options.rows[0].before).toBe('{"values":{"status":"active"}}');
    // Not the string "null", which would read as a recorded value of null.
    expect(options.rows[0].after).toBe('');
  });

  it('falls back to the whole actor id, never half of one', () => {
    const options = buildAuditExport({ ...base, rows: [auditRow({ actor_email: null })] });
    expect(options.rows[0].actor).toBe('2f1d7f6a-0000-4000-8000-000000000001');
  });

  it('times a row to the second, in Europe/Berlin', () => {
    const options = buildAuditExport({ ...base, rows: [auditRow()] });
    // Two rows of one transaction are ordered by nothing but the second.
    expect(options.rows[0].time).toBe('29.09.2026 19:05:09');
  });

  it('says so when the account was restricted to its own rows', () => {
    const options = buildAuditExport({
      ...base,
      rows: [auditRow()],
      labels: { ...AUDIT_LABELS, ownScopeNote: 'Nur eigene Einträge.' },
    });
    expect(band(options)).toContain('Nur eigene Einträge.');
  });
});

// ─── Team ────────────────────────────────────────────────────────────────────

const STAFF_LABELS = {
  sheetTitle: 'Team',
  member: 'Mitglied',
  userId: 'Konto-ID',
  role: 'Rolle',
  status: 'Status',
  disabledOn: 'Deaktiviert am',
  invitationPending: 'Einladung offen',
  grantedBy: 'Erteilt von',
  since: 'Seit',
  note: 'Notiz',
  roleNames: { owner: 'Inhaber', support: 'Support' },
  statusActive: 'Aktiv',
  statusDisabled: 'Deaktiviert',
  yes: 'Ja',
  no: 'Nein',
  noAddress: 'Keine Adresse',
  grantedByUnrecorded: 'Nicht erfasst',
  scopeComplete: 'Vollständige Liste — {rows} Mitglieder',
  scopeIncomplete: 'Unvollständig — {rows} Mitglieder gelesen',
  chrome: CHROME,
};

function staff(overrides: Partial<PlatformStaffRow> = {}): PlatformStaffRow {
  return {
    user_id: '2f1d7f6a-0000-4000-8000-000000000001',
    email: 'super@professor.com',
    role: 'owner',
    status: 'active',
    disabled_at: null,
    note: null,
    created_at: '2026-09-16',
    created_by: null,
    created_by_email: null,
    invitation_pending: false,
    ...overrides,
  };
}

describe('buildStaffExport', () => {
  it('says whether the roster is the whole team', () => {
    const whole = buildStaffExport({ rows: [staff()], complete: true, today: '2026-09-30', labels: STAFF_LABELS });
    expectHealthy(whole);
    expect(band(whole)).toEqual(['Vollständige Liste — 1 Mitglieder']);

    const partial = buildStaffExport({ rows: [staff()], complete: false, today: '2026-09-30', labels: STAFF_LABELS });
    expect(band(partial)).toEqual(['Unvollständig — 1 Mitglieder gelesen']);
  });

  it('distinguishes the three things "who granted it" can mean', () => {
    const options = buildStaffExport({
      rows: [
        // Written with no session at all — a migration, or psql.
        staff({ created_by: null }),
        staff({ user_id: 'u-2', email: 'b@x.de', created_by: 'u-9', created_by_email: 'owner@x.de' }),
        // Recorded, but that account is gone; the id is all that is left.
        staff({ user_id: 'u-3', email: 'c@x.de', created_by: 'u-gone', created_by_email: null }),
      ],
      complete: true,
      today: '2026-09-30',
      labels: STAFF_LABELS,
    });
    expect(options.rows.map(row => row.grantedBy)).toEqual(['Nicht erfasst', 'owner@x.de', 'u-gone']);
  });

  it('carries the full account id, which is what the add form takes', () => {
    const options = buildStaffExport({ rows: [staff()], complete: true, today: '2026-09-30', labels: STAFF_LABELS });
    expect(options.rows[0].userId).toBe('2f1d7f6a-0000-4000-8000-000000000001');
    // Column 0 is the address, so the id can never collide with a totals label.
    expect(options.columns[0].key).toBe('member');
    expect(options.totals).toBeUndefined();
  });

  it('names a disabled member and the date, and an account with no address', () => {
    const options = buildStaffExport({
      rows: [staff({ email: null, status: 'disabled', disabled_at: '2026-09-20T09:00:00Z', role: 'support' })],
      complete: true,
      today: '2026-09-30',
      labels: STAFF_LABELS,
    });
    expect(options.rows[0].member).toBe('Keine Adresse');
    expect(options.rows[0].status).toBe('Deaktiviert');
    expect(options.rows[0].disabledOn).toBe('20.09.2026');
    expect(options.rows[0].role).toBe('Support');
  });
});
