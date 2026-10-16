/**
 * The reading side of "undo the Uber import": what `uber_import_undo(true)`
 * answered, turned into something a screen can state without guessing.
 *
 * ## An unreadable preview is a failure, never "nothing to delete"
 *
 * `parseUndoPreview` returns null for anything that does not carry every count
 * and every list, and for an answer whose parts disagree (the counts it asks to
 * be sent back must equal the lists it shows). The screen offers no delete for
 * null: "0 rows will be deleted" read off a missing field would be a claim, and
 * a preview that counts differently from the delete is worse than none.
 */
import type { TranslationKey } from '../i18n';

/** "table.column" -> how many rows there refer to the driver or car. */
export type UndoBlockers = Record<string, number>;

export interface UndoRowToDelete { id: string; label: string }
export interface UndoRowKept extends UndoRowToDelete { blockers: UndoBlockers }

export interface UndoPreview {
  companyName: string;
  income: { rows: number; from: string | null; to: string | null; drivers: number };
  handTypedRows: number;
  drivers: { remove: UndoRowToDelete[]; keep: UndoRowKept[]; untouched: number };
  cars: { remove: UndoRowToDelete[]; keep: UndoRowKept[]; untouched: number };
  salariesAffected: number;
  /** Sent back verbatim with the real run; the database refuses if it changed. */
  expect: { income: number; drivers: number; cars: number };
}

type Obj = Record<string, unknown>;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isoDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function blockers(value: unknown): UndoBlockers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: UndoBlockers = {};
  for (const [source, n] of Object.entries(value as Obj)) {
    const c = count(n);
    if (c === null || c === 0) return null;
    out[source] = c;
  }
  return out;
}

function toDelete(list: unknown, labelKey: 'name' | 'plate'): UndoRowToDelete[] | null {
  if (!Array.isArray(list)) return null;
  const out: UndoRowToDelete[] = [];
  for (const entry of list) {
    const row = entry as Obj;
    if (typeof row?.id !== 'string' || typeof row[labelKey] !== 'string') return null;
    out.push({ id: row.id, label: row[labelKey] as string });
  }
  return out;
}

function toKeep(list: unknown, labelKey: 'name' | 'plate'): UndoRowKept[] | null {
  if (!Array.isArray(list)) return null;
  const out: UndoRowKept[] = [];
  for (const entry of list) {
    const row = entry as Obj;
    const why = blockers(row?.blockers);
    // A kept row with no reason is not a kept row: the database keeps nothing it did not count.
    if (typeof row?.id !== 'string' || typeof row[labelKey] !== 'string' || !why || Object.keys(why).length === 0) return null;
    out.push({ id: row.id, label: row[labelKey] as string, blockers: why });
  }
  return out;
}

function section(raw: unknown, labelKey: 'name' | 'plate') {
  const s = raw as Obj | null;
  const remove = toDelete(s?.delete, labelKey);
  const keep = toKeep(s?.keep, labelKey);
  const untouched = count(s?.untouched);
  return remove && keep && untouched !== null ? { remove, keep, untouched } : null;
}

export function parseUndoPreview(data: unknown): UndoPreview | null {
  const row = data as Obj | null;
  if (!row || row.ok !== true || row.dry_run !== true || typeof row.company_name !== 'string') return null;

  const inc = row.income as Obj | null;
  const rows = count(inc?.rows);
  const incDrivers = count(inc?.drivers);
  const from = isoDate(inc?.from);
  const to = isoDate(inc?.to);
  const hand = count(row.hand_typed_rows);
  const salaries = count(row.salaries_affected);
  const drivers = section(row.drivers, 'name');
  const cars = section(row.cars, 'plate');
  const expect = row.expect as Obj | null;
  const eIncome = count(expect?.income);
  const eDrivers = count(expect?.drivers);
  const eCars = count(expect?.cars);

  if (rows === null || incDrivers === null || from === undefined || to === undefined
      || hand === null || salaries === null || !drivers || !cars
      || eIncome === null || eDrivers === null || eCars === null) return null;
  // The numbers the delete will be held to must be the numbers on screen.
  if (eIncome !== rows || eDrivers !== drivers.remove.length || eCars !== cars.remove.length) return null;
  if ((rows > 0) !== (from !== null && to !== null)) return null;

  return {
    companyName: row.company_name,
    income: { rows, from, to, drivers: incDrivers },
    handTypedRows: hand,
    drivers,
    cars,
    salariesAffected: salaries,
    expect: { income: eIncome, drivers: eDrivers, cars: eCars },
  };
}

