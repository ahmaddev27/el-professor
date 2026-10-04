import { describe, expect, it } from 'vitest';
import {
  buildAbrechnungExport,
  buildFahrtenlisteExport,
  buildGehaltsquittungExport,
  buildRolesExport,
  type AbrechnungExportLabels,
  type ExportChromeText,
  type FahrtenlisteExportLabels,
  type GehaltsquittungExportLabels,
  type RolesExportLabels,
} from './tableExportRows';
import { buildTableWorkbook, type ExportColumn, type ExportOptions } from './excelExport';
import { ROLE_PAGE_KEYS } from '../lib/companyRoles';
import type { RolePermission } from '../types/role';

/*
  Four screens had no Excel export: Abrechnung, the Gehaltsquittung ledger, the
  Fahrtenliste and the Rollen matrix. Every defect such an export can carry is a
  wrong column, a wrong unit or a wrong order, so the builders are pure and this
  file pins all three. Before the change there was nothing to test: the module
  did not exist and the four screens had no export handler, which is why each
  assertion below names what it would catch afterwards.

  The three that would have shipped a plausible wrong number, and are therefore
  the reason this file exists:

   - a money cell holding integer cents instead of euros (a factor of 100);
   - the Gehaltsquittung ledger ordered by parsing GQ-YYYY out of the receipt
     number, which changed meaning mid-history (20260919160000);
   - the Rollen matrix flattened from the stored permission rows, which omits
     every area a role does not permit instead of showing it as No.
*/

const CHROME: ExportChromeText = {
  empty: 'no data',
  filters: 'filters:',
  totals: 'total ({count})',
};

/** The cell a column writes for a row, as `buildTableWorkbook` resolves it. */
function cellOf(options: ExportOptions, key: string, rowIndex: number): unknown {
  const column = options.columns.find(candidate => candidate.key === key);
  if (!column) throw new Error(`no column '${key}'`);
  return options.rows[rowIndex][key];
}

function typeOf(options: ExportOptions, key: string): ExportColumn['type'] {
  const column = options.columns.find(candidate => candidate.key === key);
  if (!column) throw new Error(`no column '${key}'`);
  return column.type;
}

// ─── Abrechnung ───────────────────────────────────────────────────────────────

const ABR_LABELS: AbrechnungExportLabels = {
  sheetTitle: 'Abrechnung',
  week: 'Woche',
  weeks: 'Wochen',
  driver: 'Fahrer',
  belege: 'Belege',
  spent: 'Ausgegeben',
  cash: 'Bargeld',
  barZurueck: 'Bar zurück',
  chrome: CHROME,
};

const WEEKLY_ROWS = [
  // PostgREST serialises a numeric as a string; the amounts below are EUROS.
  { week_number: 37, driver_name: 'Ali', anzahl_belege: 3, ausgegebene_bargeld: '120.50', bargeld: '900.00', bar_zuruck: '779.50' },
  { week_number: 38, driver_name: 'Ben', anzahl_belege: 1, ausgegebene_bargeld: 40, bargeld: 0, bar_zuruck: -40 },
];

const WEEKLY_TOTALS = {
  anzahl_belege: 4,
  ausgegebene_bargeld: 160.5,
  bargeld: 900,
  // Deliberately NOT the sum of the two rows above (739.5): this is the value
  // the screen's own reducer handed in, and the builder must write it verbatim.
  bar_zuruck: 1234.56,
};

