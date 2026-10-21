/**
 * An UPDATE that a row-level-security policy refuses removes no row and reports
 * no error: PostgREST answers 200 with an empty body. A caller that selected
 * `id` back must therefore read the rows it got, or it reports a change that
 * never happened. This is the UPDATE half of the zero-row check that
 * `SalaryPeriodsModal` and `useFahrtenbuch` make for a DELETE.
 *
 * Unlike those two, it does not probe afterwards for "already gone": the id
 * comes from a list the user is looking at, and the message names both causes.
 */
export function assertRowsUpdated(rows: readonly unknown[] | null | undefined, refusalMessage: string): void {
  if (!rows || rows.length === 0) {
    throw new Error(refusalMessage);
  }
}
