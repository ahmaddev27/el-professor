/**
 * The deliverables of the external audit's round 3, section 9: a full-month
 * XLSX, a financial report, and the driver and vehicle constraint table.
 *
 *   npx vite-node scripts/audit-round3-deliverables.mts
 *
 * ## Every input is invented, and that is deliberate
 *
 * This repository is **public**. The real generator takes its drivers, plates
 * and address pool from a company's own tables and from OpenStreetMap, so a
 * month generated against a real tenant carries real names and real addresses —
 * which is exactly what the earlier rounds of this audit shipped by accident.
 *
 * So the pool here is fictional ("Teststrasse 1, 40210 Demostadt"), the
 * drivers are "Fahrer 1..3", and the plates are not issuable. Nothing in the
 * output names a person, a place or a vehicle that exists. The figures are
 * therefore a demonstration of the pipeline and **not a measurement of any
 * company**, which the workbook's own source sheet states.
 *
 * ## It is not a test and does not assert
 *
 * The properties are asserted in `fullMonth.test.ts`, `revenue.test.ts`,
 * `monthWorkbook.test.ts` and `monthlyRate.test.ts`. This script only writes
 * what those tests already cover, so that an auditor has the artefact in hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildConstraintDecisionLog,
  summariseConstraintLog,
  type ConstraintDecision,
} from '../src/utils/constraintDecisionLog';
import type { StructuredNote } from '../src/utils/monatsplanungPhase3';
import { formatCentsDe } from '../src/utils/money';
import {
  FULL_MONTH_GENERATOR_VERSION,
  generateFullMonth,
  type FullMonthDriver,
  type FullMonthResult,
  type FullMonthVehicle,
} from '../src/utils/simulatedRides/fullMonth';
import { buildMonthWorkbook, reconcile } from '../src/utils/simulatedRides/monthWorkbook';
import { SIMULATED_NOTICE } from '../src/utils/simulatedRides/marker';
import type { PoolAddress } from '../src/utils/simulatedRides/types';
import type { SimulationTenantSettings } from '../src/utils/simulatedRides/tenantSettings';

const OUT = path.resolve(import.meta.dirname, '../Docs/audit/round3');

const SEED = 20261027;
const YEAR = 2026;
const MONTH = 10;

/** A fictional pool. Twenty-four points on a grid, with labels that name nowhere. */
const POOL: PoolAddress[] = Array.from({ length: 24 }, (_, i) => ({
  lat: 51.24 + (i % 6) * 0.012,
  lon: 7.12 + Math.floor(i / 6) * 0.015,
  label: `Teststrasse ${i + 1}, 40210 Demostadt`,
}));

const BASE = { lat: 51.2562, lon: 7.1508 };

const VEHICLES: FullMonthVehicle[] = [
  { id: '11111111-1111-4111-8111-111111111101', plate: 'XX-TEST-1', type: 'Limousine', tuev_gueltig_bis: '2027-04-30' },
  { id: '11111111-1111-4111-8111-111111111102', plate: 'XX-TEST-2', type: 'Limousine', tuev_gueltig_bis: '2026-09-30' },
  { id: '11111111-1111-4111-8111-111111111103', plate: 'XX-TEST-3', type: 'Limousine', tuev_gueltig_bis: null },
];

/**
 * All three drivers work Monday to Friday.
 *
 * It is a realistic shape for a three-driver operation, and it is chosen so the
 * deliverable **demonstrates** what section 2 asks for rather than only
 * supporting it: with a driver available every day of the week, no day of
 * October is empty, and a month summary with no zero-ride day in it shows
 * nothing about whether zero-ride days are carried. With the weekend closed,
 * every Saturday and Sunday is a zero-ride day, present in the summary with its
 * reason. `fullMonth.test.ts` asserts the property; this makes it visible.
 */