describe('buildAbrechnungExport', () => {
  const weekly = buildAbrechnungExport({
    mode: 'weekly',
    rows: WEEKLY_ROWS,
    totals: WEEKLY_TOTALS,
    year: 2026,
    month: 9,
    filterSummary: ['Zeitraum: September 2026', 'Fahrer: Alle Fahrer'],
    labels: ABR_LABELS,
  });

  it('declares a type on every numeric column, so Excel can sum them', () => {
    // Without `type` a cell is written as TEXT and cannot be summed — the defect
    // #150 fixed for the six older exports. A column that silently loses its
    // `type` later is what this catches.
    expect(typeOf(weekly, 'week')).toBe('integer');
    expect(typeOf(weekly, 'belege')).toBe('integer');
    expect(typeOf(weekly, 'spent')).toBe('money');
    expect(typeOf(weekly, 'cash')).toBe('money');
    expect(typeOf(weekly, 'barZurueck')).toBe('money');
    expect(typeOf(weekly, 'driver')).toBeUndefined();
  });

  it('writes money in euros, exactly as the RPC returned it', () => {
    // The unit check: 120.50 euros, not 12050 cents. A cents value here would
    // print "12.050,00 €" and look entirely plausible.
    expect(cellOf(weekly, 'spent', 0)).toBe('120.50');
    expect(cellOf(weekly, 'cash', 0)).toBe('900.00');
    expect(cellOf(weekly, 'spent', 1)).toBe(40);
  });

  it('keeps the sign of bar_zuruck, where positive means the driver owes the company', () => {
    // A negation would pass every other assertion in this file and invert the
    // meaning of the column the office reconciles against the Steuerberater's.
    expect(cellOf(weekly, 'barZurueck', 0)).toBe('779.50');
    expect(cellOf(weekly, 'barZurueck', 1)).toBe(-40);
    expect(weekly.totals?.barZurueck).toBe(1234.56);
  });

  it('writes the screen\'s totals verbatim and computes none of its own', () => {
    // WEEKLY_TOTALS.bar_zuruck is not the row sum on purpose. An implementation
    // that reduced the rows itself would write 739.5 here.
    expect(weekly.totals).toEqual({
      belege: 4,
      spent: 160.5,
      cash: 900,
      barZurueck: 1234.56,
    });
  });

  it('never names column 0 in totals, which the exporter refuses', () => {
    // `buildTableWorkbook` throws when `totals` names `columns[0].key`, because
    // that cell is the row's label. Weekly starts at `week`, monthly at `driver`.
    expect(weekly.columns[0].key).toBe('week');
    expect(Object.keys(weekly.totals ?? {})).not.toContain('week');
    expect(() => buildTableWorkbook(weekly)).not.toThrow();

    const monthly = buildAbrechnungExport({
      mode: 'monthly',
      rows: [{ driver_name: 'Ali', week_count: 5, anzahl_belege: 3, ausgegebene_bargeld: '10.00', bargeld: '20.00', bar_zuruck: '10.00' }],
      totals: WEEKLY_TOTALS,
      year: 2026,
      month: 9,
      filterSummary: [],
      labels: ABR_LABELS,
    });
    expect(monthly.columns[0].key).toBe('driver');
    expect(Object.keys(monthly.totals ?? {})).not.toContain('driver');
    // week_count has no total: the screen's monthly reducer does not sum it.
    expect(Object.keys(monthly.totals ?? {})).not.toContain('weeks');
    expect(typeOf(monthly, 'weeks')).toBe('integer');
    expect(() => buildTableWorkbook(monthly)).not.toThrow();
  });

  it('names the applied filter and the period, in the language it was given', () => {
    expect(weekly.filterSummary).toEqual(['Zeitraum: September 2026', 'Fahrer: Alle Fahrer']);
    expect(weekly.filename).toBe('abrechnung_woche_2026-09');
    expect(weekly.labels).toEqual({
      emptyState: 'no data',
      activeFilters: 'filters:',
      totalsRow: 'total ({count})',
    });
  });
});

// ─── Gehaltsquittungen ────────────────────────────────────────────────────────

const GQ_LABELS: GehaltsquittungExportLabels = {
  sheetTitle: 'Gehaltsquittungen',
  number: 'Nummer',
  driver: 'Fahrer',
  businessYear: 'Geschäftsjahr',
  businessMonth: 'Abrechnungsmonat',
  periodFrom: 'von',
  periodTo: 'bis',
  paymentDate: 'Zahltag',
  amount: 'Betrag',
  status: 'Status',
  voidedOn: 'Storniert am',
  signed: 'Unterschrift',
  statusConfirmed: 'Bestätigt',
  statusVoided: 'Storniert',
  signedPresent: 'Vorhanden',
  signedMissing: 'Fehlt',
  monthNames: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  chrome: CHROME,
};

