import { isShareRateAllowed } from './monthlyRate';
import { checkDriverShifts, checkRealTrips, type FullMonthResult } from './fullMonth';
import { MAX_DAY_MINUTES } from './driverMonthPlan';
import { reconcile } from './monthTotals';
import { inExportScope } from './revenue';
import { checkTips } from './reconciliation';

/**
 * Whether a generated month may be called VALIDATED FOR EXPORT (external audit
 * round 6), kept apart from whether it was generated.
 *
 * A month is generated when the generator produced it and its own read-back
 * found no broken rule. That says nothing about the roads: a month built on
 * the straight-line estimate breaks no rule of its own and has had no route
 * checked at all. Round 6 asks that the two never be confused — "0 warnings"
 * on a month nobody routed is not "safe" — so the verdict is a separate answer
 * built from a list of checks, each of which says **passed**, **failed** or
 * **not verified**:
 *
 * - `VALIDATED_FOR_EXPORT` — every mandatory check passed.
 * - `NOT_VALIDATED` — at least one failed.
 * - `VERIFICATION_INCOMPLETE` — none failed, but at least one could not be
 *   checked: no routing service was asked, a pair had no route, a shift ran
 *   on an unconfirmed note a person still has to review, or a driver of the
 *   pool could not be planned because his Drivers page lacks a setting.
 */

export type ExportVerdict = 'VALIDATED_FOR_EXPORT' | 'VERIFICATION_INCOMPLETE' | 'NOT_VALIDATED';
export type CheckOutcome = 'passed' | 'failed' | 'not_verified';

export interface VerificationCheck {
  code:
    | 'rules'
    | 'shift_limits'
    | 'routing_measured'
    | 'route_pairs'
    | 'repositioning'
    | 'declined_not_exported'
    | 'reconciliation'
    | 'amounts_readable'
    | 'events_reviewed'
    | 'monthly_share'
    | 'drivers_planned'
    | 'base_configured'
    | 'rides_generated'
    | 'real_trips_kept'
    | 'tips_backed';
  /** German, for the screen and the workbook. */
  label: string;
  outcome: CheckOutcome;
  detail: string;
}

export interface MonthVerification {
  /** The generator produced the month and its read-back found no broken rule. */
  generated: boolean;
  verdict: ExportVerdict;
  /** `estimate` when the month was built without a routing service. */
  routing: 'measured' | 'estimate';
  checks: VerificationCheck[];
}

export const VERDICT_TEXT: Record<ExportVerdict, string> = {
  VALIDATED_FOR_EXPORT: 'VALIDATED FOR EXPORT - alle Pflichtpruefungen bestanden',
  VERIFICATION_INCOMPLETE: 'VERIFICATION INCOMPLETE - nicht alle Pflichtpruefungen durchfuehrbar',
  NOT_VALIDATED: 'NOT VALIDATED - mindestens eine Pflichtpruefung nicht bestanden',
};

const check = (code: VerificationCheck['code'], label: string, outcome: CheckOutcome, detail: string): VerificationCheck =>
  ({ code, label, outcome, detail });

function shiftLimits(result: FullMonthResult): VerificationCheck {
  // Round 8: no universal floor. Each shift is checked against its own driver's
  // plan — his day, his window, his range's maximum — and the 360-minute ceiling.
  const problems = checkDriverShifts(result.month.shifts, result.driverPlans, result.vehicleUnavailability,
    result.provenance.options.minDriverRestMinutes);
  return check('shift_limits', `Schichten im Fenster und Stundenrahmen des Fahrers, hoechstens ${MAX_DAY_MINUTES} Minuten`,
    problems.length === 0 ? 'passed' : 'failed',
    problems.length === 0 ? `${result.month.shifts.length} Schichten, alle im Rahmen ihres Fahrers` : `${problems.length} Abweichungen: ${problems.slice(0, 3).join('; ')}`);
}

