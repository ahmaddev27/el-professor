/**
 * The periods a company is paid or granted, as the company's own billing
 * screen reads them.
 *
 * ── The rule this module preserves ──────────────────────────────────────────
 *
 * A claim must never be made from a read that did not succeed — and an
 * emptiness is a claim. `CompanyBillingPage` read its "Zahlungs- &
 * Aktivierungshistorie" from `activation_codes`, whose SELECT policy is
 * `USING ((SELECT public.platform_can('codes.manage')))` with **no tenant
 * term** (20260916110010, pinned per principal by tests/rls/matrix.sql: every
 * company principal reads nothing there, only a platform owner reads the
 * table). RLS *filters*; it does not error. So for a company user the read
 * succeeded, `error` was null, `data` was `[]`, and the screen printed "Noch
 * keine Aktivierungen vorhanden" over a customer that had redeemed a code — a
 * false statement about that customer's own payments. **No loadFailed flag can
 * ever fix that**: a flag cannot tell a filtered read from an empty one. Only a
 * source the caller may actually read can.
 *
 * `public.subscription_coverage` is that source. Its policy is
 * `company_id = (SELECT public.get_user_company_id())` (20260924110000, whose
 * self-check fails a release that loses the tenant term), and
 * `get_user_company_id()` answers the caller's membership — or, for a
 * company-less platform account, the company its context names in either mode
 * (20260917140000). So one read serves a company user and a support session
 * identically, and an empty answer now honestly means "no periods recorded".
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * `duration_type` and `code_last4` live on `activation_codes`, which no company
 * role reads, so the Laufzeit and Code columns are gone rather than guessed.
 * `price_cents` is filled for an invoice only (20260919150000 rule 4: a
 * redemption, a manual grant and the backfill all write NULL, because none of
 * them knows what the period cost), so no money column is derived here either.
 *
 * Pure: no Supabase and no clock of its own — `now` is always passed in, so
 * every boundary is testable.
 */

/** The `source` CHECK of `public.subscription_coverage` (20260919150000). */
export const COVERAGE_SOURCES = ['invoice', 'activation_code', 'manual', 'trial', 'migration'] as const;
export type CoverageSource = typeof COVERAGE_SOURCES[number];

/**
 * One row of `public.subscription_coverage`, reduced to what the screen draws.
 *
 * `source` is null for a value this build does not know: the column's CHECK
 * could gain a sixth source, and printing the stored word is better than
 * mapping it onto the wrong label.
 */
export interface CoverageRow {
  id: string;
  source: CoverageSource | null;
  /** The stored word, kept for a source this build does not know. */
  sourceRaw: string;
  period_start: string | null;
  period_end: string | null;
  grants_access: boolean;
  status: 'active' | 'void';
  created_at: string | null;
}

/**
 * Five states, not four.
 *
 * `status = 'void'` is a correction: the period was replaced or withdrawn, and
 * the row keeps the dates it was recorded with. `grants_access = false` is a
 * live period that granted nothing — what
 * `update_company_subscription_manual('suspended')` records. Folding the
 * second into "withdrawn" or "expired" would relabel a period that never
 * granted access as one that did, so each keeps its own word.
 */
export type CoverageState = 'withdrawn' | 'blocked' | 'future' | 'current' | 'past';

export interface CoverageEntry {
  row: CoverageRow;
  state: CoverageState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const isSource = (value: unknown): value is CoverageSource =>
  typeof value === 'string' && (COVERAGE_SOURCES as readonly string[]).includes(value);

/** Milliseconds, or null for anything that is not a date the browser can read. */
const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Reads the rows PostgREST returned. Anything that is not an object with an id
 * is dropped rather than drawn as a blank row; a `status` that is neither of the
 * two the CHECK allows is read as `void`, the safer word, because a state this
 * build cannot judge must not be printed as coverage that grants access.
 */
export function parseCoverageRows(data: unknown): CoverageRow[] {
  if (!Array.isArray(data)) return [];
  const rows: CoverageRow[] = [];
  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const id = nullableStr(raw.id);
    if (!id) continue;
    rows.push({
      id,
      source: isSource(raw.source) ? raw.source : null,
      sourceRaw: typeof raw.source === 'string' ? raw.source : '',
      period_start: nullableStr(raw.period_start),
      period_end: nullableStr(raw.period_end),
      // The column defaults to true and is NOT NULL, so anything that is not a
      // boolean is a shape this build does not recognise, not a denial.
      grants_access: typeof raw.grants_access === 'boolean' ? raw.grants_access : true,
      status: nullableStr(raw.status) === 'active' ? 'active' : 'void',
      created_at: nullableStr(raw.created_at),
    });
  }
  return rows;
}

/**
 * The order of the tests is the whole meaning, so it is spelled out once:
 *
 *   1. not live at all      → `withdrawn`
 *   2. live, grants nothing → `blocked`
 *   3. live, granting, starts later → `future`
 *   4. live, granting, already ended → `past`
 *   5. otherwise → `current` (an open end is current, by rule 1 of
 *      `recompute_company_subscription`)
 *
 * `period_end <= now` is past, which is the recompute's own boundary
 * (`period_end IS NULL OR period_end > now()`), so the word on the screen and
 * the rule that decides access cannot disagree at the second they change.
 */
export function coverageState(row: CoverageRow, now: Date): CoverageState {
  if (row.status !== 'active') return 'withdrawn';
  if (!row.grants_access) return 'blocked';
  const nowMs = now.getTime();
  const start = ms(row.period_start);
  if (start !== null && start > nowMs) return 'future';
  const end = ms(row.period_end);
  if (end !== null && end <= nowMs) return 'past';
  return 'current';
}

/** Newest period first; a tie is broken by when the row was recorded. */
export function coverageHistory(rows: readonly CoverageRow[], now: Date): CoverageEntry[] {
  return [...rows]
    .sort((a, b) => {
      const byPeriod = (ms(b.period_start) ?? 0) - (ms(a.period_start) ?? 0);
      if (byPeriod !== 0) return byPeriod;
      return (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0);
    })
    .map(row => ({ row, state: coverageState(row, now) }));
}