/*
  The trap, in data. GQ-YYYY is the SALARY's business year since 20260919160000
  and the PAYMENT's year before it, and no receipt is ever renumbered — so both
  conventions exist in one company's ledger. These three rows make the two
  disagree: `GQ-2025-0009` belongs to business year 2026, so an implementation
  that parsed the year out of the number would sort it into 2025.
*/
const GQ_ROWS = [
  {
    receipt_number: 'GQ-2025-0009', driver: { name: 'Ben' },
    business_year: 2026, business_month: 1,
    period_start: '2026-01-01', period_end: '2026-01-31', payment_date: '2026-02-03',
    amount: '300.00', status: 'confirmed' as const, voided_at: null, signed_copy_path: null,
  },
  {
    receipt_number: 'GQ-2026-0001', driver: { name: 'Ali' },
    business_year: 2025, business_month: 12,
    period_start: '2025-12-01', period_end: '2025-12-31', payment_date: '2026-01-05',
    amount: 250.5, status: 'confirmed' as const, voided_at: null, signed_copy_path: 'x/y.pdf',
  },
  {
    receipt_number: 'GQ-2026-0002', driver: { name: 'Cem' },
    business_year: 2026, business_month: 1,
    period_start: '2026-01-01', period_end: '2026-01-31', payment_date: '2026-02-04',
    // 23:30 UTC on the 4th is 00:30 Berlin on the 5th — the Storno is booked on
    // the Berlin day, which is the day the cash went back.
    amount: '100.00', status: 'voided' as const, voided_at: '2026-02-04T23:30:00Z', signed_copy_path: null,
  },
];

describe('buildGehaltsquittungExport', () => {
  const options = buildGehaltsquittungExport({
    rows: GQ_ROWS,
    filterSummary: ['Alle Gehaltsquittungen, inklusive Stornos'],
    today: '2026-02-05',
    labels: GQ_LABELS,
  });

  it('orders by the stored business year and month, never by the receipt number', () => {
    // THE test that kills a number-parsing implementation. By GQ-YYYY the order
    // would be GQ-2026-0001, GQ-2026-0002, GQ-2025-0009; by the stored business
    // year it is the two 2026-01 receipts first, then the 2025-12 one.
    expect(options.rows.map(row => row.number)).toEqual(['GQ-2025-0009', 'GQ-2026-0002', 'GQ-2026-0001']);
    expect(options.rows.map(row => row.businessYear)).toEqual([2026, 2026, 2025]);
    expect(options.rows.map(row => row.businessMonth)).toEqual(['Januar', 'Januar', 'Dezember']);
  });

  it('writes the amount in euros, not in cents', () => {
    // toCents('300.00') is 30000; the money format would print "30.000,00 €".
    expect(cellOf(options, 'amount', 0)).toBe(300);
    expect(options.rows.map(row => row.amount)).toEqual([300, 100, 250.5]);
    expect(typeOf(options, 'amount')).toBe('money');
    expect(typeOf(options, 'businessYear')).toBe('integer');
  });

  it('keeps a voided receipt, marked as voided, with its Berlin void day', () => {
    // An implementation that filtered to `confirmed` would pass every other
    // assertion here and turn the ledger into a payout list.
    const voided = options.rows[1];
    expect(voided.number).toBe('GQ-2026-0002');
    expect(voided.status).toBe('Storniert');
    expect(voided.voidedOn).toBe('05.02.2026');
    expect(options.rows[0].voidedOn).toBe('');
  });

  it('writes no totals row, because a payout sum over Stornos is a wrong figure', () => {
    expect(options.totals).toBeUndefined();
    expect(options.columns[0].key).toBe('number');
    expect(() => buildTableWorkbook(options)).not.toThrow();
  });

  it('splits the period into two filterable columns and dates them German', () => {
    expect(options.rows[2].periodFrom).toBe('01.12.2025');
    expect(options.rows[2].periodTo).toBe('31.12.2025');
    expect(options.rows[2].paymentDate).toBe('05.01.2026');
    expect(options.filename).toBe('gehaltsquittungen_2026-02-05');
    expect(options.filterSummary).toEqual(['Alle Gehaltsquittungen, inklusive Stornos']);
  });

  it('marks the signed copy from the stored path', () => {
    expect(options.rows.map(row => row.signed)).toEqual(['Fehlt', 'Fehlt', 'Vorhanden']);
  });
});

