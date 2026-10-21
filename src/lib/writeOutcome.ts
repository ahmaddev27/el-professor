/**
 * What a DELETE or UPDATE actually did, as opposed to whether it raised.
 *
 * THE DEFECT THIS EXISTS FOR. The tables a company screen edits are gated by a
 * role's page right (`current_role_permits('<page>', true)`, 20260917130000 and
 * 20260923130000). That gate sits in the policy's USING clause, so for a user it
 * refuses the row is simply not in the statement's scope: PostgREST answers 200
 * with no error and zero rows changed. A screen that only looks at `error` then
 * shows its green success toast over a row that is still there. INSERT is
 * different — a refused WITH CHECK raises 42501 — so only UPDATE and DELETE hide.
 *
 * The check is therefore made on every such write: ask for the touched rows
 * (`.select('id')`), and when fewer come back than were asked for, look at what
 * is still there before blaming the caller. "Someone else deleted it first" is
 * not a permission problem and must not be reported as one.
 *
 * The shape is SalaryPeriodsModal's (select('id'), then a probe on zero rows).
 */

export type WriteOutcome = 'done' | 'refused' | 'gone';

/** The part of a Supabase client these helpers need; tests pass a fake. */
export interface WriteClient {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Narrows a builder to the rows a write is about: `q => q.eq('id', id)`. */
export type RowFilter = (builder: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Decides from counts alone. `touched` is how many rows the write reported,
 * `expected` how many it was asked to change, and `remaining` is read only when
 * the two differ (a probe costs a round trip).
 */
export async function classifyWrite(
  touched: number,
  expected: number,
  remaining: () => Promise<number>,
): Promise<WriteOutcome> {
  if (touched >= expected) return 'done';
  // A row still present after a write that reported not touching it is a
  // refusal; rows that are gone were removed by someone else first.
  return (await remaining()) > 0 ? 'refused' : 'gone';
}

async function countRemaining(client: WriteClient, table: string, filter: RowFilter): Promise<number> {
  const { data, error } = await filter(client.from(table).select('id'));
  // A failed probe is not evidence of anything: report it instead of guessing.
  if (error) throw error;
  return (data as unknown[] | null)?.length ?? 0;
}

/** DELETE the rows `filter` selects; `expected` is how many that should be. */
export async function deleteChecked(
  client: WriteClient,
  table: string,
  filter: RowFilter,
  expected = 1,
): Promise<WriteOutcome> {
  const { data, error } = await filter(client.from(table).delete()).select('id');
  if (error) throw error;
  const touched = (data as unknown[] | null)?.length ?? 0;
  return classifyWrite(touched, expected, () => countRemaining(client, table, filter));
}

/** UPDATE the rows `filter` selects with `values`. */
export async function updateChecked(
  client: WriteClient,
  table: string,
  values: Record<string, unknown>,
  filter: RowFilter,
  expected = 1,
): Promise<WriteOutcome> {
  const { data, error } = await filter(client.from(table).update(values)).select('id');
  if (error) throw error;
  const touched = (data as unknown[] | null)?.length ?? 0;
  return classifyWrite(touched, expected, () => countRemaining(client, table, filter));
}
