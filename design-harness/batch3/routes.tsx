/**
 * Batch 3's pages at their real routes, for design-harness/main.tsx.
 *
 * Dokumente links to /stundennachweis (the tool card and "Öffnen" on an archived
 * record), and the Stundennachweis page goes back to /dokumente, so both are
 * registered together and the harness can follow those links in memory.
 */
import { Route } from 'react-router-dom';
import CompanyPlannerPage from '../../src/pages/CompanyPlannerPage';
import DocumentsPage from '../../src/pages/DocumentsPage';
import StundennachweisPage from '../../src/pages/StundennachweisPage';
import { archivedRecord, batch3Entry, batch3Screen } from './fixtures';

export const BATCH3_ROUTES = (
  <>
    <Route path="dokumente" element={<DocumentsPage />} />
    <Route path="stundennachweis" element={<StundennachweisPage />} />
    <Route path="company-planner" element={<CompanyPlannerPage />} />
  </>
);

const PATHS = {
  dokumente: '/dokumente',
  monatsplanung: '/company-planner',
  stundennachweis: '/stundennachweis',
} as const;

/**
 * Where the memory router starts on one of this batch's screens, or undefined
 * on another batch's. `entry=archiv` arrives on the Stundennachweis page with
 * the router state DocumentsPage's "Öffnen" sends: the saved record itself.
 */
export function batch3InitialEntry(): string | { pathname: string; state: unknown } | undefined {
  if (!batch3Screen) return undefined;
  if (batch3Screen === 'stundennachweis' && batch3Entry === 'archiv') {
    return { pathname: PATHS.stundennachweis, state: { savedRecord: archivedRecord() } };
  }
  return PATHS[batch3Screen];
}
