import { describe, expect, it } from 'vitest';
import { CONTRACT_LIMITS, type PayloadCell } from '../../lib/workbookContract';
import type { FullMonthResult } from './fullMonth';
import { SIMULATED_FILE_PREFIX, SIMULATED_NOTICE, SIMULATED_SHEET_NAME } from './marker';
import {
  LABEL_HEADER, LABEL_VALUE, SHEET_CHECKS, SHEET_DAYS, SHEET_DECISIONS, SHEET_DECLINED, SHEET_DRIVERS,
  SHEET_EVENTS, SHEET_ORDER, SHEET_RIDES, SHEET_ROUTES, SHEET_SOURCE, SHEET_VEHICLES, TOTAL_LABEL,
  buildMonthReport, contractProblem, labelled, monthTotals, payloadCost, reconcile, totalsByDriver, totalsByVehicle,
} from './monthWorkbook';
import { buildFixtureMonth } from '../../../scripts/lib/reportFixture';

/** Invented data only: see reportFixture.ts. */
const month = (year: number, m: number, extra: Partial<Parameters<typeof buildFixtureMonth>[0]> = {}): Promise<FullMonthResult> =>
  buildFixtureMonth({ year, month: m, seed: 4711, ...extra });

type Table = Record<string, PayloadCell>[];

function readBack(result: FullMonthResult) {
  const report = buildMonthReport(result);
  const rowsOf = (name: string): PayloadCell[][] => {
    const sheet = report.payload.sheets.find(s => s.name === name);
    if (!sheet) throw new Error(`no sheet ${name}`);
    return sheet.rows;
  };
  const tableOf = (name: string): Table => {
    const [header, ...body] = rowsOf(name);
    return body.map(r => Object.fromEntries(header.map((h, i) => [String(h), r[i] ?? null])));
  };
  return { report, rowsOf, tableOf, names: report.payload.sheets.map(s => s.name) };
}

const cents = (cell: PayloadCell): number => Math.round(Number(cell) * 100);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const CASES: Array<[string, number, number, number]> = [
  ['31-day month', 2026, 10, 31],
  ['30-day month', 2026, 9, 30],
  ['February of a leap year', 2024, 2, 29],
  ['February of a non-leap year', 2026, 2, 28],
];

