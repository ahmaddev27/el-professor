/**
 * The findings the engine reports, one builder per kind. Each names its
 * evidence (trip and shift ids), the values it used, and how sure it is. None
 * of them proposes a change: a finding is for review, and the record stays as
 * it happened.
 */
import { keyOf, lowestConfidence, type ClassifiedTrip, type RowQualityType } from './classify';
import { compareIds, overlapLength } from './intervals';
import { budgetProblemsText, hoursText, intervalText, minutesText, msAsMinutesText } from './text';
import type { AnalysisShift, BudgetComparison, BudgetResult, Confidence, Issue, IssueType } from './types';

const MINUTE_MS = 60_000;

/** Order of `issues` in a result: by kind as listed here, then by id. */
export const ISSUE_TYPE_ORDER: readonly IssueType[] = [
  'driver_overlap',
  'vehicle_overlap',
  'travel_gap',
  'activity_outside_shift',
  'shift_without_activity',
  'shift_overlap',
  'shift_invalid',
  'no_shift_records',
  'missing_driver',
  'missing_vehicle',
  'missing_start',
  'missing_end',
  'end_before_start',
  'status_unknown',
  'ambiguous_local_time',
  'driver_name_mismatch',
  'activity_over_budget',
  'shifts_over_budget',
  'budget_not_computable',
  'cap_below_hours_min',
];

function sortedPair(a: string, b: string): [string, string] {
  return compareIds(a, b) <= 0 ? [a, b] : [b, a];
}

function tripInterval(t: ClassifiedTrip): string {
  return intervalText(t.start, t.end);
}

function driverLabel(t: ClassifiedTrip): string {
  return keyOf(t.trip.driver_name) ?? t.driverKey ?? 'unbekannt';
}

// ── Overlaps ──────────────────────────────────────────────────────────────────

function overlapValues(a: ClassifiedTrip, b: ClassifiedTrip) {
  const overlapStartMs = Math.max(a.start, b.start);
  const overlapEndMs = Math.min(a.end, b.end);
  return {
    overlapMinutes: overlapLength({ start: a.start, end: a.end }, { start: b.start, end: b.end }) / MINUTE_MS,
    overlapStartMs,
    overlapEndMs,
    tripA: a.trip.id,
    tripB: b.trip.id,
  };
}

/** One driver in two trips at once. `a` starts first (sweep order). */
export function driverOverlapIssue(a: ClassifiedTrip, b: ClassifiedTrip): Issue {
  const values = overlapValues(a, b);
  const identicalInterval = a.start === b.start && a.end === b.end;
  const [first, second] = sortedPair(a.trip.id, b.trip.id);
  return {
    id: `driver_overlap:${first}+${second}`,
    type: 'driver_overlap',
    severity: 'error',
    status: 'conflict',
    driverId: a.driverKey ?? undefined,
    tripIds: [first, second],
    values: { ...values, vehicleA: a.vehicleKey, vehicleB: b.vehicleKey, identicalInterval },
    explanation:
      `${driverLabel(a)} ist gleichzeitig in zwei Fahrten: ${tripInterval(a)} und ${tripInterval(b)} ` +
      `überschneiden sich um ${minutesText(values.overlapMinutes)} Min.` +
      (identicalInterval ? ' Identische Zeiten – mögliches Duplikat.' : ''),
    confidence: lowestConfidence(a.confidence, b.confidence),
  };
}

/** One vehicle driven by two different drivers at once. */
export function vehicleOverlapIssue(a: ClassifiedTrip, b: ClassifiedTrip): Issue {
  const values = overlapValues(a, b);
  const [first, second] = sortedPair(a.trip.id, b.trip.id);
  return {
    id: `vehicle_overlap:${first}+${second}`,
    type: 'vehicle_overlap',
    severity: 'error',
    status: 'conflict',
    vehicle: a.vehicleKey ?? undefined,
    tripIds: [first, second],
    values: { ...values, driverA: a.driverKey, driverB: b.driverKey },
    explanation:
      `Fahrzeug ${a.vehicleKey} ist gleichzeitig zwei Fahrern zugeordnet (${driverLabel(a)}, ${driverLabel(b)}): ` +
      `${tripInterval(a)} und ${tripInterval(b)} überschneiden sich um ${minutesText(values.overlapMinutes)} Min.`,
    confidence: lowestConfidence(a.confidence, b.confidence),
  };
}

