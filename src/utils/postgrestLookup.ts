/**
 * How long an `.in(…)` list may be, for every lookup that sends one.
 *
 * A PostgREST GET carries the list in its query string (`id=in.(…)`), and
 * **PostgREST echoes that query back in its `Content-Location` response
 * header**. Kong proxies with nginx's default 4 KB
 * buffer for response headers, so a query past roughly 3.5 KB makes nginx refuse
 * the answer: `upstream sent too big header`, and the browser gets a 502.
 *
 * Measured on staging on 08.10.2026 from a signed-in session: 52 keys answered
 * 200, 56 answered 502. Each key is a 64-character sha256 in hex. The chunk was
 * 100 — commented as "near 7 KB, well inside what Kong and PostgREST accept" —
 * so every import of more than about 50 rides failed at the preview with
 * "Die Vorschau konnte nicht erstellt werden", on staging and, with the same
 * gateway, on production; production had simply not imported since the lookup
 * shipped. 25 keys keep the query near 1.7 KB, half the measured limit.
 *
 * The chunks are asked a few at a time rather than all at once: a month of
 * 2,000 rides is 80 lookups, and the gateway should not see them in one burst.
 */

/** 64-character keys per lookup: half the measured limit of about 52. */
export const KEY_LOOKUP_CHUNK = 25;

/**
 * Uuids per lookup. Measured the same day through staging's gateway from inside
 * the host: 95 uuids answered 200 and 100 answered 502. Two lookups asked for
 * 200 at a time — the Bargeldbestand's receipt names and the backup's child
 * tables — so a month with more than about 95 Gehaltsquittungen, or a backup of
 * a company with that many parent rows, failed the same way. 40 keeps the query
 * near 1.5 KB.
 */
export const UUID_LOOKUP_CHUNK = 40;

/** Lookups in flight at once. */
export const KEY_LOOKUP_CONCURRENCY = 4;

/** The keys, de-duplicated, in chunks of at most `KEY_LOOKUP_CHUNK`. */
export function sourceRowKeyChunks(keys: readonly string[]): string[][] {
  const unique = [...new Set(keys)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += KEY_LOOKUP_CHUNK) chunks.push(unique.slice(i, i + KEY_LOOKUP_CHUNK));
  return chunks;
}

/** Runs `ask` over the chunks with at most `KEY_LOOKUP_CONCURRENCY` in flight, answers in chunk order. */
export async function inGroups<T, R>(items: readonly T[], ask: (item: T) => PromiseLike<R>): Promise<R[]> {
  const answers: R[] = [];
  for (let i = 0; i < items.length; i += KEY_LOOKUP_CONCURRENCY) {
    answers.push(...await Promise.all(items.slice(i, i + KEY_LOOKUP_CONCURRENCY).map(ask)));
  }
  return answers;
}
