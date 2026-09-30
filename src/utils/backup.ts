/**
 * A company's own backup: every operational table it owns, as JSON.
 *
 * ── The rule this file preserves ────────────────────────────────────────────
 *
 * **A backup that could not read a table must be impossible to mistake for a
 * complete one.** The invariant a restore needs is stronger than "no error was
 * thrown": a key present under `tables` is that table *in full*, or it is not
 * there at all. An absent key means "not read"; it never means "empty".
 *
 * That is the repo's own rule for a screen — "a figure whose load failed is not
 * shown" — applied to a dump. Three defects broke it here, and all three are
 * closed below:
 *
 *   1. `fetchTableData` returned `[]` on any error and the caller stored it, so
 *      an unreadable table was written as an empty one and the success toast
 *      still fired. A company with 4,000 Belege could download a file saying it
 *      had none. Now the key is omitted, `complete` is false, the table's
 *      reason is recorded, and the file, the filename and the toast all say so.
 *   2. The list held 7 tables while the screen promised "every table in the
 *      system". It now holds the 31 company-scoped business tables of
 *      `20260917130000_unified_tenant_policies.sql:393-443`, the three added
 *      after it, the two account-shell tables a restore needs, `user_profiles`,
 *      and the 6 child tables scoped through a parent — 43 in all.
 *   3. Every table was read with one unbounded `select`, which PostgREST caps
 *      at 1,000 rows with `error === null`. Anything larger was silently
 *      truncated. Every read is now the repo's canonical `.range()` loop
 *      (CLAUDE.md: "that pattern is deliberate — don't 'simplify' it into a
 *      single select"), ordered by `id` so paging cannot repeat or skip a row.
 *
 * ── Recording the failure rather than refusing outright ─────────────────────
 *
 * The alternative was to throw and produce no file. A refusal leaves the
 * operator with nothing, and the likely cause is one table out of 43 — a role a
 * company lacks, a transient 502. A file that is loudly labelled partial is
 * strictly more useful than no file. What had to die is the *silent* partial,
 * so the signal is repeated at three levels that fail independently:
 * `complete: false` plus `incompleteTables` inside the file, `UNVOLLSTAENDIG`
 * in the filename (the one signal that survives a year in a folder, which is
 * when a backup is actually opened), and a warning toast instead of a success
 * one. Do not drop any of the three on the grounds that the other two cover it.
 */
// `supabase` is imported lazily, inside the two functions that need the live
// client. A static import pulls in `src/lib/supabase.ts`, which reads
// `window.location.origin` at module scope — so merely importing this file threw
// `ReferenceError: window is not defined` in the `node` environment the whole
// vitest suite runs in, and `backup.test.ts` could not load the module it tests.
// `createBackup` already takes its client as an argument for exactly that
// reason; this makes the default reachable from a test too.

/**
 * PostgREST caps a select at 1,000 rows. Reading page by page and stopping on a
 * short one is the only way to know a table was read to its end.
 */
export const BACKUP_PAGE_SIZE = 1000;

/**
 * How many parent ids go into one `.in(...)` for a child table. 200 uuids of 36
 * characters keeps the request line near 8 KB; the repo's precedent for a
 * bounded request line is `KEY_LOOKUP_CHUNK = 100` for 64-character keys in
 * `useFahrtenbuch.ts`.
 */
export const BACKUP_PARENT_ID_CHUNK = 200;

/** The shape changed: reports, per-table completeness, the company it is of. */
export const BACKUP_VERSION = '2.0';

/** ASCII, no umlaut, so every filesystem and archive tool keeps it intact. */
export const INCOMPLETE_FILENAME_MARKER = 'UNVOLLSTAENDIG';

/**
 * The company's own operational tables, each read with `.eq('company_id', …)`.
 *
 * Source of truth for the first 31: the `VALUES` block in
 * `supabase/migrations/20260917130000_unified_tenant_policies.sql:393-443`,
 * the migration that gave every tenant table one policy shape. A tenant table
 * added later belongs here too, and `tests/rls/matrix.sql` reports a new public
 * table as UNCOVERED, which is the prompt to come back to this list.
 *
 * Deliberately *not* here: the platform's commercial record of the customer
 * (`companies`, `company_subscriptions`, `subscription_invoices`,
 * `subscription_coverage`, `subscription_payment_audit`, `discount_codes`,
 * `referrals`, …). That is the platform's data about the customer, not the
 * customer's operational data, and restoring it out of a customer's file would
 * be meaningless. See BACKUP_UNREADABLE_AS_TENANT_TABLE for the three that are
 * left out because no company role can read them that way at all.
 */
