/**
 * Stands in for src/lib/supabase.ts: an in-memory store behind the slice of the
 * supabase-js query builder the harnessed screens use.
 *
 * Reads, inserts, updates and deletes work, so a screen can be clicked through
 * (add a vehicle, edit a cost, delete one). Nothing leaves the tab. Each answer
 * arrives after a short delay, as a real one would, so loading states show.
 *
 * `window.__harness.pending` counts unanswered queries; the capture script
 * waits for it to reach zero before it takes a screenshot.
 *
 * `window.__harness.writes` records every insert, update and delete a screen
 * sends — table, payload and equality filters — so a flow can check what a
 * click wrote, not only what the screen shows afterwards (flows-batch1b.mjs).
 */
import { assignmentRows, carsRows, driversRows, fixedCostRows, type Row } from '../fixtures';
import { batch2Drivers, batch2PrimaryTable, batch2Rpc, batch2Tables, isBatch2Screen } from '../fixtures-batch2';
import { batch3Tables, recordBatch3Rpc, recordBatch3Write } from '../batch3/fixtures';
import { batch1bFailsEveryTable, batch1bPrimaryTable, batch1bTables } from '../fixtures-batch1b';
import { analysisFailure, analysisTables } from '../analysis/fixtures';
import { scenario } from '../scenario';

type QueryError = { message: string; code: string; details?: string; hint?: string };
type Result = { data: unknown; error: QueryError | null; count?: number | null };
type Write = { table: string; op: 'insert' | 'upsert' | 'update' | 'delete'; payload: unknown; filters: Array<[string, string, unknown]> };

const ANSWER_DELAY_MS = 120;

declare global {
  interface Window {
    __harness: { pending: number; answered: number; writes: Write[] };
  }
}
window.__harness = { pending: 0, answered: 0, writes: [] };

const PRIMARY_TABLE =
  batch2PrimaryTable(scenario) ?? batch1bPrimaryTable(scenario) ?? (scenario.screen === 'fixkosten' ? 'fixed_costs' : 'cars');

function seed(): Map<string, Row[]> {
  // Batch 1b's `empty` empties only its screen's own table (fixtures-batch1b.ts).
  const empty = scenario.data === 'empty' && batch1bPrimaryTable(scenario) === null;
  // Batch 2: the drivers carry a salary ratio, and an empty Gehälter screen is
  // one with no drivers, since a driver without income still gets a row.
  const drivers = !isBatch2Screen(scenario)
    ? driversRows()
    : scenario.screen === 'gehaelter' && empty ? [] : batch2Drivers(driversRows());
  return new Map<string, Row[]>([
    ['cars', empty ? [] : carsRows()],
    ['car_driver_assignments', empty ? [] : assignmentRows()],
    ['drivers', drivers],
    ['fixed_costs', empty ? [] : fixedCostRows()],
    ...batch2Tables(scenario),
    // Batch 1b's tables, on its own screens only; later entries win, so its
    // drivers, with the payroll columns the Fahrer form reads, replace the ones above.
    ...batch1bTables(scenario),
    // Batch 3's tables, on its own screens only (empty on any other). Later
    // entries win, so there its richer drivers replace the ones above.
    ...batch3Tables(),
    // The Fahrtenanalyse's tables, on its own screen only (analysis/fixtures.ts).
    ...analysisTables(),
  ]);
}

const store = seed();
let nextId = 1;

/** The failure a scenario asks for, on every statement against the screen's own table. */
function scenarioFailure(table: string, dateFrom: string | null): QueryError | null {
  const analysis = analysisFailure(table);
  if (analysis) return analysis;
  if (batch1bFailsEveryTable(scenario)) return { message: 'TypeError: Failed to fetch', code: '' };
  if (table !== PRIMARY_TABLE) return null;
  if (scenario.data === 'next-month-fails') {
    return dateFrom?.startsWith('2026-10') ? { message: 'TypeError: Failed to fetch', code: '' } : null;
  }
  if (scenario.data === 'error' || scenario.data === 'drivers-error') return { message: 'TypeError: Failed to fetch', code: '' };
  if (scenario.data === 'missing') {
    return { message: `relation "public.${table}" does not exist`, code: 'PGRST204' };
  }
  return null;
}

class FakeQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  /** The conflict target of an upsert, as PostgREST's `onConflict` names it. */
  private conflictColumns: string[] = ['id'];
  private payload: Row | Row[] | null = null;
  private readonly filters: Array<(row: Row) => boolean> = [];
  /** The equality filters as written, for the write log. */
  private readonly filterLog: Array<[string, string, unknown]> = [];
  // Every .order() applies, the first one first, as in PostgREST: the planning
  // screens order rides by date, then start time, then id.
  private readonly orderBy: Array<{ column: string; ascending: boolean }> = [];
  private returnRows = false;
  private singleRow = false;
  /** The lower bound of a `date` range, so a scenario can fail one month's reads. */
  private dateFrom: string | null = null;
  // .range() pages for real: the product's `while (true)` + `.range()` loops
  // stop on a short page, and a page that ignored its window would never be one.
  private window: [number, number] | null = null;
  private counted = false;
  private headOnly = false;

  constructor(private readonly table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (this.op !== 'select') this.returnRows = true;
    if (options?.count) this.counted = true;
    if (options?.head) this.headOnly = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.payload = rows;
    return this;
  }

  /**
   * PostgREST's upsert: a row whose conflict target already exists is updated
   * in place, any other is inserted. The Fahrtenanalyse writes its settings
   * (one row per company) and a driver's month budget this way.
   */
  upsert(rows: Row | Row[], options?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = rows;
    this.conflictColumns = (options?.onConflict ?? 'id').split(',').map(column => column.trim());
    return this;
  }

  update(values: Row): this {
    this.op = 'update';
    this.payload = values;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(row => row[column] === value);
    this.filterLog.push(['eq', column, value]);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push(row => row[column] !== value);
    this.filterLog.push(['neq', column, value]);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push(row => values.includes(row[column]));
    this.filterLog.push(['in', column, values]);
    return this;
  }

  // Comparisons as PostgREST reads them: a NULL never satisfies one. Dates are
  // stored as `YYYY-MM-DD` text, which compares correctly as a string.
  gt(column: string, value: unknown): this {
    this.filters.push(row => row[column] != null && compareForFilter(row[column], value) > 0);
    return this;
  }

  gte(column: string, value: unknown): this {
    // Batch 2: the lower bound of a `date` range, so a scenario can fail one month's reads.
    if (column === 'date') this.dateFrom = String(value);
    this.filters.push(row => row[column] != null && compareForFilter(row[column], value) >= 0);
    return this;
  }


  lt(column: string, value: unknown): this {
    this.filters.push(row => row[column] != null && compareForFilter(row[column], value) < 0);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push(row => row[column] != null && compareForFilter(row[column], value) <= 0);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push(row => (value === null ? row[column] == null : row[column] === value));
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === 'is') this.filters.push(row => (value === null ? row[column] != null : row[column] !== value));
    else if (operator === 'eq') this.filters.push(row => row[column] !== value);
    return this;
  }

  /** Accepts every row: the one caller (AssignmentPreview's note query) only narrows a small table. */
  or(): this {
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  range(from: number, to: number): this {
    this.window = [from, to];
    return this;
  }

  limit(): this {
    return this;
  }

  single(): this {
    this.singleRow = true;
    return this;
  }

  maybeSingle(): this {
    return this.single();
  }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    window.__harness.pending += 1;
    const neverAnswers = scenario.data === 'loading' && this.table === PRIMARY_TABLE && this.op === 'select';
    const answer = new Promise<Result>(resolve => {
      if (neverAnswers) return;
      setTimeout(() => {
        window.__harness.pending -= 1;
        window.__harness.answered += 1;
        resolve(this.run());
      }, ANSWER_DELAY_MS);
    });
    return answer.then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(filter => filter(row));
  }

  private run(): Result {
    if (this.op !== 'select') {
      recordBatch3Write(this.table, this.op);
      window.__harness.writes.push({
        table: this.table,
        op: this.op,
        payload: JSON.parse(JSON.stringify(this.payload ?? null)),
        filters: this.filterLog.map(([kind, column, value]) => [kind, column, value]),
      });
    }
    const failure = scenarioFailure(this.table, this.dateFrom);
    if (failure) return { data: null, error: failure };

    const rows = store.get(this.table) ?? [];
    switch (this.op) {
      case 'select': {
        const selected = rows.filter(row => this.matches(row));
        if (this.orderBy.length > 0) {
          selected.sort((a, b) => {
            for (const { column, ascending } of this.orderBy) {
              const order = compareValues(a[column], b[column]);
              if (order !== 0) return ascending ? order : -order;
            }
            return 0;
          });
        }
        const count = selected.length;
        const page = this.window ? selected.slice(this.window[0], this.window[1] + 1) : selected;
        return { ...this.shape(page), count: this.counted ? count : null };
      }
      case 'insert': {
        const now = new Date().toISOString();
        const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]).map(row => ({
          id: `new-${nextId++}`,
          created_at: now,
          updated_at: now,
          status: 'active',
          ...row,
        }));
        store.set(this.table, [...rows, ...inserted]);
        return this.shape(inserted);
      }
      case 'upsert': {
        const now = new Date().toISOString();
        const next = [...rows];
        const written: Row[] = [];
        for (const row of Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]) {
          const index = next.findIndex(existing => this.conflictColumns.every(column => existing[column] === row[column]));
          if (index >= 0) {
            next[index] = { ...next[index], ...row, updated_at: now };
            written.push(next[index]);
          } else {
            const inserted = { id: `new-${nextId++}`, created_at: now, updated_at: now, ...row };
            next.push(inserted);
            written.push(inserted);
          }
        }
        store.set(this.table, next);
        return this.shape(written);
      }
      case 'update': {
        const changed: Row[] = [];
        store.set(
          this.table,
          rows.map(row => {
            if (!this.matches(row)) return row;
            const next = { ...row, ...(this.payload as Row), updated_at: new Date().toISOString() };
            changed.push(next);
            return next;
          }),
        );
        return this.shape(changed);
      }
      case 'delete': {
        const removed = rows.filter(row => this.matches(row));
        store.set(this.table, rows.filter(row => !this.matches(row)));
        if (this.table === 'cars') {
          const ids = new Set(removed.map(row => row.id));
          store.set('car_driver_assignments', (store.get('car_driver_assignments') ?? []).filter(row => !ids.has(row.car_id)));
        }
        return this.shape(removed);
      }
    }
  }

  private shape(rows: Row[]): Result {
    if (this.op !== 'select' && !this.returnRows) return { data: null, error: null };
    if (this.headOnly) return { data: null, error: null };
    if (this.singleRow) return { data: rows[0] ?? null, error: null };
    return { data: rows.map(row => ({ ...row })), error: null };
  }
}