/** Nothing the import created is left that this action could delete. */
export function nothingToUndo(p: UndoPreview): boolean {
  return p.expect.income === 0 && p.expect.drivers === 0 && p.expect.cars === 0;
}

/** The deleting call's answer, or null when it does not carry its counts. */
export function parseUndoResult(data: unknown): { income: number; drivers: number; cars: number; keptDrivers: number; keptCars: number } | null {
  const row = data as Obj | null;
  if (!row || row.ok !== true || row.dry_run !== false) return null;
  const del = row.deleted as Obj | null;
  const kept = row.kept as Obj | null;
  const income = count(del?.income);
  const drivers = count(del?.drivers);
  const cars = count(del?.cars);
  const keptDrivers = count(kept?.drivers);
  const keptCars = count(kept?.cars);
  if (income === null || drivers === null || cars === null || keptDrivers === null || keptCars === null) return null;
  return { income, drivers, cars, keptDrivers, keptCars };
}

/** The RPC's stable HINTs. */
export function undoErrorKey(hint: unknown): TranslationKey {
  if (hint === 'platform_session_not_allowed') return 'import.error.platformSession';
  if (hint === 'not_authorized') return 'import.error.notAuthorized';
  if (hint === 'confirmation_mismatch') return 'import.undo.err.mismatch';
  if (hint === 'plan_changed') return 'import.undo.err.planChanged';
  return 'import.undo.err.generic';
}

/** Which table stands for which words; a table nobody named is printed as it is. */
const TABLE_GROUPS: Array<[RegExp, TranslationKey]> = [
  [/^salar(y|ies)$|^salary_payments$/, 'import.undo.blocker.salaries'],
  [/^salary_cash_receipts$/, 'import.undo.blocker.cashReceipts'],
  [/^receipts$/, 'import.undo.blocker.receipts'],
  [/^income$/, 'import.undo.blocker.income'],
  [/^fahrtenbuch_/, 'import.undo.blocker.fahrtenbuch'],
  [/^werkstatt_checks$/, 'import.undo.blocker.werkstatt'],
  [/^car_driver_assignments$/, 'import.undo.blocker.assignments'],
  [/^driver_notes$|^driver_month_budget$/, 'import.undo.blocker.driverData'],
  [/^saved_stundennachweise$/, 'import.undo.blocker.stundennachweise'],
  [/^monthly_plan|^company_planning|^planning_|^monthly_planning/, 'import.undo.blocker.planning'],
  [/^historical_/, 'import.undo.blocker.historical'],
  [/^partner_/, 'import.undo.blocker.partner'],
];

export function blockerGroupKey(source: string): TranslationKey | null {
  const table = source.split('.')[0] ?? source;
  return TABLE_GROUPS.find(([re]) => re.test(table))?.[1] ?? null;
}

/** "Gehälter (1), Belege (2)": rows summed per words, so two columns of one table read as one. */
export function summariseBlockers(
  why: UndoBlockers,
  label: (key: TranslationKey) => string,
): string {
  const byLabel = new Map<string, number>();
  for (const [source, n] of Object.entries(why)) {
    const key = blockerGroupKey(source);
    const name = key ? label(key) : source.split('.')[0] ?? source;
    byLabel.set(name, (byLabel.get(name) ?? 0) + n);
  }
  return [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b, 'de')).map(([name, n]) => `${name} (${n})`).join(', ');
}