export const BACKUP_TABLES: readonly string[] = [
  // Stammdaten and who may see them. `company_settings` and `roles` are
  // account-shell tables (get_user_company_id()), not business tables, but a
  // restore without the company's legal data or its custom roles is not one.
  //
  // `company_settings` carries the legal name, managing director, VAT and tax
  // number, commercial register and the **bank name, IBAN, BIC and account
  // holder**. Its own administrator already sees every one of those on
  // Einstellungen, so this exposes nothing new to that person — but it does put
  // an IBAN into a plaintext JSON file on a laptop. That is the owner's call,
  // the way a read model's column set is; dropping the line is the whole of
  // reversing it, at the cost of a restore that cannot reproduce an invoice.
  'drivers',
  'cars',
  'car_driver_assignments',
  'user_profiles',
  'roles',
  'company_settings',

  // Belege, Umsätze, Fixkosten.
  'receipts',
  'income',
  'fixed_costs',

  // Gehälter and the cash ledger. `cash_transactions` is legacy — one reference
  // in the whole SPA, this list — but old rows still exist and a backup carries
  // them; `cash_movements` and `salary_cash_receipts` are the live ledger
  // (src/utils/cashLedger.ts) and were both missing.
  'salaries',
  'salary_payments',
  'cash_movements',
  'salary_cash_receipts',
  'cash_transactions',

  // Fahrtenbuch: the import, its rides, and the record of every reassignment.
  'fahrtenbuch_imports',
  'fahrtenbuch_trips',
  'fahrtenbuch_assignment_audit',

  // Monatsplanung and the two historical pipelines.
  'company_planning_runs',
  'company_planning_run_blocks',
  'monthly_planning_manual_exceptions',
  'planning_finalizations',
  'planning_run_adjustments',
  'historical_reconciliations',
  'historical_block_adjustments',
  'historical_driver_hour_targets',
  'historical_payroll_targets',
  'historical_time_adjustments',
  'historical_wh_saved_plans',

  // Dokumente and the saved Stundennachweise.
  'documents',
  'document_templates',
  'saved_stundennachweise',

  // Werkstatt, Notizen, Benachrichtigungen, Fahrtenanalyse.
  'werkstatt_checks',
  'driver_notes',
  'notification_settings',
  'notification_deliveries',
  'trip_analysis_settings',
  'driver_month_budget',
];

/** A table with no `company_id`, reached through the parent that gives it one. */
export interface BackupChildTable {
  /** The child table. */
  table: string;
  /** Its parent, which must itself be in BACKUP_TABLES. */
  parent: string;
  /** The child's column holding the parent's `id`. */
  fk: string;
}

/**
 * The child tables. Their RLS is an EXISTS over the parent
 * (`20260917130000:517-521` for the first five, `:699-705` for
 * `role_permissions`), so they are read by parent id, never by `company_id` —
 * which they do not have.
 *
 * These are not optional: `documents` without `document_blocks` and
 * `document_variables` is a set of empty shells, `historical_reconciliations`
 * without its three children has no figures, and a restored `role` with no
 * `role_permissions` grants nothing.
 */
export const BACKUP_CHILD_TABLES: readonly BackupChildTable[] = [
  { table: 'document_blocks', parent: 'documents', fk: 'document_id' },
  { table: 'document_variables', parent: 'documents', fk: 'document_id' },
  { table: 'historical_reconciliation_drivers', parent: 'historical_reconciliations', fk: 'reconciliation_id' },
  { table: 'historical_reconciliation_results', parent: 'historical_reconciliations', fk: 'reconciliation_id' },
  { table: 'historical_reconciliation_wh_drivers', parent: 'historical_reconciliations', fk: 'reconciliation_id' },
  { table: 'role_permissions', parent: 'roles', fk: 'role_id' },
];

/**
 * Tables a company admin cannot read with `.eq('company_id', …)`, whatever the
 * plan or the role. Putting one of these in BACKUP_TABLES would make **every**
 * backup report a failure, which is why they are named here rather than left to
 * be rediscovered by whoever next "completes" the list.
 *
 *   document_counters  20260914140000:82 — REVOKE ALL … FROM anon, authenticated.
 *                      No client role holds SELECT at all.
 *   activation_codes   20260916110010:828-831 — SELECT is
 *                      platform_can('codes.manage'), which no company role holds.
 *   role_permissions   20260302065621:50-58 — the table has no `company_id`
 *                      column, so `.eq('company_id', …)` is a 42703
 *                      undefined_column. It is backed up through its parent
 *                      `roles` in BACKUP_CHILD_TABLES instead, which is the only
 *                      way its RLS lets it be read.
 */