/** For a filter: numbers as numbers, anything else as plain text (a `YYYY-MM-DD` date compares correctly). */
function compareForFilter(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** For an order: numbers as numbers (month 12 after month 8), everything else as German text; NULL last. */
function compareValues(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'de');
}

const unavailable = async () => ({ data: null, error: { message: 'Not available in the screen harness', code: 'HARNESS' } });

/** An RPC a batch's fixtures answer, counted and delayed like a query; any other is unavailable. */
function rpc(name: string, args?: Record<string, unknown>): PromiseLike<Result> {
  // Batch 3 records every call on its screens, so its flows can prove they sent none.
  recordBatch3Rpc(name);
  const answer = batch2Rpc(scenario, store, name, args);
  if (!answer) return unavailable();
  window.__harness.pending += 1;
  const neverAnswers = scenario.data === 'loading' && name === PRIMARY_TABLE;
  return new Promise<Result>(resolve => {
    if (neverAnswers) return;
    setTimeout(() => {
      window.__harness.pending -= 1;
      window.__harness.answered += 1;
      resolve(answer);
    }, ANSWER_DELAY_MS);
  });
}

export const supabase = {
  from: (table: string) => new FakeQuery(table),
  rpc,
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    signOut: async () => ({ error: null }),
  },
  storage: {
    from: () => ({ createSignedUrl: unavailable, upload: unavailable, getPublicUrl: () => ({ data: { publicUrl: '' } }) }),
  },
  functions: { invoke: unavailable },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => undefined,
};

export const authRedirect = { type: '', error: '', errorFamily: '', errorCode: '' };
export const appOrigin = window.location.origin;
export const isSupabaseConfigured = true;
export const AUTH_STORAGE_KEY = 'receipt-app-auth';