describe.each(CASES)('the month report, %s', (_label, year, m, dayCount) => {
  let result: FullMonthResult;
  let book: ReturnType<typeof readBack>;
  it('builds', async () => {
    result = await month(year, m);
    book = readBack(result);
  });

  it('has the sheets in the contracted order and the SIMULIERT notice last', () => {
    expect(book.names).toEqual([...SHEET_ORDER]);
    expect(book.names[book.names.length - 1]).toBe(SIMULATED_SHEET_NAME);
    for (const name of book.names) expect(name.length).toBeLessThanOrEqual(CONTRACT_LIMITS.maxSheetNameLength);
    expect(book.report.fileName.startsWith(SIMULATED_FILE_PREFIX)).toBe(true);
    expect(book.report.fileName).toContain(`Monatsbericht_${year}-${String(m).padStart(2, '0')}_4711`);
    expect(book.report.payload.sheets.every(s => s.header === true)).toBe(true);
  });

  it('puts the label in the first column of EVERY row of every sheet', () => {
    for (const sheet of book.report.payload.sheets) {
      if (sheet.name === SIMULATED_SHEET_NAME) {
        expect(sheet.rows).toEqual([[SIMULATED_NOTICE]]);
        continue;
      }
      expect(sheet.rows[0][0], sheet.name).toBe(LABEL_HEADER);
      expect(sheet.rows.length, sheet.name).toBeGreaterThan(1);
      for (const [i, row] of sheet.rows.slice(1).entries()) expect(row[0], `${sheet.name} row ${i + 2}`).toBe(LABEL_VALUE);
    }
  });

  it('keeps every number bare and every cell a string, a number or empty', () => {
    for (const sheet of book.report.payload.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row) {
          expect(cell === null || typeof cell === 'string' || typeof cell === 'number').toBe(true);
          if (typeof cell === 'number') expect(Number.isFinite(cell)).toBe(true);
        }
      }
    }
  });

  it('lists exactly one row per calendar day in sheet B, zero-ride days included', () => {
    const days = book.tableOf(SHEET_DAYS).filter(r => r.Datum !== TOTAL_LABEL);
    expect(days).toHaveLength(dayCount);
    expect(days.map(r => r.Datum)).toEqual(
      Array.from({ length: dayCount }, (_, i) => `${year}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`),
    );
    const empty = days.filter(r => r['Tag ohne Fahrt'] === 'Ja');
    expect(empty.length).toBeGreaterThan(0);
    for (const row of empty) {
      expect(row.Auftraege).toBe(0);
      expect(String(row.Grund).length).toBeGreaterThan(0);
    }
  });

  it('reconciles the money per day, per driver and per vehicle with the ride sheet, in cents', () => {
    const rides = book.tableOf(SHEET_RIDES);
    const total = sum(rides.filter(r => r.Status === 'abgeschlossen').map(r => cents(r['Fahrpreis (EUR)'])));
    expect(total).toBe(result.revenue.fareCents);
    expect(total).toBeGreaterThan(0);
    for (const [sheet, key] of [[SHEET_DAYS, 'Datum'], [SHEET_DRIVERS, 'Fahrer'], [SHEET_VEHICLES, 'Fahrzeug']] as const) {
      const rows = book.tableOf(sheet);
      const totalRow = rows.find(r => r[key] === TOTAL_LABEL)!;
      expect(cents(totalRow['Fahrpreise (EUR)']), sheet).toBe(total);
      expect(sum(rows.filter(r => r !== totalRow).map(r => cents(r['Fahrpreise (EUR)']))), `${sheet} parts`).toBe(total);
    }
  });

  it('reconciles every measure with no difference, and says so on sheet F', () => {
    for (const row of reconcile(result)) expect(row.partsSum, row.label).toBe(row.total);
    const checks = book.tableOf(SHEET_CHECKS).filter(r => r.Abschnitt === 'Abgleich');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(r => r.Ergebnis === 'OK' && r.Differenz === 0)).toBe(true);
  });

  it('sums orders, tips, decline fees and kilometres without double counting', () => {
    const t = monthTotals(result);
    expect(sum(totalsByDriver(result.month.rides, result.provenance.settings).map(x => x.orders))).toBe(t.orders);
    expect(sum(totalsByVehicle(result.month.rides, result.provenance.settings).map(x => x.declinedFeeCents)))
      .toBe(t.declinedFeeCents);
    expect(t.orders).toBe(t.completed + t.cancelled + t.declined);
    expect(t.appFareCents + t.cashFareCents).toBe(t.fareCents);
  });

  it('prints one route row per check, with no summary above the header', () => {
    const rows = book.report.payload.sheets.find(s => s.name === SHEET_ROUTES)!.rows;
    expect(rows).toHaveLength(result.routeChecks.length + 1);
    expect(rows[0][1]).toBe('Gruppierung');
  });

  it('fits the contract, and the cost of this month is below every limit', () => {
    const cost = payloadCost(book.report.payload);
    expect(contractProblem(cost)).toBeNull();
    expect(cost.cells).toBeLessThan(CONTRACT_LIMITS.maxCells);
  });
});

describe('declined and cancelled rides', () => {
  it('writes a declined ride with the fee and its rule, and a cancellation with neither', async () => {
    const result = await month(2026, 10);
    const rides = readBack(result).tableOf(SHEET_RIDES);
    const declined = rides.filter(r => r.Status === 'abgelehnt');
    expect(declined).toHaveLength(result.revenue.counts.declined);
    expect(declined.length).toBeGreaterThan(0);
    for (const r of declined) {
      expect(cents(r['Gebuehr (EUR)'])).toBe(result.provenance.settings.declinedFeeCents);
      expect(r.Gebuehrenregel).toBe('idle_in_shift');
      expect(cents(r['Fahrpreis (EUR)'])).toBe(0);
    }
    expect(sum(declined.map(r => cents(r['Gebuehr (EUR)'])))).toBe(declined.length * 600);
    const cancelled = rides.filter(r => r.Status === 'storniert');
    expect(cancelled.length).toBeGreaterThan(0);
    for (const r of cancelled) {
      expect(cents(r['Gebuehr (EUR)'])).toBe(0);
      expect(r.Gebuehrenregel).toBe('');
    }
    const e = readBack(result).tableOf(SHEET_DECLINED);
    expect(e).toHaveLength(declined.length + cancelled.length);
  });
});