export const BACKUP_UNREADABLE_AS_TENANT_TABLE: readonly string[] = [
  'document_counters',
  'activation_codes',
  'role_permissions',
];

export type BackupTableStatus = 'complete' | 'failed' | 'skipped';

/** What happened to one table. Present for every table that was attempted. */
export interface BackupTableReport {
  table: string;
  status: BackupTableStatus;
  /** Rows written under `tables[table]`. Always 0 unless `complete`. */
  rows: number;
  /**
   * Rows that were read before the failure and deliberately **not** written. A
   * short array under a present key is the same ambiguity one level down, so a
   * failed table contributes no rows at all — only this count.
   */
  discardedRows?: number;
  /** Absent only when `complete`. */
  error?: string;
}

export interface BackupData {
  /** When the backup ran, UTC, ISO 8601. */
  timestamp: string;
  version: string;
  companyId: string;
  /** False when any table was not read in full. */
  complete: boolean;
  /** The names of those tables, so a reader need not scan the reports. */
  incompleteTables: string[];
  tableReports: BackupTableReport[];
  /** A key here is that table in full. An absent key was not read. */
  tables: Record<string, unknown[]>;
}

// ── The query surface this module uses ───────────────────────────────────────
// A structural interface rather than supabase-js's generics: it is the whole of
// what a backup needs, and it is what makes the paging and the failure handling
// testable against a hand-written fake with no renderer and no mocking.

interface BackupPage {
  data: unknown[] | null;
  error: { message?: string; code?: string } | null;
}

export interface BackupFilterBuilder {
  eq(column: string, value: string): BackupFilterBuilder;
  in(column: string, values: readonly string[]): BackupFilterBuilder;
  order(column: string, options: { ascending: boolean }): BackupFilterBuilder;
  range(from: number, to: number): PromiseLike<BackupPage>;
}

export interface BackupClient {
  from(table: string): { select(columns: string): BackupFilterBuilder };
}

/** Either the whole table, or the failure that stopped it and what was dropped. */
type PagedRead =
  | { ok: true; rows: unknown[] }
  | { ok: false; error: string; discarded: number };

function describeError(error: { message?: string; code?: string } | null): string {
  if (!error) return 'unknown error';
  const code = error.code ? ` (${error.code})` : '';
  return `${error.message ?? 'unknown error'}${code}`;
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return typeof thrown === 'string' ? thrown : 'unknown error';
}

/**
 * The repo's canonical batch loop (`useFahrtenbuch.ts:123-134`): read a page,
 * stop on a short one. A page of exactly BACKUP_PAGE_SIZE issues one more
 * request, which is what tells a table of exactly 1,000 rows from a truncated
 * one.
 */
async function readAllPages(page: (offset: number) => PromiseLike<BackupPage>): Promise<PagedRead> {
  const rows: unknown[] = [];
  let offset = 0;
  for (;;) {
    let result: BackupPage;
    try {
      result = await page(offset);
    } catch (thrown) {
      return { ok: false, error: describeThrown(thrown), discarded: rows.length };
    }
    // Truthiness, not `!== null`: a client that answers `error: undefined` for a
    // successful read must not be read as a failure.
    if (result.error) {
      return { ok: false, error: describeError(result.error), discarded: rows.length };
    }
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < BACKUP_PAGE_SIZE) return { ok: true, rows };
    offset += BACKUP_PAGE_SIZE;
  }
}

function readTenantTable(client: BackupClient, table: string, companyId: string): Promise<PagedRead> {
  return readAllPages(offset =>
    client
      .from(table)
      .select('*')
      .eq('company_id', companyId)
      // Paging without a stable sort can repeat or skip rows. Every table in
      // both lists has `id uuid PRIMARY KEY`.
      .order('id', { ascending: true })
      .range(offset, offset + BACKUP_PAGE_SIZE - 1),
  );
}

async function readChildTable(
  client: BackupClient,
  child: BackupChildTable,
  parentIds: readonly string[],
): Promise<PagedRead> {
  const rows: unknown[] = [];
  for (let start = 0; start < parentIds.length; start += BACKUP_PARENT_ID_CHUNK) {
    const chunk = parentIds.slice(start, start + BACKUP_PARENT_ID_CHUNK);
    const read = await readAllPages(offset =>
      client
        .from(child.table)
        .select('*')
        .in(child.fk, chunk)
        .order('id', { ascending: true })
        .range(offset, offset + BACKUP_PAGE_SIZE - 1),
    );
    // One failed chunk fails the table: the rows already collected are a part
    // of it, and a part written under its key would read as the whole.
    if (!read.ok) return { ok: false, error: read.error, discarded: rows.length + read.discarded };
    rows.push(...read.rows);
  }
  return { ok: true, rows };
}

