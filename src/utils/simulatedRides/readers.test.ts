import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every file under src/ that names `fahrtenbuch_trips`, and what it does about
 * simulated rides. There are two answers and no third.
 *
 * The Fahrtenbuch is not a leaf: planning, the Stundennachweis, the Lohnart
 * premiums, the payroll summary and the analysis all read trips and none asked
 * whether a trip was real. The money cannot move (simulated rides are derived
 * from the recorded income and add up to it to the cent, figures.test.ts; a
 * driver-week holds real or simulated trips, never both,
 * tests/rls/simulated-rides.sql). The TIMES are invented, though, and
 * hours-based documents print them. So the rule is the rides': a document whose
 * source trips include a simulated one carries the marker (SIMULIERT line,
 * notice sheet or PDF stamp, and the SIMULIERT_ file name), whatever company it
 * is in.
 *
 *   marks   the file produces or forwards a document or a screen of figures and
 *           carries the marker itself (it reads is_simulated, or asks the
 *           import), or EXCLUDES simulated rides from what it computes
 *   counts  the file reads trips without producing a document: a pure engine or
 *           type, a count, a deletion preview, or a screen that only hands rows
 *           to a builder that marks (named in the comment beside it)
 *
 * A new reader fails this test until someone writes its line down, and a
 * 'marks' line must really mention the marker.
 */
type Disposition = 'marks' | 'counts';

const INVENTORY: Record<string, Disposition> = {
  'components/CompanyDeletionPreview.tsx': 'counts',
  'components/FinalizePlanningModal.tsx': 'marks',
  'components/HistoricalReconciliationWizard.tsx': 'marks',
  'components/HistoricalWorkingHoursWizard.tsx': 'marks',
  'components/MonatsplanungAppliedRuns.tsx': 'counts', // export goes through exportAppliedRunXlsx (marks)
  'components/MonatsplanungStundennachweisPreview.tsx': 'marks',
  'components/MonthlyPlanDocumentsStep.tsx': 'counts', // renders builder output; every builder is wrapped by markSimulated
  'hooks/useFahrtenbuch.ts': 'marks',
  'lib/platformCompanyDeletion.ts': 'counts',
  'lib/tripAnalysisClient.ts': 'marks',
  'pages/AbnahmeDiagnosticPage.tsx': 'counts',
  'pages/CompanyPlannerPage.tsx': 'counts', // lists runs; the documents come from Preview and Finalize (marks)
  'pages/MonthlyPlanPage.tsx': 'marks',
  'pages/SimulatedRidesPage.tsx': 'counts',
  'pages/TripAnalysisPage.tsx': 'marks',
  'utils/backup.ts': 'counts',
  'utils/fahrtenbuchImportParser.ts': 'counts', // the import path, which sets the marker
  'utils/monatsplanungXlsxExport.ts': 'marks',
  'utils/monthlyPlan/blocks.ts': 'counts', // pure block engine, no document
  'utils/monthlyPlanDocuments.ts': 'marks',
  'utils/monthlyPlanFahrtenbuchExport.ts': 'marks',
  'utils/monthlyPlanPayrollSummary.ts': 'counts', // pure figures; the payroll builder that prints them is wrapped by markSimulated
  'utils/monthlyPlanStundennachweis.ts': 'marks',
  'utils/returnCheck/parse.ts': 'counts', // pure row reader, no document
  'utils/shiftRecommendation/types.ts': 'counts', // types only; ShiftRecommendationPage drops simulated rides before learning
  'utils/shiftRecommendationReference.ts': 'counts', // pure statistics over rows the page already filtered
  'utils/tripAnalysis/adapter.ts': 'counts', // pure adapter, no document
  'utils/tripAnalysis/types.ts': 'marks',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('readers of fahrtenbuch_trips', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const found = sources(root)
    .filter(file => readFileSync(file, 'utf8').includes('fahrtenbuch_trips'))
    .map(file => path.relative(root, file).split(path.sep).join('/'))
    .sort();

  it('are exactly the files the inventory names, so a new reader needs a decision', () => {
    expect(found).toEqual(Object.keys(INVENTORY).sort());
  });

  it('every file that marks really contains the marker', () => {
    for (const [file, how] of Object.entries(INVENTORY)) {
      if (how !== 'marks') continue;
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(/[sS]imulated|SIMULIERT/.test(text), file).toBe(true);
    }
  });

  it('the migration carries the mixing wall the inventory relies on', () => {
    const migrations = path.resolve(root, '../supabase/migrations');
    const sql = readdirSync(migrations).filter(f => f.includes('simulated_rides')).map(f => readFileSync(path.join(migrations, f), 'utf8')).join('\n');
    expect(sql).toContain('CREATE TRIGGER fahrtenbuch_trips_refuse_double_count');
    expect(sql).toContain("HINT = 'simulated_double_count_refused'");
  });

  it('nothing in the generator or its screen writes the books: income is only ever read', () => {
    const files = [...sources(path.join(root, 'utils/simulatedRides')), path.join(root, 'pages/SimulatedRidesPage.tsx')];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(/from\(['"](income|receipts|cash_transactions|cash_movements|salaries|salary_payments)['"]\)\s*\.\s*(insert|update|upsert|delete)/.test(text), file).toBe(false);
    }
  });

  it('the shift recommendation never learns from simulated rides', () => {
    const page = readFileSync(path.join(root, 'pages/ShiftRecommendationPage.tsx'), 'utf8');
    expect(page).toMatch(/is_simulated !== true/);
  });

  it('every file that writes a Stundennachweis PDF decides whether it is simulated', () => {
    const callers = sources(root).filter(file => /exportStundennachweisAsPdf\(|getStundennachweisBlob\(/.test(readFileSync(file, 'utf8'))
      && !file.endsWith('stundennachweisPdfExport.ts'));
    expect(callers.length).toBeGreaterThan(4);
    for (const file of callers) expect(readFileSync(file, 'utf8'), file).toMatch(/simulated/);
  });

  it('the PDF writer takes the flag as a REQUIRED property, so a new caller cannot forget it', () => {
    const writer = readFileSync(path.join(root, 'utils/stundennachweisPdfExport.ts'), 'utf8');
    expect(writer).toMatch(/\n  simulated: boolean;/);
    expect(writer).not.toMatch(/simulated\?: boolean/);
  });
});
