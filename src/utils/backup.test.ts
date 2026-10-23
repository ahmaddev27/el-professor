/**
 * The backup lied three ways, and each assertion below carries the shape the
 * code had before the fix, so the test would fail against the old file rather
 * than merely describe the new one.
 *
 *   1. A table whose read failed was written as `[]` and the success toast still
 *      fired. Negative control: `fetchTableData` ended `if (error) { … return
 *      []; }`, so `tables[t]` was `[]` with no record of the failure anywhere.
 *   2. The list held 7 tables; a company owns 43. Negative control: the literal
 *      seven, checked here against the migrations that define the set — six of
 *      the 31 tenant tables, plus `user_profiles`, and no child table at all.
 *   3. Every table was read with one unbounded select, which PostgREST caps at
 *      1,000 rows with `error === null`. Negative control: one request per
 *      table, no `.range`, no `.order`.
 *
 * `createBackup` takes its client as an argument, so all of this runs against a
 * hand-written fake in the `node` environment this suite uses — no renderer, no
 * module mocking. `downloadBackup` keeps its DOM work and is not covered here;
 * `backupFilename`, the part of it that carries a decision, is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  BACKUP_CHILD_TABLES,
  BACKUP_PAGE_SIZE,
  BACKUP_PARENT_ID_CHUNK,
  BACKUP_TABLES,
  BACKUP_UNREADABLE_AS_TENANT_TABLE,
  BACKUP_VERSION,
  backupFilename,
  createBackup,
  type BackupClient,
  type BackupData,
  type BackupFilterBuilder,
} from './backup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── The fake client ──────────────────────────────────────────────────────────

interface RecordedQuery {
  table: string;
  select?: string;
  eq?: [string, string];
  in?: [string, string[]];
  order?: [string, { ascending: boolean }];
  range?: [number, number];
}

interface FakePage {
  data: unknown[] | null;
  error: { message?: string; code?: string } | null;
}

/** One responder per table; an unscripted table answers with no rows. */
type Script = Record<string, (query: RecordedQuery) => FakePage>;

const EMPTY: FakePage = { data: [], error: null };

function makeClient(script: Script = {}): { client: BackupClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client: BackupClient = {
    from(table: string) {
      const query: RecordedQuery = { table };
      queries.push(query);
      const builder: BackupFilterBuilder = {
        eq: (column, value) => {
          query.eq = [column, value];
          return builder;
        },
        in: (column, values) => {
          query.in = [column, [...values]];
          return builder;
        },
        order: (column, options) => {
          query.order = [column, options];
          return builder;
        },
        range: (from, to) => {
          query.range = [from, to];
          const respond: ((asked: RecordedQuery) => FakePage) | undefined = script[table];
          return Promise.resolve(respond === undefined ? EMPTY : respond(query));
        },
      };
      return {
        select: (columns: string) => {
          query.select = columns;
          return builder;
        },
      };
    },
  };
  return { client, queries };
}

/** `count` rows with distinct ids, numbered from `start`. */
function rows(count: number, start = 0): { id: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: `id-${start + index}` }));
}

/** A responder that hands back one scripted page per call, in order. */
function pages(...list: FakePage[]): () => FakePage {
  let call = 0;
  return () => {
    const page: FakePage | undefined = list[call];
    call += 1;
    return page ?? EMPTY;
  };
}

function reportFor(backup: BackupData, table: string) {
  return backup.tableReports.find(report => report.table === table);
}

function queriesFor(queries: RecordedQuery[], table: string): RecordedQuery[] {
  return queries.filter(query => query.table === table);
}

// `console.error` is the existing diagnostic on a failed table; silence it so a
// deliberate failure does not look like a broken test run.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. A failed read is not an empty table ───────────────────────────────────

