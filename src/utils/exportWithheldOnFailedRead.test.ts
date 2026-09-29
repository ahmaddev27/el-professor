/**
 * Three Excel exports that wrote a file claiming nought after a failed read.
 *
 * THE RULE THESE PIN: an empty list, and a total row saying "0 Einträge" or
 * "0,00 €", are claims about the company's data. After a read that failed the
 * screen has made no such observation, so nothing may be written into a file
 * that leaves the browser and reaches an accountant. `exportTableToExcel` has
 * no failure channel — it builds a workbook for whatever `rows` it is handed,
 * and `buildTableWorkbook` prints `labels.emptyState` for an empty one — so the
 * withholding can only live at the call site, on the button. The last describe
 * below pins that premise, so this test fails loudly if the exporter ever grows
 * a failure channel and these guards should move into it.
 *
 * These are source assertions, not renders: there is no renderer in this suite,
 * the three screens are 472, 500 and 1,137 lines, and each fix is one attribute
 * plus (for two of them) the one failure state CLAUDE.md's batch-2 rule allows —
 * a shape a later edit can drop with no symptom at all. Same technique as
 * `moneyScreenFailures.test.ts`, `subscriptionDirectWrites.test.ts` and
 * `planFeatures.test.ts`. Each screen carries its negative control: the exact
 * Button tag that shipped before the fix, so a regression fails here rather
 * than being reasoned about.
 *
 * What they cannot check: that the disabled button then *looks* disabled, or
 * that the screen says why. That is the design harness's job (`npm run
 * harness`), and all three screens already tell the user — Fixkosten an Alert,
 * Fahrzeuge a toast, Benutzer an error dialog. Only the file was silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

/**
 * The text between two anchors, searching for `close` only after `open`. Brace
 * counting would have to know about braces inside strings, comments and JSX; an
 * anchor pair chosen per call does not.
 */
function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  // A plain throw, not expect(): this runs while the file is collected, not
  // inside a test. An anchor that moved is a failure worth reading as one.
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`closing anchor not found after ${open}: ${close}`);
  return source.slice(start, end + close.length);
}

/**
 * The opening tag of the button that triggers the export, and only that one: an
 * attribute added to some *other* button on the screen must not satisfy these
 * assertions. Walks back from `onClick={handleExport}` to the `<Button` that
 * owns it and forward to the end of that tag.
 */