describe('the share block, the decisions and the source sheet', () => {
  it('prints basis, contents, rate, amount and remainder, and says the share is no tax and no commission', async () => {
    const result = await month(2026, 10);
    const lines = new Map(readBack(result).tableOf(SHEET_CHECKS).filter(r => r.Abschnitt !== 'Abgleich').map(r => [r.Posten, r['Wert / Summe der Teile']]));
    expect(result.share).not.toBeNull();
    expect(cents(lines.get('Betrag (EUR)') as PayloadCell) + cents(lines.get('Rest, falls Abzug (EUR)') as PayloadCell))
      .toBe(result.basis.basisCents);
    expect(cents(lines.get('Zahlung App (EUR)') as PayloadCell) + cents(lines.get('Zahlung Bar (EUR)') as PayloadCell))
      .toBe(result.revenue.fareCents);
    expect(Number(lines.get('Satz (%)'))).toBeGreaterThanOrEqual(30);
    expect(Number(lines.get('Satz (%)'))).toBeLessThanOrEqual(33);
    expect(String(lines.get('Grundlage enthaelt'))).toContain('Fahrpreise');
    expect(String(lines.get('Hinweis Monatsanteil'))).toContain('weder eine Steuer noch eine Provision');
  });

  it('lists the constraint log and every shift decision with the driver resolved by id', async () => {
    const result = await month(2026, 10);
    const book = readBack(result);
    expect(book.tableOf(SHEET_EVENTS)).toHaveLength(result.constraints.length);
    const decisions = book.tableOf(SHEET_DECISIONS);
    expect(decisions).toHaveLength(result.decisions.length);
    expect(decisions.some(d => d.Ergebnis === 'nicht eingeplant' && d.Code === 'driver_blocked_by_note')).toBe(true);
    expect(decisions.some(d => d.Ergebnis === 'eingeplant, zu pruefen')).toBe(true);
    const blocked = decisions.find(d => d.Code === 'driver_blocked_by_note')!;
    expect(blocked.Fahrer).toBe('Fahrer 1');
    expect(decisions.every(d => !String(d.Fahrer).match(/^[0-9a-f]{8}-/))).toBe(true);
  });

  it('names the seed, the generator, the travel source and the routing provenance', async () => {
    const result = await month(2026, 10);
    const rows = readBack(result).tableOf(SHEET_SOURCE);
    const text = rows.map(r => `${r.Angabe} | ${r.Wert}`).join('\n');
    expect(text).toContain(String(result.provenance.seed));
    expect(text).toContain(result.provenance.generatorVersion);
    expect(text).toContain('Fahrzeit gemessen | Ja');
    expect(text).toContain('Routing: berechnete Paare');
    expect(text).toContain('simuliert');
    expect(text).toContain('kein Nachweis');
    expect(text).toContain(SIMULATED_NOTICE);
  });
});

describe('the contract limits', () => {
  it('say in German which limit a too-large month would break', () => {
    const base = { sheets: 11, cells: 1000, maxRows: 10, maxColumns: 10, bytes: 1000 };
    expect(contractProblem(base)).toBeNull();
    expect(contractProblem({ ...base, cells: CONTRACT_LIMITS.maxCells + 1 })).toContain('Zellen');
    expect(contractProblem({ ...base, maxRows: CONTRACT_LIMITS.maxRowsPerSheet + 1 })).toContain('Zeilen');
    expect(contractProblem({ ...base, bytes: CONTRACT_LIMITS.maxBodyBytes + 1 })).toContain('Bytes');
  });

  it('labelled() never lets a blank row through unlabelled', () => {
    expect(labelled([['a'], [], ['b']]).map(r => r[0])).toEqual([LABEL_HEADER, LABEL_VALUE, LABEL_VALUE]);
  });
});
