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
 */
import { assignmentRows, carsRows, driversRows, fixedCostRows, type Row } from '../fixtures';
import { scenario } from '../scenario';

type QueryError = { message: string; code: string; details?: string; hint?: string };
type Result = { data: unknown; error: QueryError | null; count?: number | null };

const ANSWER_DELAY_MS = 120;

declare global {
  interface Window {
    __harness: { pending: number; answered: number };
  }
}
window.__harness = { pending: 0, answered: 0 };

const PRIMARY_TABLE = scenario.screen === 'fixkosten' ? 'fixed_costs' : 'cars';

function seed(): Map<string, Row[]> {
  const empty = scenario.data === 'empty';
  return new Map<string, Row[]>([
    ['cars', empty ? [] : carsRows()],
    ['car_driver_assignments', empty ? [] : assignmentRows()],
    ['drivers', driversRows()],
    ['fixed_costs', empty ? [] : fixedCostRows()],
  ]);
}

const store = seed();
let nextId = 1;

/** The failure a scenario asks for, on every statement against the screen's own table. */
function scenarioFailure(table: string): QueryError | null {
  if (table !== PRIMARY_TABLE) return null;
  if (scenario.data === 'error') return { message: 'TypeError: Failed to fetch', code: '' };
  if (scenario.data === 'missing') {
    return { message: `relation "public.${table}" does not exist`, code: 'PGRST204' };
  }
  return null;
}

class FakeQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private returnRows = false;
  private singleRow = false;

  constructor(private readonly table: string) {}

  select(): this {
    if (this.op !== 'select') this.returnRows = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.payload = rows;
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
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push(row => row[column] !== value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push(row => values.includes(row[column]));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending ?? true };
    return this;
  }

  range(): this {
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
    const failure = scenarioFailure(this.table);
    if (failure) return { data: null, error: failure };

    const rows = store.get(this.table) ?? [];
    switch (this.op) {
      case 'select': {
        const selected = rows.filter(row => this.matches(row));
        if (this.orderBy) {
          const { column, ascending } = this.orderBy;
          selected.sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? ''), 'de') * (ascending ? 1 : -1));
        }
        return this.shape(selected);
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
    if (this.singleRow) return { data: rows[0] ?? null, error: null };
    return { data: rows.map(row => ({ ...row })), error: null };
  }
}

const unavailable = async () => ({ data: null, error: { message: 'Not available in the screen harness', code: 'HARNESS' } });

export const supabase = {
  from: (table: string) => new FakeQuery(table),
  rpc: unavailable,
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