// ── Row quality ───────────────────────────────────────────────────────────────

const ROW_QUALITY_TEXT: Readonly<Record<RowQualityType, string>> = {
  missing_driver: 'Fahrt ohne Fahrer-Zuordnung – bleibt erhalten und geht in die Prüfung.',
  missing_vehicle: 'Fahrt ohne Fahrzeug – Überschneidungen am Fahrzeug nicht prüfbar.',
  missing_start: 'Fahrt ohne Beginn – nicht in Zeitkennzahlen, Überschneidung nicht prüfbar.',
  missing_end: 'Fahrt ohne Ende – es wird kein Ende angenommen; Überschneidung und Wechsel nicht prüfbar.',
  end_before_start: 'Ende liegt vor dem Beginn.',
  status_unknown: 'Fahrtstatus unbekannt – Beitrag zu den Kennzahlen offen, bleibt zur Prüfung.',
  ambiguous_local_time: 'Ortszeit fällt in die Zeitumstellung und ist ohne Zeitzonenangabe nicht eindeutig.',
};

export function rowQualityIssue(c: ClassifiedTrip, type: RowQualityType): Issue {
  const isDataError = type === 'end_before_start';
  const values: Record<string, string | number | null> = { sourceRow: c.trip.source_row };
  if (type === 'end_before_start') {
    values.startMs = c.trip.start_ms;
    values.endMs = c.trip.end_ms;
  }
  if (type === 'ambiguous_local_time') values.ambiguity = c.trip.time_ambiguity ?? null;
  return {
    id: `${type}:${c.trip.id}`,
    type,
    severity: isDataError ? 'error' : type === 'missing_vehicle' ? 'info' : 'warning',
    status: isDataError ? 'conflict' : 'unverifiable',
    driverId: c.driverKey ?? undefined,
    vehicle: c.vehicleKey ?? undefined,
    tripIds: [c.trip.id],
    values,
    explanation: ROW_QUALITY_TEXT[type],
    confidence: 'high',
  };
}

/**
 * One driver id under several names. The evidence is the rows whose name
 * differs from the most frequent spelling (ties: the first in id order).
 */
export function driverNameMismatchIssue(driverId: string, rows: readonly ClassifiedTrip[]): Issue | null {
  const byName = new Map<string, { spelling: string; ids: string[] }>();
  for (const row of rows) {
    const spelling = keyOf(row.trip.driver_name);
    if (spelling === null) continue;
    const key = spelling.toLowerCase();
    const entry = byName.get(key);
    if (entry) entry.ids.push(row.trip.id);
    else byName.set(key, { spelling, ids: [row.trip.id] });
  }
  if (byName.size < 2) return null;
  const entries = [...byName.entries()].sort(([ka, a], [kb, b]) => b.ids.length - a.ids.length || compareIds(ka, kb));
  const [, majority] = entries[0];
  const evidence = entries.slice(1).flatMap(([, e]) => e.ids).sort(compareIds);
  const spellings = entries.map(([, e]) => e.spelling).sort(compareIds);
  return {
    id: `driver_name_mismatch:${driverId}`,
    type: 'driver_name_mismatch',
    severity: 'warning',
    status: 'conflict',
    driverId,
    tripIds: evidence,
    values: { names: spellings.join(' | '), majorityName: majority.spelling },
    explanation: `Eine Fahrer-ID mit mehreren Namen: ${spellings.join(', ')}.`,
    confidence: 'high',
  };
}

// ── Shifts ────────────────────────────────────────────────────────────────────