describe('a table that could not be read is absent, not empty', () => {
  it('omits the key, marks the backup incomplete and records the reason', async () => {
    const { client } = makeClient({
      receipts: () => ({ data: null, error: { message: 'permission denied for table receipts', code: '42501' } }),
    });

    const backup = await createBackup('company-a', client);

    // The old code wrote `tables.receipts = []` here, which is why a company
    // with 4,000 Belege could download a file saying it had none.
    expect(Object.prototype.hasOwnProperty.call(backup.tables, 'receipts')).toBe(false);
    expect(backup.complete).toBe(false);
    expect(backup.incompleteTables).toContain('receipts');

    const report = reportFor(backup, 'receipts');
    expect(report?.status).toBe('failed');
    expect(report?.rows).toBe(0);
    expect(report?.error).toBe('permission denied for table receipts (42501)');

    // One table failing does not stop the rest.
    expect(backup.tables.drivers).toEqual([]);
    expect(reportFor(backup, 'drivers')?.status).toBe('complete');
  });

  it('is complete, with no incomplete tables, when every read succeeds', async () => {
    const { client } = makeClient();
    const backup = await createBackup('company-a', client);

    expect(backup.complete).toBe(true);
    expect(backup.incompleteTables).toEqual([]);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.companyId).toBe('company-a');
    // A report per table attempted: every tenant table plus every child.
    expect(backup.tableReports).toHaveLength(BACKUP_TABLES.length + BACKUP_CHILD_TABLES.length);
    expect(backup.tableReports.every(report => report.status === 'complete')).toBe(true);
  });

  it('discards the rows read before a mid-table failure and counts them', async () => {
    const { client } = makeClient({
      fahrtenbuch_trips: pages(
        { data: rows(BACKUP_PAGE_SIZE), error: null },
        { data: null, error: { message: 'canceling statement due to statement timeout' } },
      ),
    });

    const backup = await createBackup('company-a', client);

    // A short array under a present key is the same lie one level down.
    expect(Object.prototype.hasOwnProperty.call(backup.tables, 'fahrtenbuch_trips')).toBe(false);
    const report = reportFor(backup, 'fahrtenbuch_trips');
    expect(report?.status).toBe('failed');
    expect(report?.rows).toBe(0);
    expect(report?.discardedRows).toBe(BACKUP_PAGE_SIZE);
    expect(report?.error).toContain('statement timeout');
  });

  it('treats a thrown error the same as a returned one', async () => {
    const { client } = makeClient({
      income: () => {
        throw new Error('Failed to fetch');
      },
    });

    const backup = await createBackup('company-a', client);

    expect(Object.prototype.hasOwnProperty.call(backup.tables, 'income')).toBe(false);
    expect(reportFor(backup, 'income')?.error).toBe('Failed to fetch');
    expect(backup.complete).toBe(false);
  });

  it('refuses a backup with no company', async () => {
    const { client, queries } = makeClient();
    await expect(createBackup('', client)).rejects.toThrow('Company ID is required');
    expect(queries).toHaveLength(0);
  });
});

// ── 2. The list ──────────────────────────────────────────────────────────────

