/**
 * Fixed costs per month.
 *
 * A month's costs are its own rows if it has any, otherwise those of the newest
 * earlier month that has some, otherwise the baseline rows (`period_month`
 * NULL, i.e. everything entered before costs were kept per month).
 * Months are 'YYYY-MM' strings so they sort and compare as text.
 */
export interface MonthlyCostRow {
  id: string;
  description: string;
  amount: number;
  /** First day of the month, 'YYYY-MM-DD', or null for the baseline. */
  period_month: string | null;
  created_at?: string | null;
}

export type MonthSource = 'own' | 'inherited' | 'none';

export interface ResolvedMonth {
  month: string;
  source: MonthSource;
  /** For `inherited`: the month the rows came from, null for the baseline. */
  inheritedFrom: string | null;
  rows: MonthlyCostRow[];
  /** Euro, summed in integer cents so 0,1 + 0,2 stays 0,30. */
  total: number;
}

export const monthKey = (periodMonth: string): string => periodMonth.slice(0, 7);
export const monthStart = (month: string): string => `${month}-01`;

const toCents = (euro: number): number => Math.round(Number(euro) * 100);

export function sumEuro(rows: readonly { amount: number }[]): number {
  return rows.reduce((sum, row) => sum + toCents(row.amount), 0) / 100;
}

function rowsOfMonth(rows: readonly MonthlyCostRow[], month: string): MonthlyCostRow[] {
  return rows.filter(r => r.period_month !== null && monthKey(r.period_month) === month);
}

export function resolveMonth(rows: readonly MonthlyCostRow[], month: string): ResolvedMonth {
  const own = rowsOfMonth(rows, month);
  if (own.length > 0) return build(month, 'own', null, own);

  const earlier = rows
    .filter(r => r.period_month !== null && monthKey(r.period_month) < month)
    .map(r => monthKey(r.period_month as string));
  if (earlier.length > 0) {
    const from = earlier.reduce((a, b) => (a > b ? a : b));
    return build(month, 'inherited', from, rowsOfMonth(rows, from));
  }

  const baseline = rows.filter(r => r.period_month === null);
  return baseline.length > 0 ? build(month, 'inherited', null, baseline) : build(month, 'none', null, []);
}

function build(month: string, source: MonthSource, inheritedFrom: string | null, rows: MonthlyCostRow[]): ResolvedMonth {
  const sorted = [...rows].sort((a, b) => a.description.localeCompare(b.description, 'de'));
  return { month, source, inheritedFrom, rows: sorted, total: sumEuro(sorted) };
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Months to list, newest first: from the earliest anchor (an own month, or the
 * month a baseline row was created in) up to the current month. A month of its
 * own beyond the current one is listed too, so nothing entered disappears.
 */
export function listMonths(rows: readonly MonthlyCostRow[], now: Date = new Date()): string[] {
  const current = currentMonth(now);
  const anchors = rows
    .map(r => (r.period_month ? monthKey(r.period_month) : r.created_at ? monthKey(r.created_at.slice(0, 10)) : null))
    .filter((m): m is string => m !== null);
  const all = [...anchors, current];
  const first = all.reduce((a, b) => (a < b ? a : b));
  const last = all.reduce((a, b) => (a > b ? a : b));
  const months: string[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) months.push(m);
  return months.reverse();
}

export interface CostCopy {
  description: string;
  amount: number;
}

/** What an edit in an inherited month must write: the inherited rows copied, then changed. */
export function copyForMonth(
  resolved: ResolvedMonth,
  change: { replaceId?: string; replaceWith?: CostCopy; removeId?: string; add?: CostCopy },
): CostCopy[] {
  const out: CostCopy[] = [];
  for (const row of resolved.rows) {
    if (row.id === change.removeId) continue;
    const replaced = row.id === change.replaceId && change.replaceWith;
    out.push(replaced ? change.replaceWith! : { description: row.description, amount: Number(row.amount) });
  }
  if (change.add) out.push(change.add);
  return out;
}

export type EditScope = 'this_month' | 'this_and_later';

export interface EditPlan {
  /** Rows to insert, per month, in one batch. Written BEFORE the updates. */
  inserts: { month: string; copies: CostCopy[] }[];
  /** Rows of a month that already has its own rows, changed in place. */
  updates: { id: string; change: CostCopy }[];
  /** Later months of their own that receive the change (scope `this_and_later`). */
  laterMonthsChanged: string[];
}

/**
 * What editing one cost row of `month` must write.
 *
 * Because a month with no rows inherits from the newest earlier month that has
 * some, giving `month` rows of its own ALSO changes every later month that has
 * none, up to the next month of its own. So the two scopes differ in what they
 * do to those later months, not to this one:
 *
 * - `this_month`: the next month is pinned to the rows it showed before, when
 *   it would otherwise start inheriting the change. Later months follow it.
 * - `this_and_later`: nothing is pinned, so months without rows inherit the
 *   change; months of their own that hold a row with the same description get
 *   that row changed too. Months before `month` are never touched in either
 *   scope: a closed month is a record.
 */
export function planCostEdit(
  rows: readonly MonthlyCostRow[],
  month: string,
  rowId: string,
  change: CostCopy,
  scope: EditScope,
): EditPlan {
  const resolved = resolveMonth(rows, month);
  const old = resolved.rows.find(r => r.id === rowId);
  const plan: EditPlan = { inserts: [], updates: [], laterMonthsChanged: [] };
  if (!old) return plan;

  if (scope === 'this_month') {
    const next = nextMonth(month);
    const after = resolveMonth(rows, next);
    if (after.source !== 'own' && after.rows.length > 0) {
      plan.inserts.push({ month: next, copies: copyForMonth(after, {}) });
    }
  }

  if (resolved.source === 'own') plan.updates.push({ id: rowId, change });
  else plan.inserts.push({ month, copies: copyForMonth(resolved, { replaceId: rowId, replaceWith: change }) });

  if (scope === 'this_and_later') {
    const later = [...new Set(
      rows.filter(r => r.period_month !== null && monthKey(r.period_month) > month).map(r => monthKey(r.period_month as string)),
    )].sort();
    for (const m of later) {
      const match = rowsOfMonth(rows, m).find(r => r.description === old.description);
      if (!match) continue;
      plan.updates.push({ id: match.id, change });
      plan.laterMonthsChanged.push(m);
    }
  }
  return plan;
}
