/**
 * Deleting a driver for good (owner, 27.11.2026, reversing the rule of
 * 25.10.2026 that a driver is only ever deactivated).
 *
 * The database is the wall: a trigger on `drivers` refuses the delete while any
 * row of any table refers to the driver, whatever path the request takes. This
 * module is the courtesy in front of it. It asks `driver_delete_check` first so
 * the person is told WHY before pressing a button that cannot work, and it maps
 * the refusal the trigger raises when a reference appears between the question
 * and the delete.
 */
import type { TranslationKey } from '../i18n';
import type { CompanyScope } from './companyScope';
import { deleteChecked, type WriteClient, type WriteOutcome } from './writeOutcome';

export interface Blocker {
  table: string;
  rows: number;
}

export type DeleteCheck =
  | { kind: 'deletable' }
  | { kind: 'blocked'; blockers: Blocker[] }
  | { kind: 'refused'; reason: string };

/** An answer the code cannot read is null, never "deletable". */
export function parseDeleteCheck(data: unknown): DeleteCheck | null {
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return null;
  if (row.ok === false) return { kind: 'refused', reason: typeof row.reason === 'string' ? row.reason : 'unknown' };
  if (row.ok !== true || typeof row.deletable !== 'boolean' || !Array.isArray(row.blockers)) return null;
  const blockers = row.blockers.flatMap((entry): Blocker[] => {
    const item = entry as Record<string, unknown>;
    return typeof item?.table === 'string' && typeof item.rows === 'number'
      ? [{ table: item.table, rows: item.rows }] : [];
  });
  if (row.deletable) return { kind: 'deletable' };
  // A "not deletable" answer that names nothing still blocks.
  return { kind: 'blocked', blockers };
}

/** The part of a Supabase client the check needs. */
export interface DeleteCheckClient extends WriteClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

export async function checkDriverDelete(client: DeleteCheckClient, driverId: string): Promise<DeleteCheck | null> {
  const { data, error } = await client.rpc('driver_delete_check', { p_driver_id: driverId });
  if (error) throw error;
  return parseDeleteCheck(data);
}

/** The trigger's refusal: SQLSTATE 23503 with the stable HINT. */
export function isReferenceRefusal(error: unknown): boolean {
  const e = error as { hint?: unknown } | null;
  return e?.hint === 'driver_has_references';
}

export type DeleteResult = WriteOutcome | 'blocked';

export async function deleteDriver(client: WriteClient, driverId: string): Promise<DeleteResult> {
  try {
    return await deleteChecked(client, 'drivers', q => q.eq('id', driverId));
  } catch (error) {
    if (isReferenceRefusal(error)) return 'blocked';
    throw error;
  }
}

/**
 * The database asks `is_company_admin()`: an administrator of the company, or a
 * platform account inside a support session. The browser's twin of that, with
 * the same shape TripAnalysisPage uses for its administrator-only write.
 */
export function mayDeleteDriver(isAdmin: boolean, scope: Pick<CompanyScope, 'readOnly' | 'kind'>): boolean {
  return !scope.readOnly && (isAdmin || scope.kind === 'support');
}

export type BlockerArea =
  | 'trips' | 'salaries' | 'receipts' | 'stundennachweise' | 'planning' | 'reidey'
  | 'submissions' | 'notes' | 'vehicles' | 'abrechnung' | 'reconciliation' | 'uber' | 'other';

const AREA_ORDER: readonly BlockerArea[] = [
  'trips', 'salaries', 'receipts', 'abrechnung', 'stundennachweise', 'planning', 'reconciliation',
  'reidey', 'submissions', 'uber', 'notes', 'vehicles', 'other',
];

export const AREA_KEYS: Record<BlockerArea, TranslationKey> = {
  trips: 'fahrer.delete.area.trips',
  salaries: 'fahrer.delete.area.salaries',
  receipts: 'fahrer.delete.area.receipts',
  stundennachweise: 'fahrer.delete.area.stundennachweise',
  planning: 'fahrer.delete.area.planning',
  reidey: 'fahrer.delete.area.reidey',
  submissions: 'fahrer.delete.area.submissions',
  notes: 'fahrer.delete.area.notes',
  vehicles: 'fahrer.delete.area.vehicles',
  abrechnung: 'fahrer.delete.area.abrechnung',
  reconciliation: 'fahrer.delete.area.reconciliation',
  uber: 'fahrer.delete.area.uber',
  other: 'fahrer.delete.area.other',
};

/** Exact table names, then prefixes; anything else is "other records". */
const TABLE_AREAS: Record<string, BlockerArea> = {
  fahrtenbuch_trips: 'trips',
  fahrtenbuch_assignment_audit: 'trips',
  conflict_reviews: 'trips',
  salaries: 'salaries',
  salary_payments: 'salaries',
  salary_cash_receipts: 'salaries',
  cash_movements: 'salaries',
  receipts: 'receipts',
  income: 'receipts',
  saved_stundennachweise: 'stundennachweise',
  driver_month_budget: 'planning',
  driver_month_assignments: 'planning',
  partner_driver_links: 'reidey',
  partner_note_submissions: 'submissions',
  partner_receipt_submissions: 'submissions',
  driver_notes: 'notes',
  car_driver_assignments: 'vehicles',
};

const PREFIX_AREAS: readonly [string, BlockerArea][] = [
  ['abrechnung_', 'abrechnung'],
  ['historical_', 'reconciliation'],
  ['monthly_planning_', 'planning'],
  ['monthly_plan_', 'planning'],
  ['company_planning_', 'planning'],
  ['planning_', 'planning'],
  ['uber_', 'uber'],
];

export function blockerArea(table: string): BlockerArea {
  const exact = TABLE_AREAS[table];
  if (exact) return exact;
  return PREFIX_AREAS.find(([prefix]) => table.startsWith(prefix))?.[1] ?? 'other';
}

export interface AreaCount {
  area: BlockerArea;
  rows: number;
}

/** The blockers as a short list of human areas, rows summed, in a fixed order. */
export function blockerAreas(blockers: readonly Blocker[]): AreaCount[] {
  const sums = new Map<BlockerArea, number>();
  for (const blocker of blockers) {
    const area = blockerArea(blocker.table);
    sums.set(area, (sums.get(area) ?? 0) + blocker.rows);
  }
  return AREA_ORDER.filter(area => sums.has(area)).map(area => ({ area, rows: sums.get(area) ?? 0 }));
}