export function shiftIsValid(shift: AnalysisShift): boolean {
  return (
    typeof shift.driver_id === 'string' &&
    shift.driver_id.trim() !== '' &&
    Number.isFinite(shift.start_ms) &&
    Number.isFinite(shift.end_ms) &&
    shift.end_ms > shift.start_ms
  );
}

export function shiftInvalidIssue(shift: AnalysisShift): Issue {
  const missingDriver = typeof shift.driver_id !== 'string' || shift.driver_id.trim() === '';
  return {
    id: `shift_invalid:${shift.id}`,
    type: 'shift_invalid',
    severity: 'warning',
    status: 'conflict',
    driverId: missingDriver ? undefined : shift.driver_id,
    tripIds: [],
    shiftIds: [shift.id],
    values: {
      startMs: Number.isFinite(shift.start_ms) ? shift.start_ms : null,
      endMs: Number.isFinite(shift.end_ms) ? shift.end_ms : null,
      reason: missingDriver ? 'missing_driver' : 'invalid_interval',
      source: shift.source,
    },
    explanation: missingDriver
      ? 'Arbeitszeit-Eintrag ohne Fahrer – keinem Fahrer zuzuordnen.'
      : 'Arbeitszeit-Eintrag ohne gültigen Zeitraum (Ende nicht nach Beginn).',
    confidence: 'high',
  };
}

export function shiftOverlapIssue(a: AnalysisShift, b: AnalysisShift): Issue {
  const overlapStartMs = Math.max(a.start_ms, b.start_ms);
  const overlapEndMs = Math.min(a.end_ms, b.end_ms);
  const overlapMinutes = (overlapEndMs - overlapStartMs) / MINUTE_MS;
  const [first, second] = sortedPair(a.id, b.id);
  return {
    id: `shift_overlap:${first}+${second}`,
    type: 'shift_overlap',
    severity: 'warning',
    status: 'conflict',
    driverId: a.driver_id,
    tripIds: [],
    shiftIds: [first, second],
    values: { overlapMinutes, overlapStartMs, overlapEndMs },
    explanation: `Zwei Arbeitszeit-Einträge überschneiden sich um ${minutesText(overlapMinutes)} Min. (${intervalText(overlapStartMs, overlapEndMs)}).`,
    confidence: 'high',
  };
}

export function outsideShiftIssue(c: ClassifiedTrip, outsideMs: number): Issue {
  return {
    id: `activity_outside_shift:${c.trip.id}`,
    type: 'activity_outside_shift',
    severity: 'warning',
    status: 'conflict',
    driverId: c.driverKey ?? undefined,
    vehicle: c.vehicleKey ?? undefined,
    tripIds: [c.trip.id],
    values: { outsideMinutes: outsideMs / MINUTE_MS, tripMinutes: (c.end - c.start) / MINUTE_MS },
    explanation: `${msAsMinutesText(outsideMs)} Min. der Fahrt ${tripInterval(c)} liegen außerhalb der erfassten Arbeitszeit.`,
    confidence: c.confidence,
  };
}

/**
 * A shift no analysed trip touches. Only 'unverifiable' when the driver has
 * rows the analysis could not measure — one of them may have been the activity.
 */
export function shiftWithoutActivityIssue(shift: AnalysisShift, openRows: number): Issue {
  const shiftMinutes = (shift.end_ms - shift.start_ms) / MINUTE_MS;
  return {
    id: `shift_without_activity:${shift.id}`,
    type: 'shift_without_activity',
    severity: 'info',
    status: openRows > 0 ? 'unverifiable' : 'conflict',
    driverId: shift.driver_id,
    tripIds: [],
    shiftIds: [shift.id],
    values: { shiftMinutes, startMs: shift.start_ms, endMs: shift.end_ms, source: shift.source, openRows },
    explanation:
      `Erfasste Arbeitszeit ${intervalText(shift.start_ms, shift.end_ms)} ohne Fahrt.` +
      (openRows > 0 ? ` Nicht abschließend: ${openRows} Fahrten des Fahrers sind nicht auswertbar.` : ''),
    confidence: 'high',
  };
}

