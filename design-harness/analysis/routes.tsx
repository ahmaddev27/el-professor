/**
 * The Fahrtenanalyse at its real route, for design-harness/main.tsx.
 *
 * The screen links to Dokumente when a month has no Fahrtenbuch, so both are
 * registered together (batch 3 already registers Dokumente; this adds only
 * the analysis itself) and the harness can follow that link in memory.
 */
import { Route } from 'react-router-dom';
import TripAnalysisPage from '../../src/pages/TripAnalysisPage';
import { isAnalysisScreen } from './fixtures';

export const ANALYSIS_ROUTES = <Route path="fahrtenanalyse" element={<TripAnalysisPage />} />;

/** Where the memory router starts on this screen, or undefined on another batch's. */
export function analysisInitialEntry(): string | undefined {
  return isAnalysisScreen ? '/fahrtenanalyse' : undefined;
}
