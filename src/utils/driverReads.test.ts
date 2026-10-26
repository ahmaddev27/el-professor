import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every read of `public.drivers` in the browser, classified — and the guard that
 * makes the nineteenth one declare itself.
 *
 * A driver is deactivated, never deleted (see `driverStatus.ts` for the eight
 * cascades that settle it). The owner's instruction is that a deactivated driver
 * appears in **no other list** — not the plan generator, not the Fahrtenbuch, not
 * anywhere a driver is offered for future work. The counter-rule is just as
 * load-bearing: a **record** of what happened must still show them, or a past
 * month's statutory document changes and stops reconciling with the
 * Steuerberater's figures.
 *
 * So the filter cannot simply be pushed into one shared read: `useDatabase`'s
 * `getDrivers()` feeds the Fahrer screen, which has to show both. The rule lives
 * in `driverStatus.ts` and is applied per call site — which is exactly the shape
 * that lets someone forget one. This file is the countermeasure: every
 * `from('drivers')` under `src/` must be declared below with a classification,
 * and every `chooser` must carry the filter. A new read fails this test until it
 * is classified, and a declaration for a read that no longer exists fails too,
 * so a stale line cannot sit here excusing something else.
 *
 * It is a lexical check over the source. It says nothing about whether a
 * classification is *right* — that is the reason text's job, and a reviewer's.
 */

type Kind =
  /** Offers a driver for future work. Must exclude the deactivated. */
  | 'chooser'
  /** Shows or counts what happened, or resolves an id already in hand. Must not. */
  | 'record'
  /** Not a read. */
  | 'write';

interface DeclaredRead {
  /** A distinctive fragment of the statement, usually its select list. */
  readonly statement: string;
  readonly kind: Kind;
  /**
   * Required on a `chooser`, and checked as the ONE mechanism that file uses.
   *
   * This started as "a query filter OR a `selectableDrivers` call", and the
   * negative control showed that to be vacuous: the plan pool has both, so
   * deleting the query filter — the only one that reaches the rendered list,
   * `selectAll` and `onDriversLoaded` — left the test green. Naming the
   * mechanism is what makes the control bite.
   */
  readonly filter?: 'query' | 'memory';
  readonly why: string;
}

/**
 * Declared in the order the reads appear in each file.
 *
 * A `chooser` is additionally required to filter. The two ways to do that are a
 * `.eq('status', ACTIVE_DRIVER_STATUS)` inside the statement, or — for a list the
 * screen holds in full and partitions — a `selectableDrivers(` call in the same
 * file. Nothing else counts.
 */