describe('the table list is the set the migrations define', () => {
  const unified = readFileSync(
    join(ROOT, 'supabase', 'migrations', '20260917130000_unified_tenant_policies.sql'),
    'utf8',
  );

  /** The text of one `VALUES (...) AS v(<signature>)` block. */
  function valuesBlock(signature: string): string {
    const end = unified.indexOf(`) AS v(${signature})`);
    if (end === -1) throw new Error(`VALUES block not found: AS v(${signature})`);
    const start = unified.lastIndexOf('SELECT * FROM (VALUES', end);
    if (start === -1) throw new Error(`no VALUES opener before AS v(${signature})`);
    return unified.slice(start, end);
  }

  it('carries every company-scoped business table of 20260917130000', () => {
    const block = valuesBlock('tbl, ops, page, admin_w, admin_d, ins_extra');
    const tenantTables = [...block.matchAll(/^\s*\('(\w+)',/gm)].map(match => match[1]);

    // The migration names 31; the old list carried six of them.
    expect(tenantTables.length).toBe(31);
    const missing = tenantTables.filter(table => !BACKUP_TABLES.includes(table));
    expect(missing).toEqual([]);
  });

  it('carries the child tables with the parent and key their RLS reads', () => {
    const block = valuesBlock('tbl, parent, fk, alias');
    const children = [...block.matchAll(/^\s*\('(\w+)',\s*'(\w+)',\s*'(\w+)',/gm)].map(match => ({
      table: match[1],
      parent: match[2],
      fk: match[3],
    }));

    expect(children).toHaveLength(5);
    for (const child of children) {
      expect(BACKUP_CHILD_TABLES).toEqual(
        expect.arrayContaining([{ table: child.table, parent: child.parent, fk: child.fk }]),
      );
    }

    // role_permissions is the sixth, policied separately (:699-705) but read the
    // same way: through its parent `roles`, because it has no company_id.
    expect(BACKUP_CHILD_TABLES).toEqual(
      expect.arrayContaining([{ table: 'role_permissions', parent: 'roles', fk: 'role_id' }]),
    );
  });

  it('carries the tables added after that migration and the account shell', () => {
    for (const table of [
      'trip_analysis_settings',
      'driver_month_budget',
      'vehicle_day_plans',
      'vehicle_day_shifts',
      'driver_month_assignments',
      'driver_month_assignment_shifts',
      'notification_deliveries',
      'company_settings',
      'roles',
      'user_profiles',
    ]) {
      expect(BACKUP_TABLES).toContain(table);
    }
  });

  it('never reads a table no company role can read as a tenant table', () => {
    // Adding one of these would make every backup report a failure: one has no
    // grant to `authenticated`, one is gated on a platform capability, and one
    // has no company_id column at all.
    for (const table of BACKUP_UNREADABLE_AS_TENANT_TABLE) {
      expect(BACKUP_TABLES).not.toContain(table);
    }
    expect(BACKUP_UNREADABLE_AS_TENANT_TABLE).toEqual(
      expect.arrayContaining(['document_counters', 'activation_codes', 'role_permissions']),
    );
  });

  it('names no table twice and gives every child a parent it reads first', () => {
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
    const childNames = BACKUP_CHILD_TABLES.map(child => child.table);
    expect(new Set(childNames).size).toBe(childNames.length);
    for (const child of BACKUP_CHILD_TABLES) {
      expect(BACKUP_TABLES).toContain(child.parent);
      expect(BACKUP_TABLES).not.toContain(child.table);
    }
  });

  it('queries every table in the list, once per page, scoped to the company', async () => {
    const { client, queries } = makeClient();
    await createBackup('company-a', client);

    // One request per tenant table; a child whose parent has no rows issues none.
    expect(queries).toHaveLength(BACKUP_TABLES.length);
    for (const table of BACKUP_TABLES) {
      const [query, ...extra] = queriesFor(queries, table);
      expect(query, table).toBeDefined();
      expect(extra, table).toHaveLength(0);
      expect(query.select).toBe('*');
      expect(query.eq).toEqual(['company_id', 'company-a']);
      expect(query.order).toEqual(['id', { ascending: true }]);
      expect(query.range).toEqual([0, BACKUP_PAGE_SIZE - 1]);
    }
  });
});

// ── 3. Paging ────────────────────────────────────────────────────────────────

describe('every table is read to its end', () => {
  it('reads 2,400 rows in three requests with contiguous ranges', async () => {
    const { client, queries } = makeClient({
      income: pages(
        { data: rows(BACKUP_PAGE_SIZE, 0), error: null },
        { data: rows(BACKUP_PAGE_SIZE, BACKUP_PAGE_SIZE), error: null },
        { data: rows(400, 2 * BACKUP_PAGE_SIZE), error: null },
      ),
    });

    const backup = await createBackup('company-a', client);

    // The old single select returned 1,000 rows and `error === null`.
    expect(backup.tables.income).toHaveLength(2400);
    expect(reportFor(backup, 'income')?.rows).toBe(2400);
    expect(queriesFor(queries, 'income').map(query => query.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('issues a second request for a full first page and stops at 1,000 rows', async () => {
    const { client, queries } = makeClient({
      receipts: pages({ data: rows(BACKUP_PAGE_SIZE), error: null }, { data: [], error: null }),
    });

    const backup = await createBackup('company-a', client);

    // The loop stops on a page shorter than BACKUP_PAGE_SIZE, so a full first
    // page has to cost a second request: a table of exactly 1,000 rows is
    // otherwise indistinguishable from a truncated one, which is the whole
    // defect. Pinned here: two requests, 1,000 rows, and still complete.
    expect(backup.tables.receipts).toHaveLength(BACKUP_PAGE_SIZE);
    expect(queriesFor(queries, 'receipts')).toHaveLength(2);
    expect(backup.complete).toBe(true);
  });
});

// ── Child tables ─────────────────────────────────────────────────────────────

describe('a child table is scoped by its parent, never by company_id', () => {
  it('chunks the parent ids and asks by the foreign key', async () => {
    const parentCount = BACKUP_PARENT_ID_CHUNK + 10;
    const { client, queries } = makeClient({
      documents: () => ({ data: rows(parentCount), error: null }),
    });

    const backup = await createBackup('company-a', client);

    const blockQueries = queriesFor(queries, 'document_blocks');
    expect(blockQueries).toHaveLength(2);
    expect(blockQueries[0].in?.[0]).toBe('document_id');
    expect(blockQueries[0].in?.[1]).toHaveLength(BACKUP_PARENT_ID_CHUNK);
    expect(blockQueries[1].in?.[1]).toHaveLength(10);
    // No company_id term: the column does not exist on these tables.
    expect(blockQueries[0].eq).toBeUndefined();
    expect(blockQueries[0].order).toEqual(['id', { ascending: true }]);
    expect(backup.tables.document_blocks).toEqual([]);
    expect(reportFor(backup, 'document_blocks')?.status).toBe('complete');
  });

  it('asks nothing for a child whose parent has no rows', async () => {
    const { client, queries } = makeClient();
    const backup = await createBackup('company-a', client);

    expect(queriesFor(queries, 'role_permissions')).toHaveLength(0);
    expect(backup.tables.role_permissions).toEqual([]);
  });

  it('skips a child whose parent could not be read, and says why', async () => {
    const { client, queries } = makeClient({
      documents: () => ({ data: null, error: { message: 'permission denied' } }),
    });

    const backup = await createBackup('company-a', client);

    for (const table of ['document_blocks', 'document_variables']) {
      const report = reportFor(backup, table);
      expect(report?.status).toBe('skipped');
      expect(report?.rows).toBe(0);
      expect(report?.error).toContain('parent documents');
      expect(Object.prototype.hasOwnProperty.call(backup.tables, table)).toBe(false);
      // Reading it unscoped is how another tenant's rows reach someone's file.
      expect(queriesFor(queries, table)).toHaveLength(0);
    }
    expect(backup.incompleteTables).toEqual(['documents', 'document_blocks', 'document_variables']);
  });

  it('fails the whole child table when one chunk fails', async () => {
    const { client } = makeClient({
      roles: () => ({ data: rows(BACKUP_PARENT_ID_CHUNK + 10), error: null }),
      role_permissions: pages(
        { data: rows(5), error: null },
        { data: null, error: { message: 'connection reset' } },
      ),
    });

    const backup = await createBackup('company-a', client);

    const report = reportFor(backup, 'role_permissions');
    expect(report?.status).toBe('failed');
    expect(report?.discardedRows).toBe(5);
    expect(Object.prototype.hasOwnProperty.call(backup.tables, 'role_permissions')).toBe(false);
  });
});

// ── The filename ─────────────────────────────────────────────────────────────

describe('the filename says whether the backup is complete', () => {
  const complete = { complete: true } as BackupData;
  const partial = { complete: false } as BackupData;

  it('marks an incomplete backup and leaves a complete one alone', () => {
    const when = new Date(2026, 8, 29, 14, 0, 0);
    expect(backupFilename(complete, when)).toBe('backup-2026-09-29.json');
    // The old code produced the first name whatever had failed.
    expect(backupFilename(partial, when)).toBe('backup-UNVOLLSTAENDIG-2026-09-29.json');
  });

  it('dates the file by the operator’s calendar day, not by UTC', () => {
    // 00:30 in Europe/Berlin (the zone vitest.config.ts pins) is the previous
    // day in UTC, so `toISOString().split('T')[0]` — what the old code used —
    // named 2026-09-28 for a backup taken on the 29th.
    const justAfterMidnight = new Date(2026, 8, 29, 0, 30, 0);
    expect(justAfterMidnight.toISOString().startsWith('2026-09-28')).toBe(true);
    expect(backupFilename(complete, justAfterMidnight)).toBe('backup-2026-09-29.json');
  });
});

// ── Source assertions for the rules a later edit could drop in silence ───────

describe('the rules the shape depends on', () => {
  const source = readFileSync(join(ROOT, 'src', 'utils', 'backup.ts'), 'utf8');
  const component = readFileSync(join(ROOT, 'src', 'components', 'BackupManagement.tsx'), 'utf8');

  it('never turns a failed read into rows', () => {
    // The exact line removed: `if (error) { console.error(...); return []; }`.
    expect(source).not.toMatch(/return \[\];/);
  });

  it('pages every read and orders it by a stable key', () => {
    const rangeCalls = source.match(/\.range\(offset, offset \+ BACKUP_PAGE_SIZE - 1\)/g) ?? [];
    expect(rangeCalls).toHaveLength(2); // the tenant read and the child read
    const orderCalls = source.match(/\.order\('id', \{ ascending: true \}\)/g) ?? [];
    expect(orderCalls).toHaveLength(2);
  });

  it('hands the result back so the screen can tell the operator', () => {
    expect(source).toMatch(/createAndDownloadBackup\(companyId: string\): Promise<BackupData>/);
    // The screen must branch on it, or the file's own honesty never reaches a person.
    expect(component).toMatch(/backup\.complete/);
    expect(component).toMatch(/showToast\(\s*'warning'/);
  });
});