// ─── Fahrtenliste ─────────────────────────────────────────────────────────────

const TRIP_LABELS: FahrtenlisteExportLabels = {
  sheetTitle: 'Fahrtenliste',
  date: 'Datum der Fahrt',
  startAt: 'Start',
  endAt: 'Ende',
  timeSource: 'Zeitquelle',
  start: 'von',
  end: 'bis',
  plate: 'Kennzeichen',
  originalDriver: 'Fahrer (Datei)',
  assignedDriver: 'Zugewiesen',
  pickup: 'Start',
  destination: 'Ziel',
  fare: 'Preis',
  tip: 'Trinkgeld',
  status: 'Status',
  canceled: 'Storniert',
  yes: 'Ja',
  no: 'Nein',
  statusNames: { pending: 'Offen', canceled: 'Storniert' },
  timeSourceNames: { source_start_end: 'Quelle', fallback_trip_date: 'Ersatz' },
  chrome: CHROME,
};

const TRIPS = [
  {
    // The Uber export dates a ride starting just after midnight a day early:
    // trip_date is the 22nd, the ride starts 00:15 Berlin on the 23rd.
    trip_date: '2026-09-22',
    start_at: '2026-09-22T22:15:00Z',
    end_at: '2026-09-22T22:41:00Z',
    time_source: 'source_start_end',
    start_time: '00:15:00', end_time: '00:41:00',
    car_identifier: 'B-YA 47', original_driver_name: 'Ali', assigned_driver_name: 'Ali',
    route_start: 'Hbf', route_end: 'Flughafen',
    price_amount: 32.4, tip_amount: 2.5,
    plausibility_status: 'pending', is_canceled: false,
  },
  {
    trip_date: '2026-09-23',
    start_at: null, end_at: null, time_source: 'missing',
    start_time: null, end_time: null,
    car_identifier: null, original_driver_name: 'Ben', assigned_driver_name: 'Cem',
    route_start: null, route_end: null,
    // A cancelled ride keeps its fare in the import (only cash/online are zeroed).
    price_amount: 18, tip_amount: 0,
    plausibility_status: 'canceled', is_canceled: true,
  },
];

describe('buildFahrtenlisteExport', () => {
  const options = buildFahrtenlisteExport({
    trips: TRIPS,
    filterSummary: ['Zeitraum: September 2026', '1 aktiv + 1 storniert'],
    year: 2026,
    month: 9,
    labels: TRIP_LABELS,
  });

  it('writes the ride\'s real start beside the file\'s date, in Berlin', () => {
    // Domain rule: start_at is the ride's real start; trip_date is the file's
    // "Datum der Fahrt", a day early here. Both must be readable side by side,
    // or the day-early rows cannot be found at all.
    expect(options.rows[0].date).toBe('22.09.2026');
    expect(options.rows[0].startAt).toBe('23.09.2026 00:15');
    expect(options.rows[0].endAt).toBe('23.09.2026 00:41');
    expect(options.rows[0].timeSource).toBe('Quelle');
    // A missing instant is empty, never a guessed date.
    expect(options.rows[1].startAt).toBe('');
    expect(options.rows[1].endAt).toBe('');
    // An unmapped time_source is written verbatim, as the screen's status does.
    expect(options.rows[1].timeSource).toBe('missing');
  });

  it('lists a cancelled ride, marks it, and writes no money total at all', () => {
    // The screen's own Gesamtpreis / Gesamttrinkgeld reduce over every filtered
    // trip with no is_canceled term, and the importer keeps a cancelled ride's
    // fare. Exporting those totals would count a cancelled ride; recomputing
    // them without one would be a figure the screen never showed.
    expect(options.rows[1].canceled).toBe('Ja');
    expect(options.rows[0].canceled).toBe('Nein');
    expect(options.totals).toBeUndefined();
    expect(options.columns[0].key).toBe('date');
    expect(() => buildTableWorkbook(options)).not.toThrow();
  });

  it('writes fare and tip as euros in money columns', () => {
    // parseMoney stores Math.round(n * 100) / 100 — euros, two decimals.
    expect(cellOf(options, 'fare', 0)).toBe(32.4);
    expect(cellOf(options, 'tip', 0)).toBe(2.5);
    expect(cellOf(options, 'fare', 1)).toBe(18);
    expect(typeOf(options, 'fare')).toBe('money');
    expect(typeOf(options, 'tip')).toBe('money');
  });

  it('writes the assigned driver in full, not the screen\'s dash', () => {
    // The screen draws "—" when the assigned driver is the original one; a file
    // is read without the screen beside it.
    expect(options.rows[0].assignedDriver).toBe('Ali');
    expect(options.rows[1].assignedDriver).toBe('Cem');
    expect(options.rows[1].originalDriver).toBe('Ben');
  });

  it('is named for the Fahrtenliste and never for the Fahrtenbuch', () => {
    // The statutory corrected Fahrtenbuch is the screen's other button. A file
    // that shared its noun or its slug would be mistaken for it.
    expect(options.filename).toBe('fahrtenliste_2026-09');
    expect(options.sheetTitle).toBe('Fahrtenliste');
    expect(options.filterSummary).toEqual(['Zeitraum: September 2026', '1 aktiv + 1 storniert']);
  });
});