const DRIVER_READS: Record<string, readonly DeclaredRead[]> = {
  // ── Choosers: a driver offered for work that has not happened yet ──────────
  'components/MonatsplanungDriverPool.tsx': [
    {
      statement: "select('*')",
      kind: 'chooser',
      filter: 'query',
      why: "The plan generator's own pool. It renders the list, 'Alle auswählen' selects from it, and `onDriversLoaded` hands it to the engine on both CompanyPlannerPage and MonthlyPlanPage. This is the list the owner's instruction names first.",
    },
  ],
  'components/CarModal.tsx': [
    {
      statement: "select('id, name, status')",
      kind: 'chooser',
      filter: 'query',
      why: 'Assigns drivers to a vehicle — an assignment that applies from now on.',
    },
  ],
  'components/MietwagenauftragModal.tsx': [
    {
      statement: "select('id, name')",
      kind: 'chooser',
      filter: 'query',
      why: 'The driver a new Mietwagenauftrag is written for.',
    },
  ],
  'components/TrinkgeldQuittungModal.tsx': [
    {
      statement: "select('id, name, gender')",
      kind: 'chooser',
      filter: 'query',
      why: 'The driver a new Trinkgeld-Quittung is issued to.',
    },
  ],
  'pages/FahrtenbuchPage.tsx': [
    {
      statement: "select('id, name')",
      kind: 'chooser',
      filter: 'query',
      why: "The Fahrtenbuch's assignment picker: who a trip is reassigned to.",
    },
  ],
  'pages/NotesPage.tsx': [
    {
      statement: "select('id, name')",
      kind: 'chooser',
      filter: 'query',
      why: 'The driver a new note is filed against; a note steers future planning.',
    },
  ],
  'components/HistoricalReconciliationWizard.tsx': [
    {
      statement: "select('id, name, personalnummer, employment_type",
      kind: 'chooser',
      filter: 'memory',
      why: "Brutto-Gehälter mode's driver list. Classified chooser because it has filtered the deactivated out in memory since before this change, which is what the owner asks for. It is the one genuinely ambiguous site: the wizard reconstructs a past month, so the sibling Arbeitsstunden wizard deliberately includes them. Not reopened here — see the PR.",
    },
  ],

  // ── Records: what happened, and lookups for an id already in hand ──────────
  'components/HistoricalWorkingHoursWizard.tsx': [
    {
      statement: "select('id,name,personalnummer,employment_type",
      kind: 'record',
      why: 'Reconstructs a PAST month from imported rides. Someone who left since may well have driven it, and the comment at the call site has said so since the dead `.neq(status,archived)` filter was removed.',
    },
  ],
  'components/MonatsplanungStundennachweisPreview.tsx': [
    {
      statement: "select('id, personalnummer, planning_hourly_rate",
      kind: 'record',
      why: "Wage lookup by `.in('id', driverIds)` for the drivers an applied run already contains. Filtering would blank a figure on a produced Stundennachweis.",
    },
  ],
  'components/CarsManagement.tsx': [
    {
      statement: "select('id, name, status')",
      kind: 'record',
      why: "Resolves the names of the drivers each vehicle is CURRENTLY assigned to. Filtering would drop the assignment row silently (`.filter(d => d !== null)`) and the vehicle would read as unassigned — hiding a state the operator has to fix. It is marked instead.",
    },
  ],
  'pages/AbrechnungPage.tsx': [
    {
      statement: "select('id, name, email')",
      kind: 'record',
      why: "A name-to-address lookup for `planRecipients`; the names come from the finished week's Abrechnung rows. Filtering would make a deactivated driver who worked that week resolve to no address and silently drop their mail.",
    },
  ],
  'pages/BargeldbestandPage.tsx': [
    {
      statement: "select('id, name')",
      kind: 'record',
      why: 'An id-to-name map for Gehaltsquittungen already issued. The till reads what was paid.',
    },
  ],
  'pages/MonthlyPlanPage.tsx': [
    {
      statement: "select('id, planning_priority, can_cover_other_drivers')",
      kind: 'record',
      why: "Two planning columns the pool's mapper does not carry, consulted only as `extraById.get(d.id)` for drivers the pool already admitted. The pool is the boundary; a second filter here would be a second place the rule lives.",
    },
  ],
  'pages/SalariesPage.tsx': [
    {
      statement: "select('*')",
      kind: 'record',
      why: 'Both halves in one read. `SalariesManagement` partitions it with `selectableDrivers` for the calculation and the picker, and keeps the full list for the name lookup behind an existing salary.',
    },
  ],
  'pages/StundennachweisPage.tsx': [
    {
      statement: "select('id, name, personalnummer, work_window_start",
      kind: 'chooser',
      filter: 'query',
      why: 'Picks the driver a NEW Stundennachweis is generated for.',
    },
    {
      statement: "select('planning_hourly_rate, planning_target_salary",
      kind: 'record',
      why: "Hydrates one saved record's salary metadata by `.eq('id', …)`. A single row already identified.",
    },
    {
      statement: "select('id, name, personalnummer, status')",
      kind: 'record',
      why: 'The Fahrerübersicht export of a past month. Active drivers, plus any driver with a saved Stundennachweis for that month — so a driver deactivated since is still in the month they worked, and no former driver adds an empty row to a month they did not. Note that `handleGenerateFahreruebersicht` is referenced nowhere and is in the typecheck baseline as unused: this export cannot currently be reached, so the rule is recorded against the day it is rewired rather than fixing a sheet an operator has produced.',
    },
  ],
  'lib/salaryCashReceipts.ts': [
    {
      statement: "select('id, name, gender, status')",
      kind: 'record',
      why: 'A salary can be owed after someone leaves, so the Gehaltsquittung must reach them — the comment at the call site has said so since 3.13. The picker marks them instead of hiding them.',
    },
  ],
  'lib/tripAnalysisClient.ts': [
    {
      statement: "select('id, name, status, planning_min_salary",
      kind: 'record',
      why: "Fahrtenanalyse reads an import that already happened. Filtering would drop a deactivated driver's analysed rides and make them read as `unlinkedDrivers` — a finding of fact that is not one. The driver table marks them. SimulatedRidesPage shares this reader and filters on its own side, where the list is a chooser.",
    },
  ],
  'hooks/useDatabase.ts': [
    {
      statement: "select('*')",
      kind: 'record',
      why: 'The one shared read, and it must stay complete: FahrerPage renders the Fahrer screen from it, which has an inactive section by design. Its four consumers each apply the rule — ReceiptModal, IncomeManagement and PartnerLinkProposals with `selectableDrivers`, OverviewPage and the list views as records.',
    },
    { statement: 'insert(', kind: 'write', why: 'Creates a driver; not a read of the table.' },
  ],
};

/**
 * `SimulatedRidesPage` and `TripAnalysisPage` reach the table through
 * `loadCompanyDrivers`, so they carry no `from('drivers')` of their own and the
 * registry above cannot see them. The shared reader is a record (an import that
 * already happened); the simulator's use of it is a chooser, and is required to
 * filter here.
 */
const INDIRECT_CHOOSERS: readonly string[] = ['pages/SimulatedRidesPage.tsx'];

