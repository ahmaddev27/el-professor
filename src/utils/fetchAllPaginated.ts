/**
 * Page through a PostgREST query until it is exhausted.
 *
 * Supabase caps a response at 1000 rows and reports no error when it truncates.
 * A `.select()` without pagination therefore looks successful while silently
 * returning a partial answer — which is how a driver's revenue could read as
 * zero and be written into the salaries table, and how a month with more than
 * 1000 rides could export a truncated statutory Fahrtenbuch.
 *
 * `page` is called with an inclusive `[from, to]` row range and must apply the
 * same filters and ordering every time. Order by something unique — a
 * (trip_date, start_time) pair ties whenever two vehicles leave at the same
 * minute, and PostgreSQL is free to break that tie differently per request,
 * duplicating or dropping rows across page boundaries.
 *
 * @throws if any page errors, or if `maxRows` is exceeded — a runaway is a bug
 *         worth surfacing rather than an out-of-memory crash.
 */
export async function fetchAllPaginated<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  options: { batchSize?: number; maxRows?: number; label?: string } = {},
): Promise<T[]> {
  const batchSize = options.batchSize ?? 1000;
  const maxRows = options.maxRows ?? 200_000;
  const label = options.label ?? 'Datensätze';

  const all: T[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await page(offset, offset + batchSize - 1);
    if (error) {
      throw new Error(`Fehler beim Laden (${label}): ${error.message}`);
    }

    const rows = data ?? [];
    all.push(...rows);

    // A short page means the source is exhausted.
    if (rows.length < batchSize) return all;

    offset += batchSize;

    if (all.length > maxRows) {
      throw new Error(
        `Abbruch beim Laden (${label}): mehr als ${maxRows} Zeilen. ` +
        'Das deutet auf einen Fehler in der Abfrage hin.',
      );
    }
  }
}