/** The `id`s of rows already read, for scoping a child table. */
function idsOf(rows: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

export async function createBackup(
  companyId: string,
  // `as unknown as` once, here: supabase-js's builders satisfy this surface but
  // its generics do not line up with a hand-written one. The cast is at the one
  // seam rather than spread through the reads.
  client?: BackupClient,
): Promise<BackupData> {
  if (!companyId) {
    throw new Error('Company ID is required for backup');
  }

  // The live client, resolved only when the caller supplied none. `as unknown as`
  // once, here: supabase-js's builders satisfy this surface but its generics do
  // not line up with a hand-written one. The cast is at the one seam rather than
  // spread through the reads.
  const db: BackupClient =
    client ?? ((await import('../lib/supabase')).supabase as unknown as BackupClient);

  const backup: BackupData = {
    timestamp: new Date().toISOString(),
    version: BACKUP_VERSION,
    companyId,
    complete: true,
    incompleteTables: [],
    tableReports: [],
    tables: {},
  };

  const record = (report: BackupTableReport) => {
    backup.tableReports.push(report);
    if (report.status !== 'complete') {
      backup.complete = false;
      backup.incompleteTables.push(report.table);
    }
  };

  for (const table of BACKUP_TABLES) {
    const read = await readTenantTable(db, table, companyId);
    if (!read.ok) {
      console.error(`Backup: ${table} could not be read:`, read.error);
      record({ table, status: 'failed', rows: 0, discardedRows: read.discarded, error: read.error });
      continue;
    }
    backup.tables[table] = read.rows;
    record({ table, status: 'complete', rows: read.rows.length });
  }

  // Children after their parents, so the parent's ids are already in hand and
  // no second query is needed to find them.
  for (const child of BACKUP_CHILD_TABLES) {
    // Explicitly `| undefined`: an absent key is the whole signal here, and
    // `Record<string, unknown[]>` would otherwise type the lookup as always
    // present and make the check read as dead code.
    const parentRows: unknown[] | undefined = backup.tables[child.parent];
    if (parentRows === undefined) {
      // The parent was not read in full, so the child cannot be scoped. Reading
      // it unscoped is how another tenant's rows end up in someone's file.
      record({
        table: child.table,
        status: 'skipped',
        rows: 0,
        error: `parent ${child.parent} could not be read`,
      });
      continue;
    }
    const read = await readChildTable(db, child, idsOf(parentRows));
    if (!read.ok) {
      console.error(`Backup: ${child.table} could not be read:`, read.error);
      record({ table: child.table, status: 'failed', rows: 0, discardedRows: read.discarded, error: read.error });
      continue;
    }
    backup.tables[child.table] = read.rows;
    record({ table: child.table, status: 'complete', rows: read.rows.length });
  }

  return backup;
}

/**
 * `YYYY-MM-DD` from the operator's own calendar day. `toISOString()` is UTC, so
 * in Europe/Berlin it names the previous day for the first one or two hours of
 * every night — a backup taken at 00:30 filed under yesterday. Storage order,
 * never US `MM/DD/YYYY`.
 */
function localDateStamp(when: Date): string {
  const month = `${when.getMonth() + 1}`.padStart(2, '0');
  const day = `${when.getDate()}`.padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * The filename carries the one signal that survives being filed away: a backup
 * that is not complete says so before it is opened.
 */
export function backupFilename(backup: BackupData, when: Date = new Date()): string {
  const date = localDateStamp(when);
  return backup.complete
    ? `backup-${date}.json`
    : `backup-${INCOMPLETE_FILENAME_MARKER}-${date}.json`;
}

export function downloadBackup(backupData: BackupData): void {
  const filename = backupFilename(backupData);
  const dataStr = JSON.stringify(backupData, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Returns the backup it downloaded, so the caller can tell the operator whether
 * it is complete. A `void` return was half of why the success toast fired for a
 * file with empty tables in it.
 */
export async function createAndDownloadBackup(companyId: string): Promise<BackupData> {
  try {
    const backupData = await createBackup(companyId);
    downloadBackup(backupData);
    return backupData;
  } catch (error) {
    console.error('Error creating backup:', error);
    throw error;
  }
}
