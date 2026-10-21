/**
 * A scripted stand-in for the Supabase client, for tests that need a write to
 * come back the way PostgREST answers one a policy hides: 200, no error, and an
 * empty array for `.select('id')` after a DELETE or UPDATE.
 *
 * Every call is recorded, and `answer` decides what each one returns. The builder
 * is a thenable that accepts any filter method, so a screen's own query chain
 * needs no per-screen fake.
 */

export type FakeOp = 'select' | 'insert' | 'update' | 'delete';
export type FakeAnswer = { data: unknown; error: unknown };

export interface FakeCall {
  table: string;
  op: FakeOp;
  /** Filter methods applied, in order, as `eq:company_id` style tags. */
  filters: string[];
}

const WRITES: readonly FakeOp[] = ['insert', 'update', 'delete'];

export function createFakeSupabase(answer: (call: FakeCall) => FakeAnswer) {
  const calls: FakeCall[] = [];

  const builder = (call: FakeCall, single: { on: boolean }): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (resolve: (value: FakeAnswer) => void) => {
            const result = answer(call);
            if (single.on && Array.isArray(result.data)) {
              resolve({ ...result, data: result.data[0] ?? null });
            } else {
              resolve(result);
            }
          };
        }
        return (...args: unknown[]) => {
          if ((WRITES as readonly string[]).includes(prop) && call.op === 'select') {
            call.op = prop as FakeOp;
          } else if (prop === 'single' || prop === 'maybeSingle') {
            single.on = true;
          } else if (prop !== 'select') {
            call.filters.push(`${prop}:${String(args[0])}`);
          }
          return builder(call, single);
        };
      },
    });

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const call: FakeCall = { table, op: 'select', filters: [] };
      calls.push(call);
      return builder(call, { on: false });
    },
  };

  return { client, calls };
}

/** Calls of one table and operation, in the order they were made. */
export function callsOf(calls: FakeCall[], table: string, op: FakeOp): FakeCall[] {
  return calls.filter(c => c.table === table && c.op === op);
}