function routePairs(result: FullMonthResult): VerificationCheck {
  const r = result.routeSummary;
  const label = 'Routenpruefung je Fahrtpaar (Fahrzeug und Fahrer)';
  if (r.byStatus.ROUTE_CONFLICT > 0) return check('route_pairs', label, 'failed', `${r.uniqueConflicts} Paare mit Konflikt`);
  if (r.byStatus.ESTIMATE_ONLY > 0) return check('route_pairs', label, 'not_verified', `${r.byStatus.ESTIMATE_ONLY} Pruefungen nur geschaetzt (ESTIMATE_ONLY)`);
  if (r.byStatus.UNVERIFIABLE > 0) return check('route_pairs', label, 'not_verified', `${r.uniqueUnverifiable} Paare ohne berechnete Route (UNVERIFIABLE)`);
  return check('route_pairs', label, 'passed', `${r.checks} Pruefungen, alle ROUTE_VERIFIED`);
}

function repositioning(result: FullMonthResult): VerificationCheck {
  const s = result.repositioningSummary;
  const label = 'Leerfahrten: Fahrzeit mit Reserve passt';
  if (s.byStatus.ROUTE_CONFLICT > 0) return check('repositioning', label, 'failed', `${s.byStatus.ROUTE_CONFLICT} Leerfahrten mit Konflikt`);
  if (s.byStatus.ESTIMATE_ONLY > 0) return check('repositioning', label, 'not_verified', `${s.byStatus.ESTIMATE_ONLY} Leerfahrten nur geschaetzt (ESTIMATE_ONLY)`);
  if (s.byStatus.UNVERIFIABLE > 0) return check('repositioning', label, 'not_verified', `${s.byStatus.UNVERIFIABLE} Leerfahrten ohne berechnete Route`);
  return check('repositioning', label, 'passed', `${s.legs} Leerfahrten, alle ROUTE_VERIFIED`);
}

function eventsReviewed(result: FullMonthResult): VerificationCheck {
  const review = result.decisions.filter(d => d.outcome === 'accepted_with_review').reduce((n, d) => n + d.count, 0);
  const notes = result.provenance.inputs.structuredNotes;
  return review === 0
    ? check('events_reviewed', 'Ereignisse vor der Erzeugung gelesen und angewendet', 'passed', `${notes} strukturierte Notizen gelesen, keine offene Pruefung`)
    : check('events_reviewed', 'Ereignisse vor der Erzeugung gelesen und angewendet', 'not_verified', `${review} Schichten auf unbestaetigter Notiz oder fehlendem TUEV - menschliche Pruefung noetig`);
}

function monthlyShare(result: FullMonthResult): VerificationCheck {
  const label = 'Monatsanteil 30, 31, 32 oder 33 % auf der Grundlage des Berichts';
  if (!result.provenance.settings.monthlyRevenueShareEnabled) return check('monthly_share', label, 'passed', 'abgeschaltet');
  if (!result.share) return check('monthly_share', label, 'failed', 'nicht berechenbar');
  const { rate, result: share } = result.share;
  const adds = share.amountCents + share.remainderCents === share.basisCents && share.basisCents === result.basis.basisCents;
  const ok = adds && isShareRateAllowed(rate.rateBasisPoints);
  return check('monthly_share', label, ok ? 'passed' : 'failed',
    `Satz ${rate.ratePercent} %, Betrag + Rest ${adds ? '=' : '≠'} Grundlage`);
}

/**
 * Whether the month covers the drivers it was asked for (Round 8). A driver
 * whose hours range or window is not configured is not planned, and a month
 * that silently leaves him out would pass every other check: it is
 * `not_verified` until the Drivers page says what he works. A month in which
 * nobody could be planned is `failed`, because an empty report with every
 * check passed is exactly the fabricated success §12 forbids.
 */