const SRC = fileURLToPath(new URL('../', import.meta.url));
const READ_MARKER = "from('drivers')";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

const read = (relative: string): string => readFileSync(`${SRC}${relative}`, 'utf8');

/** Comments out, so prose naming a status literal is not read as a filter. */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

/** The chain that follows one `from('drivers')`, up to the next statement. */
function statementAfter(source: string, markerEnd: number): string {
  const rest = source.slice(markerEnd, markerEnd + 600);
  const stops = [rest.indexOf(';'), rest.indexOf(".from('")].filter(index => index >= 0);
  return stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
}

function statementsIn(relative: string): string[] {
  const source = read(relative);
  const out: string[] = [];
  for (let at = source.indexOf(READ_MARKER); at >= 0; at = source.indexOf(READ_MARKER, at + 1)) {
    out.push(statementAfter(source, at + READ_MARKER.length));
  }
  return out;
}

/** The rule's own home: its header quotes the marker in prose, not in code. */
const RULE_MODULE = 'utils/driverStatus.ts';

const filesWithDriverReads = (): string[] =>
  sourceFiles(SRC)
    .map(path => path.slice(SRC.length).split('\\').join('/'))
    .filter(file => file !== RULE_MODULE)
    .filter(file => read(file).includes(READ_MARKER))
    .sort();

const QUERY_FILTER = /\.eq\(\s*'status'\s*,\s*ACTIVE_DRIVER_STATUS\s*\)/;

describe('every browser read of public.drivers is classified', () => {
  const found = filesWithDriverReads();

  it('declares exactly the files that read the table', () => {
    expect(found).toEqual(Object.keys(DRIVER_READS).sort());
  });

  it.each(found)('%s declares each of its reads, in order', file => {
    const declared = DRIVER_READS[file] ?? [];
    const statements = statementsIn(file);

    expect(statements).toHaveLength(declared.length);
    statements.forEach((statement, index) => {
      const entry = declared[index];
      expect(entry.why.length, `${file} read ${index + 1} needs a reason`).toBeGreaterThan(20);
      // The declaration must name the statement it classifies, or the order
      // could drift and a chooser inherit a record's exemption.
      expect(statement, `${file} read ${index + 1} is not the declared "${entry.statement}"`)
        .toContain(entry.statement);
    });
  });
});

describe('a chooser excludes the deactivated', () => {
  const direct = Object.entries(DRIVER_READS).flatMap(([file, reads]) =>
    reads.map((entry, index) => ({ file, entry, index })),
  ).filter(({ entry }) => entry.kind === 'chooser');

  it.each(direct)('$file read $index filters, by the mechanism it declares', ({ file, entry, index }) => {
    const statement = statementsIn(file)[index] ?? '';
    const complaint =
      `${file} offers drivers to pick from, so a deactivated driver would be `
      + `offered for future work. Reason on file: ${entry.why}`;

    if (entry.filter === 'query') {
      expect(QUERY_FILTER.test(statement), `${complaint} Its declared filter is the `
        + `query's .eq('status', ACTIVE_DRIVER_STATUS), and that is gone.`).toBe(true);
      return;
    }
    expect(entry.filter, `${file} read ${index} is a chooser and must declare `
      + `filter: 'query' or filter: 'memory'`).toBe('memory');
    expect(withoutComments(read(file)).includes('selectableDrivers('),
      `${complaint} Its declared filter is a selectableDrivers() call, and that is gone.`).toBe(true);
  });

  it.each(INDIRECT_CHOOSERS)('%s filters the shared reader it borrows', file => {
    expect(withoutComments(read(file))).toContain('selectableDrivers(');
  });
});

describe('the rule is spelled through the shared helper', () => {
  /**
   * Two narrow lexical checks, and narrow on purpose.
   *
   * `.eq('status', …)` in a file that queries `drivers` can only be about a
   * driver, so that one is exact. The in-memory form cannot be: `cars` carries a
   * `status` column of its own, and both `CarsManagement` and `NotesPage`
   * legitimately compare a CAR's against the same two words. So the receiver has
   * to look like a driver — `d.status` or `driver.status`, the only two
   * spellings the twelve in-memory filters used before `driverStatus.ts`
   * existed. A destructured `const { status } = driver` would slip past; this is
   * hygiene, and the chooser check above is the gate.
   */
  const QUERY_LITERAL = /\.eq\(\s*'status'\s*,\s*'(active|inactive)'\s*\)/;
  const DRIVER_LITERAL = /\b(d|driver)\.status\s*(!==|===)\s*'(active|inactive)'/;

  it.each([...filesWithDriverReads(), ...INDIRECT_CHOOSERS])(
    '%s hard-codes neither status literal',
    file => {
      const source = withoutComments(read(file));
      expect(QUERY_LITERAL.test(source), `${file}: query literal`).toBe(false);
      expect(DRIVER_LITERAL.test(source), `${file}: in-memory literal`).toBe(false);
    },
  );
});
