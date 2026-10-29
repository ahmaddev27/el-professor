/**
 * Writes the committed fixture the export service's independent test reads:
 *
 *   npx vite-node scripts/audit-round4-fixture.mts
 *
 * A small invented month (see `reportFixture.ts`: "Teststraße N, 40210
 * Demostadt", "Fahrer 1..3", `XX-TEST-n`) built with a synthetic routed model,
 * declined fee on (600 cents), a monthly share, a confirmed and an unconfirmed
 * note and an expired TÜV. Only invented data is written, so the output may be
 * committed. `*.expected.json` carries the counts the Python test compares the
 * written file against; they come from the generator, not from the workbook.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMonthReport } from '../src/utils/simulatedRides/monthWorkbook';
import { buildFixtureMonth } from './lib/reportFixture';

const OUT = path.resolve(import.meta.dirname, '../deploy/export-service/tests/fixtures');

const result = await buildFixtureMonth({ year: 2026, month: 2, seed: 20261029, vehicles: 2 });
const report = buildMonthReport(result);

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'simulation_report.json'), JSON.stringify(report.payload));
writeFileSync(path.join(OUT, 'simulation_report.expected.json'), JSON.stringify({
  fileName: report.fileName,
  year: result.provenance.year,
  month: result.provenance.month,
  days: result.days.length,
  routeChecks: result.routeChecks.length,
  declinedCount: result.revenue.counts.declined,
  declinedFeeCents: result.revenue.declinedFeeCents,
  declinedFeeUnitCents: result.provenance.settings.declinedFeeCents,
  rides: result.month.rides.length,
  fareCents: result.revenue.fareCents,
  routeStatuses: result.routeSummary.byStatus,
}, null, 2));
console.log(`${report.fileName}: ${result.month.rides.length} rides, ${result.routeChecks.length} route checks, ${result.days.filter(d => d.zeroRideDay).length} zero-ride days`);
console.log(JSON.stringify(result.routeSummary.byStatus), 'declined', result.revenue.counts.declined, 'cancelled', result.revenue.counts.cancelled);