// ─── Rollen ───────────────────────────────────────────────────────────────────

const ROLE_LABELS: RolesExportLabels = {
  sheetTitle: 'Rollenverwaltung',
  role: 'Rolle',
  roleType: 'Typ',
  typeSystem: 'System',
  typeCustom: 'Benutzerdefiniert',
  description: 'Beschreibung',
  holders: 'Benutzer',
  area: 'Bereich',
  areaKey: 'Schlüssel',
  view: 'Ansehen',
  edit: 'Bearbeiten',
  yes: 'Ja',
  no: 'Nein',
  areaNames: Object.fromEntries(ROLE_PAGE_KEYS.map(key => [key, `Bereich ${key}`])),
  scope: 'Eigene Rollen und Systemvorlagen',
  chrome: CHROME,
};

function permission(pageKey: string, canView: boolean, canEdit: boolean): RolePermission {
  return { id: `p-${pageKey}`, role_id: 'r1', page_key: pageKey, can_view: canView, can_edit: canEdit, created_at: '2026-01-01' };
}

describe('buildRolesExport', () => {
  const options = buildRolesExport({
    companyRoles: [{
      id: 'r1', name: 'Büro', description: 'Innendienst', is_system: false,
      // Two stored rows only. The other fourteen areas have NO row at all — the
      // shape permissionsFromTemplate's docblock warns about.
      permissions: [permission('drivers', true, false), permission('salaries', false, true)],
    }],
    templates: [{ id: 'r2', name: 'viewer', description: 'Nur lesen', is_system: true, permissions: [] }],
    holders: { r1: 3 },
    labels: ROLE_LABELS,
  });

  it('exports every area for every role, not only the stored rows', () => {
    // THE test that kills the flatten. `role.permissions.map(...)` would emit
    // two rows for Büro and none for the template, and an access review would
    // read "no row" as "not applicable" rather than "no access".
    //
    // Counted against ROLE_PAGE_KEYS rather than the literal 16, so a migration
    // that adds a page does not fail here as well as in rolePageKeys.test.ts,
    // which is the file that pins the list itself.
    const areas = ROLE_PAGE_KEYS.length;
    expect(options.rows.length).toBe(areas * 2);
    expect(options.rows.filter(row => row.role === 'Büro').length).toBe(areas);
    expect(options.rows.filter(row => row.role === 'viewer').length).toBe(areas);
    const noAccess = options.rows.filter(row => row.role === 'Büro' && row.view === 'Nein' && row.edit === 'Nein');
    expect(noAccess.length).toBe(areas - 2);
  });

  it('applies can_edit implies can_view, as the form and the RPC do', () => {
    // The stored row for `salaries` says {can_view: false, can_edit: true}.
    // Copying it verbatim would print a role that may write a page it may not
    // read — which is not what current_role_permits enforces.
    const salaries = options.rows.find(row => row.role === 'Büro' && row.areaKey === 'salaries');
    expect(salaries?.view).toBe('Ja');
    expect(salaries?.edit).toBe('Ja');
    const drivers = options.rows.find(row => row.role === 'Büro' && row.areaKey === 'drivers');
    expect(drivers?.view).toBe('Ja');
    expect(drivers?.edit).toBe('Nein');
  });

  it('carries the role\'s type, holder count and both area names', () => {
    const first = options.rows[0];
    expect(first.roleType).toBe('Benutzerdefiniert');
    expect(first.holders).toBe(3);
    expect(first.areaKey).toBe(ROLE_PAGE_KEYS[0]);
    expect(first.area).toBe(`Bereich ${ROLE_PAGE_KEYS[0]}`);
    // A role nobody holds counts 0, never blank.
    expect(options.rows.find(row => row.role === 'viewer')?.holders).toBe(0);
    expect(options.rows.find(row => row.role === 'viewer')?.roleType).toBe('System');
    expect(typeOf(options, 'holders')).toBe('integer');
  });

  it('lists the company\'s own roles before the templates', () => {
    expect(options.rows[0].role).toBe('Büro');
    expect(options.rows[ROLE_PAGE_KEYS.length].role).toBe('viewer');
  });

  it('carries no totals row and a first column that is not a figure', () => {
    expect(options.totals).toBeUndefined();
    expect(options.columns[0].key).toBe('role');
    expect(options.filterSummary).toEqual(['Eigene Rollen und Systemvorlagen']);
    expect(() => buildTableWorkbook(options)).not.toThrow();
  });
});

