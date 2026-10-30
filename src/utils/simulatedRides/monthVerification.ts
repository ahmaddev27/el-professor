import { MONTHLY_SHARE_MAX_BP, MONTHLY_SHARE_MIN_BP } from './monthlyRate';
import type { FullMonthResult } from './fullMonth';
import { SHIFT_LIMITS } from './generator';
import { reconcile } from './monthTotals';
import { inExportScope } from './revenue';

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
 *   checked: no routing service was asked, a pair had no route, or a shift ran
 *   on an unconfirmed note a person still has to review.
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
    | 'monthly_share';
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
  const outside = result.month.shifts.filter(s => {
    const minutes = (s.endMs - s.startMs) / 60_000;
    return minutes < SHIFT_LIMITS.minMinutes || minutes > SHIFT_LIMITS.maxMinutes;
  });
  return check('shift_limits', `Schichtdauer ${SHIFT_LIMITS.minMinutes}-${SHIFT_LIMITS.maxMinutes} Minuten`,
    outside.length === 0 ? 'passed' : 'failed',
    outside.length === 0 ? `${result.month.shifts.length} Schichten, alle im Rahmen` : `${outside.length} Schichten ausserhalb: ${outside.slice(0, 5).map(s => s.id).join(', ')}`);
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
  const label = 'Monatsanteil 30-33 % auf der Grundlage des Berichts';
  if (!result.provenance.settings.monthlyRevenueShareEnabled) return check('monthly_share', label, 'passed', 'abgeschaltet');
  if (!result.share) return check('monthly_share', label, 'failed', 'nicht berechenbar');
  const { rate, result: share } = result.share;
  const adds = share.amountCents + share.remainderCents === share.basisCents && share.basisCents === result.basis.basisCents;
  const ok = adds && rate.rateBasisPoints >= MONTHLY_SHARE_MIN_BP && rate.rateBasisPoints <= MONTHLY_SHARE_MAX_BP;
  return check('monthly_share', label, ok ? 'passed' : 'failed',
    `Satz ${rate.ratePercent} %, Betrag + Rest ${adds ? '=' : '≠'} Grundlage`);
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
  ];
  const verdict: ExportVerdict = checks.some(c => c.outcome === 'failed')
    ? 'NOT_VALIDATED'
    : checks.some(c => c.outcome === 'not_verified') ? 'VERIFICATION_INCOMPLETE' : 'VALIDATED_FOR_EXPORT';
  return { generated: result.violations.length === 0, verdict, routing: measured ? 'measured' : 'estimate', checks };
}