function exportButtonTag(source: string): string {
  const handler = source.indexOf('onClick={handleExport}');
  if (handler === -1) throw new Error('no onClick={handleExport} in this screen');
  const open = source.lastIndexOf('<Button', handler);
  if (open === -1) throw new Error('onClick={handleExport} is not on a <Button');
  const close = source.indexOf('>', handler);
  if (close === -1) throw new Error('unterminated <Button tag');
  return source.slice(open, close + 1);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** The tag all three screens shipped: the export with nothing withholding it. */
const UNGUARDED_BUTTON = '<Button variant="secondary" onClick={handleExport}>';

describe('Fixkosten withholds its export with the failure state it already had', () => {
  const source = read('components/FixedCostsManagement.tsx');

  /**
   * This screen needed no new state and no added line: `loadFailed` is derived
   * from the `error` its catch already sets, and already withholds the KpiCard
   * and blanks the DataTable. Only the export ignored it. Pinning the
   * derivation keeps a later edit from replacing it with a second state, which
   * is the shape CLAUDE.md's rule forbids.
   */
  it('derives loadFailed once and adds no second failure state', () => {
    expect(occurrences(source, 'const loadFailed = Boolean(error) && fixedCosts.length === 0;')).toBe(1);
    expect(source).not.toContain('setLoadFailed');
  });

  it('already uses it for the figure and the table', () => {
    expect(source).toContain('{!loadFailed && (');
    expect(source).toContain('error={loadFailed}');
  });

  it('withholds the export while it is set', () => {
    expect(occurrences(source, 'onClick={handleExport}')).toBe(1);
    expect(exportButtonTag(source)).toContain('disabled={loadFailed}');
  });

  /**
   * The negative control. Before the fix this exact tag was in the file and the
   * workbook it wrote was `Keine Daten vorhanden` with a total of 0,00 € — a
   * fixed-cost sheet an accountant would read as "this company has none".
   */
  it('no longer offers the export unconditionally', () => {
    expect(source).not.toContain(UNGUARDED_BUTTON);
  });
});

describe('Fahrzeuge withholds its export after a failed read', () => {
  const source = read('components/CarsManagement.tsx');
  const loadBody = between(source, 'const loadCars = async () => {', '} finally {');
  const loadCatch = between(source, "console.error('Error loading cars:", '} finally {');

  /** One failure state for the screen, not one per consumer. */
  it('declares exactly one failure state', () => {
    expect(occurrences(source, 'const [loadFailed, setLoadFailed] = useState(false);')).toBe(1);
  });

  /**
   * Cleared where the load *starts*, before the first read — not at the end, and
   * not only on success. A retry that succeeds must offer the export again, and
   * a second failure must not be hidden by a stale `false`.
   */
  it('clears it where the load starts', () => {
    const cleared = loadBody.indexOf('setLoadFailed(false);');
    // -1 would be "less than" any index, so the presence is asserted here and
    // not only by the line that reads like it covers it.
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(loadBody.indexOf("from('cars')"));
  });

  /** Set in the catch that already existed, not on a new path. */
  it('sets it in the existing catch, beside the toast that was the only symptom', () => {
    expect(loadCatch).toContain("showToast('error', t('fleet.carsLoadFailed', { error: error.message }));");
    expect(loadCatch).toContain('setLoadFailed(true);');
  });

  it('withholds the export while it is set', () => {
    expect(occurrences(source, 'onClick={handleExport}')).toBe(1);
    expect(exportButtonTag(source)).toContain('disabled={loadFailed}');
  });

  /**
   * The negative control. Before the fix the catch logged and toasted and
   * nothing else, so `cars` stayed `[]`, the screen drew "Keine Fahrzeuge" and
   * the export wrote a fleet of nought with the totals row
   * `t('fleet.carsTotal', { count: 0 })`.
   */
  it('no longer offers the export unconditionally', () => {
    expect(source).not.toContain(UNGUARDED_BUTTON);
  });
});

describe('Benutzer withholds its export after a failed read', () => {
  const source = read('components/UserManagement.tsx');
  const loadBody = between(source, 'const loadUsers = async () => {', '} finally {');
  const loadCatch = between(source, "console.error('Error loading users:", '} finally {');

  it('declares exactly one failure state', () => {
    expect(occurrences(source, 'const [loadFailed, setLoadFailed] = useState(false);')).toBe(1);
  });

  it('clears it where the load starts', () => {
    const cleared = loadBody.indexOf('setLoadFailed(false);');
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(loadBody.indexOf('supabase.auth.getSession()'));
  });

  /**
   * The existing catch is the error dialog. It stays: the user is told either
   * way, and this adds only the state the export reads.
   */
  it('sets it in the existing catch, beside the error dialog that was the only symptom', () => {
    expect(loadCatch).toContain("message: t('users.error.loadUsers'),");
    expect(loadCatch).toContain('setLoadFailed(true);');
  });

  it('withholds the export while it is set', () => {
    expect(occurrences(source, 'onClick={handleExport}')).toBe(1);
    expect(exportButtonTag(source)).toContain('disabled={loadFailed}');
  });

  /**
   * The negative control. Before the fix a failed `manage-users/list` left
   * `users` at `[]` and the file's totals row said the company had 0 users —
   * on the one screen whose subject is who may reach the company's data.
   */
  it('no longer offers the export unconditionally', () => {
    expect(source).not.toContain(UNGUARDED_BUTTON);
  });
});

describe('the exporter still has no failure channel, so the guard belongs at the call site', () => {
  const source = read('utils/excelExport.ts');

  /**
   * Three statements: build, name, write. No early return and no argument that
   * could say "this read failed". If that ever changes, the three guards above
   * should move into the exporter and this test is where you will be told.
   */
  it('writes a workbook for whatever rows it is handed', () => {
    const body = between(source, 'export function exportTableToExcel(opts: ExportOptions): void {', '\n}');
    expect(body).toContain('buildTableWorkbook(opts)');
    expect(body).toContain('XLSX.writeFile(wb, safeFilename)');
    expect(body).not.toMatch(/\breturn\b/);
  });

  it('offers the caller no failure option', () => {
    const options = between(source, 'export interface ExportOptions {', '\n}');
    const keys = [...options.matchAll(/^ {2}(\w+)\??:/gm)].map(match => match[1]);
    expect(keys).toContain('rows');
    expect(keys.filter(key => /fail|error/i.test(key))).toEqual([]);
  });

  /** And an empty `rows` is printed as a claim, which is the whole problem. */
  it('prints the empty-state line for an empty row set', () => {
    expect(source).toContain('labels.emptyState');
    expect(source).toContain("emptyState:    'Keine Daten vorhanden',");
  });
});