function driversPlanned(result: FullMonthResult): VerificationCheck {
  const label = 'Fahrer nach ihren Einstellungen auf der Fahrerseite geplant';
  const asked = result.driverPlans.filter(p => p.notPlannedReason !== 'inactive' && p.notPlannedReason !== 'planning_disabled');
  const unconfigured = asked.filter(p => p.notPlannedReason === 'configuration_required');
  const planned = asked.filter(p => p.planned);
  if (asked.length > 0 && planned.length === 0) {
    return check('drivers_planned', label, 'failed', `kein Fahrer planbar (${unconfigured.length} ohne Einstellungen - CONFIGURATION_REQUIRED)`);
  }
  if (unconfigured.length > 0) {
    return check('drivers_planned', label, 'not_verified',
      `${unconfigured.length} Fahrer ohne Stundenrahmen oder Zeitfenster (CONFIGURATION_REQUIRED): ${unconfigured.map(p => p.driverName).join(', ')}`);
  }
  return check('drivers_planned', label, 'passed', `${planned.length} Fahrer geplant`);
}

/**
 * A month with no completed ride claims nothing, and every other check passes
 * it vacuously: no pair to conflict, no leg to be late, no rule broken. Found
 * by round 8's negative scenarios (no route home, no route at all), where the
 * empty month read `VALIDATED_FOR_EXPORT`. It is `failed`, never a report.
 */
function ridesGenerated(result: FullMonthResult): VerificationCheck {
  const label = 'Mindestens eine abgeschlossene Fahrt erzeugt';
  const completed = result.month.rides.filter(r => r.status === 'completed').length;
  if (completed > 0) return check('rides_generated', label, 'passed', `${completed} abgeschlossene Fahrten`);
  const noRide = result.refusals.filter(r => r.reason === 'shift_produced_no_ride').length;
  return check('rides_generated', label, 'failed',
    `keine abgeschlossene Fahrt erzeugt${noRide > 0 ? ` (${noRide} Schichten ohne Fahrt: keine berechnete Route oder keine Zeit)` : ''}`);
}

/**
 * Every shift starts at the company's configured base (round 8, §3). The month
 * can only say so when the caller stated where the point came from: the saved
 * point, or the company's address geocoded at house level (D7, labelled). A
 * point of unstated origin is not called the company's base.
 */
function baseConfigured(result: FullMonthResult): VerificationCheck {
  const label = 'Schichten beginnen am konfigurierten Betriebssitz';
  const base = result.provenance.base;
  const home = result.provenance.returnToBase ? ', Rueckkehr zum Betriebssitz am Schichtende' : '';
  if (base.source === 'saved_point') return check('base_configured', label, 'passed', `gespeicherter Punkt${home}`);
  if (base.source === 'company_address') {
    return check('base_configured', label, 'passed', `${base.label}, auf Hausnummer genau geocodiert${home}`);
  }
  return check('base_configured', label, 'not_verified', 'Herkunft des Betriebssitzes nicht angegeben (CONFIGURATION_REQUIRED)');
}

/**
 * §4 and §12 classes 16 and 17: real trips are carried unchanged and their
 * driver-days are not simulated over. The month can only claim that when the
 * real trips were read, every one of them belongs to a named driver and every
 * amount in them was readable; otherwise it says what it could not see.
 */
function realTripsKept(result: FullMonthResult): VerificationCheck {
  const label = 'Echte Fahrten unveraendert, ihre Fahrertage nicht simuliert';
  const real = result.realTrips;
  if (!real) {
    return check('real_trips_kept', label, 'not_verified', 'echte Fahrten des Monats nicht gelesen - ob ein Fahrertag echt war, ist unbekannt');
  }
  const broken = checkRealTrips(result.month, real, result.provenance.options);
  if (broken.length > 0) return check('real_trips_kept', label, 'failed', `${broken.length} Verstoesse: ${broken.slice(0, 3).join('; ')}`);
  if (real.unattributed.length > 0) {
    const names = [...new Set(real.unattributed.map(t => t.driverName || '(ohne Namen)'))];
    return check('real_trips_kept', label, 'not_verified',
      `${real.unattributed.length} echte Fahrten keinem Fahrer eindeutig zuzuordnen (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}): ihr Fahrertag kann simuliert worden sein`);
  }
  if (real.unreadableAmounts.length > 0) {
    return check('real_trips_kept', label, 'not_verified',
      `${real.unreadableAmounts.length} unlesbare Betraege in echten Fahrten - nicht geschaetzt`);
  }
  if (real.trips.length === 0) return check('real_trips_kept', label, 'passed', 'keine echten Fahrten im Monat');
  const driverDays = [...real.days.values()].reduce((n, days) => n + days.size, 0);
  return check('real_trips_kept', label, 'passed',
    `${real.trips.length} echte Fahrten (IMPORTIERT) unveraendert, ${driverDays} Fahrertage nicht simuliert`);
}

