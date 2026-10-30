/**
 * Writes the committed fixtures the export service's independent tests read:
 *
 *   npx vite-node scripts/audit-round4-fixture.mts
 *
 * A small invented month (see `reportFixture.ts`: "Teststraße N, 40210
 * Demostadt", "Fahrer 1..3", `XX-TEST-n`) built with a synthetic routed model,
 * declined orders on (600 cents, internal only), a cancellation fee of 600
 * cents, a monthly share, a confirmed and an unconfirmed note and an expired
 * TÜV. Both files of the month are written: the Fahrtenbuch report and the
 * operational report (round 6). Only invented data is written, so the output
 * may be committed. `*.expected.json` carries the counts the Python tests
 * compare the written files against; they come from the generator, not from
 * the workbook.
 *
 * The name is round 4's, kept because the round-4 delivery's README names it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMonthReport } from '../src/utils/simulatedRides/monthWorkbook';
import { verifyMonth } from '../src/utils/simulatedRides/monthVerification';
import { buildOperationalReport } from '../src/utils/simulatedRides/operationalReport';
import { buildFixtureMonth } from './lib/reportFixture';

const OUT = path.resolve(import.meta.dirname, '../deploy/export-service/tests/fixtures');

const result = await buildFixtureMonth({ year: 2026, month: 2, seed: 20261029, vehicles: 2 });
const verification = verifyMonth(result);
const report = buildMonthReport(result, verification);
const operational = buildOperationalReport(result, verification);

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'simulation_report.json'), JSON.stringify(report.payload));
writeFileSync(path.join(OUT, 'operational_report.json'), JSON.stringify(operational.payload));
writeFileSync(path.join(OUT, 'simulation_report.expected.json'), JSON.stringify({
  fileName: report.fileName,
  operationalFileName: operational.fileName,
  verdict: verification.verdict,
  year: result.provenance.year,
  month: result.provenance.month,
  days: result.days.length,
  seed: result.provenance.seed,
  runId: result.provenance.runId,
  tenantId: result.provenance.tenantId,
  routeChecks: result.routeChecks.length,
  routeStatuses: result.routeSummary.byStatus,
  reportRides: result.revenue.counts.completed + result.revenue.counts.cancelled,
  completed: result.revenue.counts.completed,
  cancelled: result.revenue.counts.cancelled,
  cancellationFeeCents: result.revenue.cancelledFeeCents,
  cancellationFeeUnitCents: result.provenance.settings.cancellationFeeCents,
  fareCents: result.revenue.fareCents,
  declinedCount: result.internal.declined.counts.declined,
  declinedFeeCents: result.internal.declined.declinedFeeCents,
  declinedFeeUnitCents: result.provenance.settings.declinedFeeCents,
  legs: result.repositioning.length,
  legStatuses: result.repositioningSummary.byStatus,
  marginSeconds: result.provenance.options.repositioningMarginSeconds,
  marginPercent: result.provenance.options.repositioningMarginPercent,
}, null, 2));
console.log(`${report.fileName}: ${result.revenue.counts.completed} completed, ${result.revenue.counts.cancelled} cancelled, ${result.routeChecks.length} route checks, ${result.repositioning.length} legs`);
console.log(`${operational.fileName}: ${result.internal.declined.counts.declined} declined (internal)`);
console.log(JSON.stringify(result.routeSummary.byStatus), verification.verdict);