const DRIVERS: FullMonthDriver[] = [
  { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1', allowed_weekdays: [1, 2, 3, 4, 5] },
  { id: '22222222-2222-4222-8222-222222222202', name: 'Fahrer 2', allowed_weekdays: [1, 2, 3, 4, 5] },
  { id: '22222222-2222-4222-8222-222222222203', name: 'Fahrer 3', allowed_weekdays: [1, 2, 3, 4, 5], notes: 'keine Nachtschicht' },
];

const note = (over: Partial<StructuredNote> & { id: string; driver_id: string; note_type: string }): StructuredNote => ({
  note_text: '',
  note_planning_behavior: 'neutral',
  is_full_day: true,
  start_date: null,
  end_date: null,
  note_date: null,
  start_time: null,
  end_time: null,
  ...over,
});

/**
 * One note of each kind the decision log has an answer for, so the constraint
 * table in the deliverable shows every row type rather than only the common one.
 */
const NOTES = new Map<string, StructuredNote[]>([
  [DRIVERS[0].id, [
    // Confirmed, with its own window: a hard block.
    note({ id: 'n1', driver_id: DRIVERS[0].id, note_type: 'vacation', note_planning_behavior: 'exclude_from_plan',
           start_date: '2026-10-12', end_date: '2026-10-18' }),
    // A past violation: a warning, never a block.
    note({ id: 'n2', driver_id: DRIVERS[0].id, note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan',
           start_date: '2026-10-05', end_date: '2026-10-05' }),
  ]],
  [DRIVERS[1].id, [
    // No start_date: the window falls back to the notice's own timestamp, which
    // is the finding the log reports rather than silently changes.
    note({ id: 'n3', driver_id: DRIVERS[1].id, note_type: 'sick', note_planning_behavior: 'exclude_from_plan',
           note_date: '2026-10-22T09:14:00Z' }),
    note({ id: 'n4', driver_id: DRIVERS[1].id, note_type: 'general' }),
  ]],
  // A note whose driver is not in the pool: no automatic link is made.
  ['22222222-2222-4222-8222-2222222299ff', [
    note({ id: 'n5', driver_id: '22222222-2222-4222-8222-2222222299ff', note_type: 'off',
           note_planning_behavior: 'exclude_from_plan', start_date: '2026-10-09', end_date: '2026-10-09' }),
  ]],
]);

const WERKSTATT = [
  { car_id: VEHICLES[0].id, check_date: '2026-10-06', status: 'positive' as const, notes: '' },
  { car_id: VEHICLES[1].id, check_date: '2026-10-13', status: 'negative' as const, notes: 'Bremsen prüfen' },
];

const SETTINGS: Partial<SimulationTenantSettings> = {
  // Both audit features on, so the deliverable exercises them. They ship off.
  declinedRidesEnabled: true,
  declinedShare: 0.06,
  declinedFeeCents: 600,
  chargeDeclinedFeeOnCancelled: false,
  monthlyRevenueShareEnabled: true,
  basisIncludesTips: false,
  basisIncludesDeclinedFees: true,
};

const euro = (cents: number): string => `${formatCentsDe(cents)} EUR`;

function financialReport(r: FullMonthResult): string {
  const { revenue: v, basis, share, provenance: p } = r;
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(44, '.')} ${value}`);

  lines.push('FINANZBERICHT — SIMULIERTER MONAT');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push(SIMULATED_NOTICE);
  lines.push('');
  lines.push('Die Zahlen stammen aus einem Generator mit erfundenen Eingaben.');
  lines.push('Sie sind keine Messung eines Unternehmens und kein Zahlungsnachweis.');
  lines.push('');
  lines.push(`Zeitraum: ${String(p.month).padStart(2, '0')}/${p.year}   Seed: ${p.seed}   Generator: ${p.generatorVersion}`);
  lines.push(`Zeitzone: ${p.settings.timeZone}   Betriebstagsbeginn: ${String(p.settings.operatingDayStartHour).padStart(2, '0')}:00`);
  lines.push(`Datenquelle: ${p.inputSource} (der Zeitraum kommt aus dem Kalender, die Umsätze sind erzeugt)`);
  lines.push('');
  lines.push('1. AUFTRÄGE');
  lines.push('-'.repeat(72));
  row('Aufträge insgesamt', String(v.counts.total));
  row('davon abgeschlossen', String(v.counts.completed));
  row('davon abgelehnt (DECLINED)', String(v.counts.declined));
  row('davon storniert (CANCELLED)', String(v.counts.cancelled));
  lines.push('');
  lines.push('2. ERLÖSE');
  lines.push('-'.repeat(72));
  row('Fahrpreise abgeschlossener Fahrten', euro(v.fareCents));
  row('  davon per App', euro(v.appFareCents));
  row('  davon Bargeld', euro(v.cashFareCents));
  row('Trinkgelder', euro(v.tipCents));
  row('Ablehnungsgebühren', euro(v.declinedFeeCents));
  row('Stornogebühren nach Firmenregel', euro(v.cancelledFeeCents));
  row('Kilometer abgeschlossener Fahrten', `${v.km.toFixed(2).replace('.', ',')} km`);
  lines.push('');
  lines.push('   Nicht gezählt, nur ausgewiesen:');
  row('   Fahrpreisspalte stornierter Fahrten', euro(v.cancelledSheetFareCents));
  lines.push('   (Diese Spalte ist eine andere, ältere Größe des Exports und');
  lines.push('    geht in keine Bemessungsgrundlage ein — sonst würde eine');
  lines.push('    Stornierung zweimal zählen.)');
  lines.push('');
  lines.push('3. BEMESSUNGSGRUNDLAGE');
  lines.push('-'.repeat(72));
  row('Fahrpreise', euro(basis.parts.fareCents));
  row(`Trinkgelder einbezogen: ${basis.includesTips ? 'ja' : 'nein'}`, euro(basis.includesTips ? basis.parts.tipCents : 0));
  row(`Ablehnungsgebühren einbezogen: ${basis.includesDeclinedFees ? 'ja' : 'nein'}`,
      euro(basis.includesDeclinedFees ? basis.parts.declinedFeeCents + basis.parts.cancelledFeeCents : 0));
  row('Bemessungsgrundlage', euro(basis.basisCents));
  lines.push('');
  lines.push('4. MONATLICHER ANTEIL');
  lines.push('-'.repeat(72));
  if (!share) {
    lines.push('Nicht berechnet (im Mandanten abgeschaltet).');
  } else {
    row('Gewählter Satz', `${share.rate.ratePercent.toFixed(2).replace('.', ',')} %`);
    row('  Seed des Satzes', String(share.rate.seed));
    row('  Zufallsstrom des Satzes', String(share.rate.streamSeed));
    row('Bemessungsgrundlage x Satz', euro(share.result.amountCents));
    row('Verbleibend (bei Behandlung als Abzug)', euro(share.result.remainderCents));
    lines.push('');
    lines.push('   Der Satz ist ein Anteil an bereits vorhandenem Umsatz. Er ist');
    lines.push('   keine Steuer und keine Provision, er verändert keinen Fahrpreis,');
    lines.push('   und er wird nirgends gebucht.');
    const sum = share.result.amountCents + share.result.remainderCents;
    row('Kontrolle: Anteil + Rest', `${euro(sum)} (${sum === basis.basisCents ? 'stimmt' : 'WEICHT AB'})`);
  }
  lines.push('');
  lines.push('5. ABSTIMMUNG DER TEILSUMMEN');
  lines.push('-'.repeat(72));
  for (const check of reconcile(r)) {
    const difference = check.partsSum - check.total;
    row(check.label, `${check.partsSum} gegen ${check.total} -> ${difference === 0 ? 'OK' : `ABWEICHUNG ${difference}`}`);
  }
  lines.push('');
  lines.push('6. ZEITRAUM UND BETRIEBSFÄHIGKEIT');
  lines.push('-'.repeat(72));
  row('Kalendertage im Zeitraum', String(r.days.length));
  row('Tage ohne jede Fahrt', String(r.days.filter(d => d.zeroRideDay).length));
  row('Schichten insgesamt', String(r.month.shifts.length));
  row('Verworfene Schichtversuche', String(r.month.droppedShifts));
  row('Aufgezeichnete Ablehnungsgründe', String(r.refusals.length));
  // The figure that shows the note was actually reached. Without it, "no ride
  // during an unavailability" could be true because nothing ever tried.
  const blocked = r.refusals.filter(x => x.reason === 'driver_blocked_by_note');
  row('  davon durch eine Fahrernotiz gesperrt', String(blocked.length));
  row('  betroffene Fahrer', String(new Set(blocked.map(x => x.driverId)).size));
  row('  Tage ohne gültigen Betriebstagsbeginn (Zeitumstellung)',
      String(r.refusals.filter(x => x.reason === 'operating_day_has_no_start_instant').length));
  lines.push('');
  lines.push('7. PRÜFUNGEN');
  lines.push('-'.repeat(72));
  if (r.violations.length === 0) lines.push('Keine Regelverletzung im erzeugten Monat.');
  else for (const violation of r.violations) lines.push(`VERLETZUNG: ${violation}`);
  if (v.findings.length === 0) lines.push('Kein unlesbarer Betrag.');
  else for (const f of v.findings) lines.push(`BETRAG: ${f.shiftId} ${f.field}=${f.value} (${f.code})`);
  lines.push('');
  return lines.join('\n');
}

function constraintTable(rows: ConstraintDecision[]): string {
  const head = ['Subjekt', 'ID', 'Bezeichnung', 'Ereignis', 'Quelle', 'Sicherheit', 'Wirkung', 'Von', 'Bis', 'Zeit', 'Aus Eingangsdatum', 'Prüfung nötig', 'Begründung'];
  const body = rows.map(r => [
    r.subject, r.subjectId, r.subjectLabel, r.eventLabel, r.source, r.certainty, r.effect,
    r.windowStart ?? '', r.windowEnd ?? '',
    r.windowStartTime && r.windowEndTime ? `${r.windowStartTime}-${r.windowEndTime}` : 'ganztägig',
    r.windowFromNoticeDate ? 'ja' : 'nein', r.needsHumanReview ? 'ja' : 'nein', r.reason,
  ]);
  const s = summariseConstraintLog(rows);
  const summary = [
    '# Entscheidungsprotokoll der Einschränkungen (Audit Abschnitt 5)',
    '',
    SIMULATED_NOTICE,
    '',
    `Zeilen: ${s.rows} | harte Sperren: ${s.hardBlocks} | nur Prüfung: ${s.humanReview} | ohne Wirkung: ${s.none}`,
    `Fenster aus dem Eingangsdatum der Notiz abgeleitet: ${s.fromNoticeDate} | nicht zuordenbare ID: ${s.unresolvedIdentity}`,
    '',
    'Sicherheit "assumed_from_notice_date" heißt: die Notiz nennt keinen eigenen',
    'Zeitraum, deshalb stammt das Fenster aus `note_date`. Diese Spalte wird mit',
    '`now()` vorbelegt, ist also der Zeitpunkt der Erfassung und nicht der des',
    'Ereignisses. Die Sperre gilt unverändert weiter und wird gemeldet, nicht',
    'stillschweigend verschoben.',
    '',
  ];
  return [...summary, `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
    ...body.map(r => `| ${r.join(' | ')} |`), ''].join('\n');
}

