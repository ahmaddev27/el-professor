/**
 * Stands in for src/lib/supabase.ts in the batch-4 harness: an in-memory store
 * behind the slice of supabase-js these screens use — the query builder for
 * roles, companies and activation codes, three RPCs, the auth calls the
 * password and invitation screens make, and the logo bucket.
 *
 * Nothing leaves the tab. Answers arrive after a short delay, as real ones
 * would, and `window.__harness.pending` counts the unanswered ones so the
 * capture script can wait for a screen to settle. The edge functions are
 * answered by fakeFetch.ts, which shares the counter.
 */
import {
  activationCodeRows,
  companyRows,
  rolePermissionRows,
  roleRows,
  userProfileRows,
  type Row,
} from '../fixtures';
import { HARNESS_EMAIL, HARNESS_USER_ID, scenario } from '../scenario';

type QueryError = { message: string; code: string; details?: string; hint?: string };
type Result = { data: unknown; error: QueryError | null; count?: number | null };

export const ANSWER_DELAY_MS = 120;

declare global {
  interface Window {
    __harness: { pending: number; answered: number; writes: Array<{ target: string; op: string; payload: unknown }> };
  }
}
window.__harness = window.__harness ?? { pending: 0, answered: 0, writes: [] };

/** Every write a screen makes, for flows-batch4.mjs to read back. */
export function recordWrite(target: string, op: string, payload: unknown): void {
  window.__harness.writes.push({ target, op, payload });
}

/** Resolves after the harness delay, counted while it is outstanding. */
export function answerLater<T>(produce: () => T, never = false): Promise<T> {
  window.__harness.pending += 1;
  return new Promise<T>(resolve => {
    if (never) return;
    setTimeout(() => {
      window.__harness.pending -= 1;
      window.__harness.answered += 1;
      resolve(produce());
    }, ANSWER_DELAY_MS);
  });
}

/** The table a screen reads first — the one a failure scenario breaks. */
const PRIMARY_TABLE: string | null =
  scenario.screen === 'roles' ? 'roles' : scenario.screen === 'billing' ? 'companies' : null;

function seed(): Map<string, Row[]> {
  return new Map<string, Row[]>([
    ['roles', scenario.data === 'empty' ? [] : roleRows()],
    ['role_permissions', scenario.data === 'empty' ? [] : rolePermissionRows()],
    ['companies', companyRows()],
    ['activation_codes', activationCodeRows()],
    ['user_profiles', userProfileRows()],
    ['company_settings', []],
  ]);
}

const store = seed();
let nextId = 1;

function scenarioFailure(table: string, op: string): QueryError | null {
  if (table !== PRIMARY_TABLE || op !== 'select') return null;
  if (scenario.data === 'error') return { message: 'TypeError: Failed to fetch', code: '' };
  return null;
}

class FakeQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
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

  upsert(rows: Row | Row[]): this {
    this.op = 'upsert';
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

  is(column: string, value: unknown): this {
    this.filters.push(row => (row[column] ?? null) === value);
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
    const never = scenario.data === 'loading' && this.table === PRIMARY_TABLE && this.op === 'select';
    return answerLater(() => this.run(), never).then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(filter => filter(row));
  }

  private run(): Result {
    const failure = scenarioFailure(this.table, this.op);
    if (failure) return { data: null, error: failure };

    const rows = store.get(this.table) ?? [];
    if (this.op !== 'select') recordWrite(this.table, this.op, this.payload);

    switch (this.op) {
      case 'select': {
        const selected = rows.filter(row => this.matches(row));
        if (this.orderBy) {
          const { column, ascending } = this.orderBy;
          selected.sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? ''), 'de') * (ascending ? 1 : -1));
        }
        return this.shape(selected);
      }
      case 'insert':
      case 'upsert': {
        const now = new Date().toISOString();
        const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]).map(row => ({
          id: `new-${nextId++}`,
          created_at: now,
          updated_at: now,
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
        if (this.table === 'roles') {
          const ids = new Set(removed.map(row => row.id));
          store.set('role_permissions', (store.get('role_permissions') ?? []).filter(row => !ids.has(row.role_id)));
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

// ─── RPCs ────────────────────────────────────────────────────────────────────

/** The activation code the harness accepts; 000000 answers "expired", anything else is unknown. */
export const HARNESS_ACTIVATION_CODE = '731904';

function rpcAnswer(name: string, args: Record<string, unknown> = {}): Result {
  recordWrite(`rpc:${name}`, 'call', args);
  switch (name) {
    case 'preview_activation_code':
      return args.input_code === HARNESS_ACTIVATION_CODE
        ? { data: { success: true, status: 'active', expires_at: '2026-09-14T10:02:00+02:00', duration_type: '3_monate', seconds_remaining: 94 }, error: null }
        : { data: { success: false, error: 'not_found' }, error: null };
    case 'redeem_activation_code':
      return args.input_code === HARNESS_ACTIVATION_CODE
        ? { data: { success: true, subscription_expires_at: '2026-12-14T10:00:00+01:00' }, error: null }
        : { data: { success: false, error: 'Ungültiger oder abgelaufener Aktivierungscode.' }, error: null };
    case 'platform_whoami':
      return { data: { role: null, capabilities: [], company_context: null }, error: null };
    default:
      return { data: null, error: { message: `Not available in the screen harness: ${name}`, code: 'HARNESS' } };
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

const harnessSession = {
  access_token: 'harness-access-token',
  refresh_token: 'harness-refresh-token',
  token_type: 'bearer',
  user: { id: HARNESS_USER_ID, email: HARNESS_EMAIL },
};

const auth = {
  getSession: () =>
    answerLater(() => ({ data: { session: scenario.session === 'none' ? null : harnessSession }, error: null })),
  getUser: () => answerLater(() => ({ data: { user: harnessSession.user }, error: null })),
  updateUser: (values: Record<string, unknown>) =>
    answerLater(() => {
      recordWrite('auth', 'updateUser', { ...values, password: values.password ? '•••' : undefined });
      return { data: { user: harnessSession.user }, error: null };
    }),
  setSession: () => answerLater(() => ({ data: { session: harnessSession }, error: null })),
  signOut: () =>
    answerLater(() => {
      recordWrite('auth', 'signOut', null);
      return { error: null };
    }),
  signInWithOAuth: () => answerLater(() => ({ data: { url: null }, error: null })),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
};

// ─── Storage ─────────────────────────────────────────────────────────────────

const storage = {
  from: (bucket: string) => ({
    upload: (path: string) =>
      answerLater(() => {
        recordWrite(`storage:${bucket}`, 'upload', path);
        return { data: { path }, error: null };
      }),
    remove: (paths: string[]) =>
      answerLater(() => {
        recordWrite(`storage:${bucket}`, 'remove', paths);
        return { data: paths, error: null };
      }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `/brand/mark-on-light.png#${path}` } }),
    createSignedUrl: () => answerLater(() => ({ data: null, error: { message: 'Not available in the screen harness', code: 'HARNESS' } })),
  }),
};

export const supabase = {
  from: (table: string) => new FakeQuery(table),
  rpc: (name: string, args?: Record<string, unknown>) => answerLater(() => rpcAnswer(name, args)),
  auth,
  storage,
  functions: { invoke: () => answerLater(() => ({ data: null, error: { message: 'Not available in the screen harness', code: 'HARNESS' } })) },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => undefined,
};

/** What lib/supabase captured from the address; the callback screen shows an expired mail link. */
export const authRedirect =
  scenario.screen === 'callback'
    ? { type: 'recovery', error: 'Email link is invalid or has expired', errorFamily: 'access_denied', errorCode: 'otp_expired' }
    : { type: '', error: '', errorFamily: '', errorCode: '' };
export const appOrigin = window.location.origin;
export const isSupabaseConfigured = true;
export const AUTH_STORAGE_KEY = 'receipt-app-auth';
