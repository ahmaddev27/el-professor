// Type-only: this module names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';

export interface PaginatedFetchError extends Error {
  messageKey?: EngineMessageKey;
  messageVars?: EngineMessageVars;
}

function fetchError(text: string, messageKey: EngineMessageKey, messageVars: EngineMessageVars): PaginatedFetchError {
  const error = new Error(text) as PaginatedFetchError;
  error.messageKey = messageKey;
  error.messageVars = messageVars;
  return error;
}

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
 * `label` names what is being loaded and is already translated by the caller.
 * The sentence around it is this module's, so the thrown Error carries the
 * dictionary key for it: a screen renders `engineText(t, e.message,
 * (e as PaginatedFetchError).messageKey, …)` and every other catch block still
 * shows `e.message`, unchanged.
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
  const labelIsDefault = options.label == null;

  const all: T[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await page(offset, offset + batchSize - 1);
    if (error) {
      throw fetchError(
        `Fehler beim Laden (${label}): ${error.message}`,
        'engine.fetch.loadFailed',
        // The default label is ours, so it travels as a key; a caller's label
        // arrives already translated.
        { label: labelIsDefault ? 'engine.fetch.defaultLabel' : label, cause: error.message },
      );
    }

    const rows = data ?? [];
    all.push(...rows);

    // A short page means the source is exhausted.
    if (rows.length < batchSize) return all;

    offset += batchSize;

    if (all.length > maxRows) {
      throw fetchError(
        `Abbruch beim Laden (${label}): mehr als ${maxRows} Zeilen. ` +
        'Das deutet auf einen Fehler in der Abfrage hin.',
        'engine.fetch.tooManyRows',
        { label: labelIsDefault ? 'engine.fetch.defaultLabel' : label, maxRows },
      );
    }
  }
}