export function noShiftRecordsIssue(driverId: string, tripCount: number): Issue {
  return {
    id: `no_shift_records:${driverId}`,
    type: 'no_shift_records',
    severity: 'info',
    status: 'unverifiable',
    driverId,
    tripIds: [],
    values: { tripCount },
    explanation: 'Keine Arbeitszeit erfasst – Fahrten außerhalb der Arbeitszeit sind nicht prüfbar.',
    confidence: 'high',
  };
}

// ── Budget ────────────────────────────────────────────────────────────────────

export function budgetIssues(
  driverId: string,
  budget: BudgetResult,
  comparison: BudgetComparison | null,
  confidence: Confidence,
): Issue[] {
  const issues: Issue[] = [];
  if (budget.status !== 'ok') {
    issues.push({
      id: `budget_not_computable:${driverId}`,
      type: 'budget_not_computable',
      severity: budget.rangeStatus === 'ok' ? 'info' : 'warning',
      status: 'unverifiable',
      driverId,
      tripIds: [],
      values: { problems: budget.problems.join(','), rangeComputable: budget.rangeStatus === 'ok' },
      explanation: `Budget nicht vollständig berechenbar: ${budgetProblemsText(budget.problems)}. Die Auswertung der Fahrten läuft trotzdem.`,
      confidence: 'high',
    });
  }
  if (budget.capBelowHoursMin && budget.capHours !== null && budget.hoursMin !== null) {
    issues.push({
      id: `cap_below_hours_min:${driverId}`,
      type: 'cap_below_hours_min',
      severity: 'info',
      status: 'conflict',
      driverId,
      tripIds: [],
      values: { capHours: budget.capHours, hoursMin: budget.hoursMin },
      explanation:
        `Nach Abzug der Reserve liegt die Planungsgrenze (${hoursText(budget.capHours)} Std.) unter dem Mindestrahmen ` +
        `(${hoursText(budget.hoursMin)} Std.) – der Mindestrahmen hängt dann von weiterer geplanter Tätigkeit ab.`,
      confidence: 'high',
    });
  }
  if (!comparison) return issues;

  const overText = (label: string, minutes: number) =>
    `${label} ${hoursText(minutes / 60)} Std. liegt ${hoursText((minutes - comparison.maxMinutes) / 60)} Std. über dem ` +
    `Höchstrahmen von ${hoursText(comparison.maxMinutes / 60)} Std. – Hinweis zur Prüfung; keine Fahrt wird verschoben, gekürzt oder umverteilt.`;

  if (comparison.activityVsMaxMinutes > 0) {
    issues.push({
      id: `activity_over_budget:${driverId}`,
      type: 'activity_over_budget',
      severity: 'warning',
      status: 'conflict',
      driverId,
      tripIds: [],
      values: {
        activityMinutes: comparison.activityMinutes,
        maxMinutes: comparison.maxMinutes,
        overByMinutes: comparison.activityVsMaxMinutes,
      },
      explanation: overText('Fahrzeit ohne Doppelzählung', comparison.activityMinutes),
      confidence,
    });
  }
  if (comparison.shiftMinutes !== null && comparison.shiftVsMaxMinutes !== null && comparison.shiftVsMaxMinutes > 0) {
    issues.push({
      id: `shifts_over_budget:${driverId}`,
      type: 'shifts_over_budget',
      severity: 'warning',
      status: 'conflict',
      driverId,
      tripIds: [],
      values: {
        shiftMinutes: comparison.shiftMinutes,
        maxMinutes: comparison.maxMinutes,
        overByMinutes: comparison.shiftVsMaxMinutes,
      },
      explanation: overText('Erfasste Arbeitszeit', comparison.shiftMinutes),
      confidence: 'high',
    });
  }
  return issues;
}
