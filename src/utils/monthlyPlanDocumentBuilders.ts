/**
 * Which of the monthly plan's three documents this build can produce.
 *
 * **This file is the wiring point, and it is the only one.** Screen 4 imports
 * this table and nothing else, so adding a document is one import and one entry
 * here — no change to the screen, and no chance of the screen acquiring a figure
 * of its own on the way.
 *
 * The three builders are being written in parallel, each on its own branch, and
 * none of them existed when the screen was written. So the table starts empty
 * and the screen says plainly, per document, that this build does not produce it
 * yet — which is the honest state, and far better than a screen that draws an
 * empty table where a Stundennachweis should be.
 *
 * To wire one, uncomment its import and its entry:
 *
 *   import { monthlyPlanStundennachweis } from './monthlyPlanStundennachweis';
 *     // feat/monthly-plan-doc-stundennachweis → §11
 *   import { monthlyPlanFahrtenbuch } from './monthlyPlanFahrtenbuchExport';
 *     // feat/monthly-plan-doc-fahrtenbuch → §10
 *   import { monthlyPlanPayrollSummary } from './monthlyPlanPayrollSummary';
 *     // feat/monthly-plan-doc-payroll → §12
 *
 * Each must satisfy `MonthlyPlanDocumentBuilder` in `monthlyPlanDocuments.ts`,
 * which is where that contract is written down and why. A builder whose export
 * has another name is renamed here, not in the screen.
 */

import type { MonthlyPlanDocumentBuilders } from './monthlyPlanDocuments';

export const MONTHLY_PLAN_DOCUMENT_BUILDERS: MonthlyPlanDocumentBuilders = {
  // stundennachweis: monthlyPlanStundennachweis,
  // fahrtenbuch: monthlyPlanFahrtenbuch,
  // payroll_summary: monthlyPlanPayrollSummary,
};
