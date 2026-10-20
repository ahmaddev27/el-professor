import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every file under src/ that names `fahrtenbuch_trips`, and what keeps a
 * simulated ride from reaching a figure or a document unannounced.
 *
 * The Fahrtenbuch is not a leaf: planning, the Stundennachweis, the Lohnart
 * premiums, the payroll summary and the analysis all read trips and none asks
 * whether a trip was real. The money cannot move: simulated rides are derived
 * from the recorded income and add up to it to the cent (figures.test.ts), and a
 * driver-week holds real trips or simulated ones, never both
 * (`fahrtenbuch_trips_refuse_double_count`, tests/rls/simulated-rides.sql).
 * The TIMES are invented, though, and hours-based readers print them, so:
 *
 *   marks     the file it writes says SIMULIERT (sheet, line, file name)
 *   isolated  it reads trips and produces figures or documents from the invented
 *             times or routes, and does NOT yet print the marker itself. This is
 *             the open gap: do not use these in a company whose drivers are paid
 *             by hours until the marker is printed on each.
 *   counts    it reads trips only to count or delete them; no figure, no document
 *
 * A new reader fails this test until someone writes its line down.
 */
type Disposition = 'marks' | 'isolated' | 'counts';

const INVENTORY: Record<string, Disposition> = {
  'components/CompanyDeletionPreview.tsx': 'counts',
  'components/FinalizePlanningModal.tsx': 'isolated',
  'components/HistoricalReconciliationWizard.tsx': 'isolated',
  'components/HistoricalWorkingHoursWizard.tsx': 'isolated',
  'components/MonatsplanungAppliedRuns.tsx': 'isolated',
  'components/MonatsplanungStundennachweisPreview.tsx': 'isolated',
  'components/MonthlyPlanDocumentsStep.tsx': 'isolated',
  'hooks/useFahrtenbuch.ts': 'marks',
  'lib/platformCompanyDeletion.ts': 'counts',
  'lib/tripAnalysisClient.ts': 'isolated',
  'pages/AbnahmeDiagnosticPage.tsx': 'counts',
  'pages/CompanyPlannerPage.tsx': 'isolated',
  'pages/MonthlyPlanPage.tsx': 'isolated',
  'pages/SimulatedRidesPage.tsx': 'counts',
  'pages/TripAnalysisPage.tsx': 'isolated',
  'utils/backup.ts': 'counts',
  'utils/fahrtenbuchImportParser.ts': 'counts',
  'utils/monatsplanungXlsxExport.ts': 'marks',
  'utils/monthlyPlan/blocks.ts': 'isolated',
  'utils/monthlyPlanDocuments.ts': 'isolated',
  'utils/monthlyPlanFahrtenbuchExport.ts': 'marks',
  'utils/monthlyPlanPayrollSummary.ts': 'isolated',
  'utils/monthlyPlanStundennachweis.ts': 'isolated',
  'utils/returnCheck/parse.ts': 'isolated',
  'utils/shiftRecommendation/types.ts': 'isolated',
  'utils/shiftRecommendationReference.ts': 'isolated',
  'utils/tripAnalysis/adapter.ts': 'isolated',
  'utils/tripAnalysis/types.ts': 'isolated',
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
      expect(/simulatedRides\/marker|is_simulated/.test(text), file).toBe(true);
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
});