/**
 * Every tip in the Fahrtenbuch is backed by an imported Trinkgeld total, on the
 * same driver and day (or week), and each allocated total is met to the cent.
 * Recomputed from the rides, so a tip written after generation is caught. What
 * stayed unallocated is the financial status's matter (D10), not the export's:
 * an imported tip the month could not carry invents nothing on a ride.
 */
function tipsBacked(result: FullMonthResult): VerificationCheck {
  const label = 'Trinkgeld nur aus Uber-Zahlen, centgenau';
  const broken = checkTips(result.month.rides, result.month.shifts, result.financial.tips);
  if (broken.length > 0) return check('tips_backed', label, 'failed', `${broken.length} Verstoesse: ${broken.slice(0, 3).join('; ')}`);
  const allocated = result.financial.tips.filter(a => a.outcome === 'allocated');
  if (!result.financial.uberRead) return check('tips_backed', label, 'passed', 'keine Uber-Zahlen gelesen - kein Trinkgeld eingetragen, nichts erfunden');
  return check('tips_backed', label, 'passed',
    `${allocated.length} Uber-Trinkgeldsummen centgenau verteilt (SIMULIERT); ${result.financial.tips.length - allocated.length} nicht verteilt, im Finanzabgleich ausgewiesen`);
}

export function verifyMonth(result: FullMonthResult): MonthVerification {
  const exportedDeclined = result.month.rides.filter(inExportScope).filter(r => r.status === 'declined').length;
  const differences = reconcile(result).filter(r => r.partsSum !== r.total);
  const measured = result.provenance.travel.measured;
  const checks: VerificationCheck[] = [
    check('rules', 'Regeln aus der Rueckpruefung', result.violations.length === 0 ? 'passed' : 'failed',
      result.violations.length === 0 ? 'keine Verstoesse' : `${result.violations.length} Verstoesse`),
    shiftLimits(result),
    check('routing_measured', 'Fahrzeiten aus einem Routingdienst', measured ? 'passed' : 'not_verified',
      measured ? result.provenance.travel.source : 'ohne Routenberechnung erzeugt - nur Schaetzung (ESTIMATE_ONLY), fuer schnelle Versuche'),
    routePairs(result),
    repositioning(result),
    check('declined_not_exported', 'Keine abgelehnten Auftraege im Fahrtenbuch-Bericht', exportedDeclined === 0 ? 'passed' : 'failed',
      `${exportedDeclined} abgelehnte Zeilen im Bericht; ${result.internal.declined.counts.declined} intern im Betriebsbericht`),
    check('reconciliation', 'Summen je Tag, Fahrer und Fahrzeug gleich der Monatssumme', differences.length === 0 ? 'passed' : 'failed',
      differences.length === 0 ? 'alle Abgleiche ohne Differenz' : differences.map(d => d.label).join('; ')),
    check('amounts_readable', 'Alle Betraege lesbar', result.revenue.findings.length === 0 ? 'passed' : 'failed',
      `${result.revenue.findings.length} unlesbare Betraege`),
    eventsReviewed(result),
    monthlyShare(result),
    driversPlanned(result),
    baseConfigured(result),
    ridesGenerated(result),
    realTripsKept(result),
    tipsBacked(result),
  ];
  const verdict: ExportVerdict = checks.some(c => c.outcome === 'failed')
    ? 'NOT_VALIDATED'
    : checks.some(c => c.outcome === 'not_verified') ? 'VERIFICATION_INCOMPLETE' : 'VALIDATED_FOR_EXPORT';
  return { generated: result.violations.length === 0, verdict, routing: measured ? 'measured' : 'estimate', checks };
}