// ─── All four ─────────────────────────────────────────────────────────────────

describe('all four exports', () => {
  it('pass the workbook chrome, so no file is half German and half English', () => {
    // Not one of the six existing callers passes `labels`, so their chrome is
    // German whatever the UI language. These four pass it; `{count}` survives
    // because `interpolate` returns the template unchanged with no vars.
    const built = [
      buildAbrechnungExport({ mode: 'monthly', rows: [], totals: { anzahl_belege: 0, ausgegebene_bargeld: 0, bargeld: 0, bar_zuruck: 0 }, year: 2026, month: 9, filterSummary: [], labels: ABR_LABELS }),
      buildGehaltsquittungExport({ rows: [], filterSummary: [], today: '2026-02-05', labels: GQ_LABELS }),
      buildFahrtenlisteExport({ trips: [], filterSummary: [], year: 2026, month: 9, labels: TRIP_LABELS }),
      buildRolesExport({ companyRoles: [], templates: [], holders: {}, labels: ROLE_LABELS }),
    ];
    for (const options of built) {
      expect(options.labels?.totalsRow).toBe('total ({count})');
      expect(options.labels?.emptyState).toBe('no data');
      // An empty list still builds a workbook, with the empty-state cell.
      expect(() => buildTableWorkbook(options)).not.toThrow();
    }
  });

  it('give every column a label and a key the rows actually carry', () => {
    // ExportColumn.key is a bare string, which is how the Fahrer export's
    // "Erstellt am" column was blank for every driver until #153: the column
    // named a key no row had. This fails on a typo in either direction.
    const built = [
      buildAbrechnungExport({ mode: 'weekly', rows: WEEKLY_ROWS, totals: WEEKLY_TOTALS, year: 2026, month: 9, filterSummary: [], labels: ABR_LABELS }),
      buildGehaltsquittungExport({ rows: GQ_ROWS, filterSummary: [], today: '2026-02-05', labels: GQ_LABELS }),
      buildFahrtenlisteExport({ trips: TRIPS, filterSummary: [], year: 2026, month: 9, labels: TRIP_LABELS }),
      buildRolesExport({ companyRoles: [{ id: 'r1', name: 'Büro', description: '', is_system: false, permissions: [] }], templates: [], holders: {}, labels: ROLE_LABELS }),
    ];
    for (const options of built) {
      expect(options.columns.length).toBeGreaterThan(0);
      for (const column of options.columns) {
        expect(column.label).toBeTruthy();
        for (const row of options.rows) {
          expect(Object.prototype.hasOwnProperty.call(row, column.key)).toBe(true);
        }
      }
      // And no row carries a key no column writes, which would be a silent loss.
      const keys = new Set(options.columns.map(column => column.key));
      for (const row of options.rows) {
        for (const key of Object.keys(row)) expect(keys.has(key)).toBe(true);
      }
    }
  });
});