const generated = generateFullMonth({
  year: YEAR, month: MONTH, base: BASE, pool: POOL, vehicles: VEHICLES, drivers: DRIVERS,
  driverNotesMap: NOTES, werkstattChecks: WERKSTATT, seed: SEED, settings: SETTINGS,
  shiftsPerVehicleDay: 2,
});
if (!generated.ok) {
  console.error('the month could not be generated:', generated.failure);
  process.exit(1);
}
const result = generated.result;

mkdirSync(OUT, { recursive: true });
const workbook = buildMonthWorkbook(result);
writeFileSync(path.join(OUT, workbook.fileName), workbook.bytes);
writeFileSync(path.join(OUT, 'Finanzbericht.txt'), financialReport(result), 'utf8');
writeFileSync(path.join(OUT, 'Einschraenkungen.md'), constraintTable(result.constraints), 'utf8');

// Independently of the workbook's own reconciliation, so the figure quoted in
// the report is not the report's own arithmetic read back.
const perDay = result.days.reduce((n, d) => n + d.fareCents, 0);
console.log(`wrote ${OUT}`);
console.log(`  ${workbook.fileName} (${workbook.bytes.length} bytes)`);
console.log(`  days ${result.days.length}, zero-ride ${result.days.filter(d => d.zeroRideDay).length}, shifts ${result.month.shifts.length}, rides ${result.month.rides.length}`);
console.log(`  blocked by a driver note ${result.refusals.filter(r => r.reason === 'driver_blocked_by_note').length}`);
console.log(`  completed ${result.revenue.counts.completed}, declined ${result.revenue.counts.declined}, cancelled ${result.revenue.counts.cancelled}`);
console.log(`  fares ${euro(result.revenue.fareCents)} (per-day sum ${euro(perDay)}, ${perDay === result.revenue.fareCents ? 'equal' : 'DIFFERS'})`);
console.log(`  basis ${euro(result.basis.basisCents)}, rate ${result.share?.rate.ratePercent ?? '-'} %, amount ${result.share ? euro(result.share.result.amountCents) : '-'}, remainder ${result.share ? euro(result.share.result.remainderCents) : '-'}`);
console.log(`  constraints ${result.constraints.length}, violations ${result.violations.length}, generator ${FULL_MONTH_GENERATOR_VERSION}`);
