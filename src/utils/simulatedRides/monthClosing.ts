import { CONTRACT_VERSION, type WorkbookPayload } from '../../lib/workbookContract';
import { CALENDAR_MAX_WAIT_SECONDS, type FullMonthResult, type SettingsSource } from './fullMonth';
import { REPORT_LABEL_VALUES, SIMULATED_LABEL_HEADER, SIMULATED_LABEL_VALUE, SIMULATED_NOTICE, SIMULATED_SHEET_NAME } from './marker';
import {
  BASE_SOURCE_TEXT,
  REASON_TEXT,
  STATUS_WORD,
  TOTAL_LABEL,
  WEEKDAYS,
  contractProblem,
  dayOfRide,
  financialLines,
  financialStatus,
  payloadCost,
  reportFileName,
  reportRides,
  routingLines,
  settingLines,
  toPayloadCell,
  yesNo,
  type Cell,
  type MonthReport,
  type Row,
} from './monthWorkbook';
import { VERDICT_TEXT, verifyMonth, type MonthVerification } from './monthVerification';
import type { RealTrip } from './realTrips';
import { SHARE_MEANING_TEXT, type DriverDayNote, type DriverDayReconciliation, type PeriodNote, type PeriodReconciliation, type TipOutcome } from './reconciliation';
import type { RepositioningLeg, RepositioningPurpose } from './repositioningLegs';
import { cancellationFeeOf } from './revenue';
import type { ShareSetting } from './monthlyRate';
import { formatStamp } from './time';
import type { SimRide, SimShift } from './types';

/**
 * The month's closing workbook (FleetBook round 8, section 10):
 * `SIMULIERT_Monatsabschluss_<YYYY-MM>_<seed>_<verdict>.xlsx`, a third file
 * beside the Monatsbericht and the operational report, which stay as they are.
 *
 * Seven sheets in the auditor's order, German like every generated document,
 * and the `SIMULIERT` notice sheet last. Sheet 7 names the auditor's sheet for
 * each of them.
 *
 * ## Every row says where it comes from
 *
 * Column 1 of every row is `Kennzeichnung`, and unlike the Monatsbericht its
 * value is the row's own:
 *  - `IMPORTIERT`: a record read from the company's tables, printed unchanged
 *    (the month's real trips; an Uber figure);
 *  - `SIMULIERT`: made by the generator (a ride, a shift, an empty drive);
 *  - `ABGELEITET`: computed here from the other two (a share, a commission, a
 *    day's total). Its column headers say which part of it is which.
 *
 * The file stays a simulated document whatever its rows are: its name starts
 * with `SIMULIERT_`, it carries the notice sheet, and the real import refuses
 * a sheet whose `Kennzeichnung` column holds any of the three words
 * (`findSimulationMarker`), so a month with only real trips cannot be taken
 * back in through this file either.
 *
 * ## What it never does
 *
 * It changes no real trip, books nothing and calls no figure a salary. The
 * share is the company's share (D1, owner 27.11.2026), computed and shown; the
 * commission is the product's rule applied to imported Uber figures, labelled
 * as a calculation; a gross wage is not computed because no pay model is set
 * (D4); booked salaries are not read (the simulator is no reader of the
 * Gehälter module's tables), and simulated shifts are no worked hours.
 */

export const CLOSING_SHEET_RIDES = 'Fahrtenbuch';
export const CLOSING_SHEET_SHIFTS = 'Fahrerschichten';
export const CLOSING_SHEET_PAY = 'Lohn und Arbeitszeit';
export const CLOSING_SHEET_UBER = 'Uber Tagesabgleich';
export const CLOSING_SHEET_VEHICLES = 'Fahrzeuge und Leerfahrten';
export const CLOSING_SHEET_CALENDAR = 'Kalendermonat';
export const CLOSING_SHEET_CHECKS = 'Pruefung und Herkunft';

/** The seven data sheets in the auditor's order, then the notice. */
export const CLOSING_SHEET_ORDER: readonly string[] = [
  CLOSING_SHEET_RIDES, CLOSING_SHEET_SHIFTS, CLOSING_SHEET_PAY, CLOSING_SHEET_UBER,
  CLOSING_SHEET_VEHICLES, CLOSING_SHEET_CALENDAR, CLOSING_SHEET_CHECKS, SIMULATED_SHEET_NAME,
];

/** The auditor's name for each sheet (spec section 10), printed in sheet 7. */
export const AUDITOR_SHEET_NAME: Readonly<Record<string, string>> = {
  [CLOSING_SHEET_RIDES]: 'Sheet 1 - Fahrtenbuch',
  [CLOSING_SHEET_SHIFTS]: 'Sheet 2 - Driver Shifts',
  [CLOSING_SHEET_PAY]: 'Sheet 3 - Driver Salary & Working Hours',
  [CLOSING_SHEET_UBER]: 'Sheet 4 - Uber Daily Reconciliation',
  [CLOSING_SHEET_VEHICLES]: 'Sheet 5 - Vehicles & Repositioning',
  [CLOSING_SHEET_CALENDAR]: 'Sheet 6 - Calendar Month Summary',
  [CLOSING_SHEET_CHECKS]: 'Sheet 7 - Validation & Provenance',
};

export const LABEL_HEADER = SIMULATED_LABEL_HEADER;
export const LABEL = { imported: 'IMPORTIERT', simulated: SIMULATED_LABEL_VALUE, derived: 'ABGELEITET' } as const;
export type RowLabel = (typeof LABEL)[keyof typeof LABEL];

const euro = (cents: number): number => cents / 100;
const euroOrEmpty = (cents: number | null): Cell => (cents === null ? '' : cents / 100);
/** Kilometres are summed in hundredths: adding two-decimal floats drifts. */
const hundredths = (km: number): number => Math.round(km * 100);
const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;
const stamp = (ms: number | null): string => (ms === null ? '' : formatStamp(ms, false));

// ── Shared indexes ─────────────────────────────────────────────────────────

/** A real trip that is no ride of the book: a declined order (spec section 10, sheet 1). */
export const isRealDeclined = (t: RealTrip): boolean => t.status === 'declined';

const realTrips = (result: FullMonthResult): RealTrip[] => result.realTrips?.trips ?? [];
const bookRealTrips = (result: FullMonthResult): RealTrip[] => realTrips(result).filter(t => !isRealDeclined(t));
const realCompleted = (t: RealTrip): boolean => !t.canceled && t.status !== 'cancelled' && !isRealDeclined(t);

function legsByShift(result: FullMonthResult): Map<string, RepositioningLeg[]> {
  const out = new Map<string, RepositioningLeg[]>();
  for (const leg of result.repositioning) {
    const list = out.get(leg.shiftId);
    if (list) list.push(leg); else out.set(leg.shiftId, [leg]);
  }
  return out;
}

function ridesByShift(result: FullMonthResult): Map<string, SimRide[]> {
  const out = new Map<string, SimRide[]>();
  for (const ride of reportRides(result)) {
    const list = out.get(ride.shiftId);
    if (list) list.push(ride); else out.set(ride.shiftId, [ride]);
  }
  return out;
}

/** The end the driver is on duty until: the planned end, or later when the return to base ran over it. */
const dutyEndMs = (shift: SimShift): number => Math.max(shift.endMs, shift.plannedEndMs ?? shift.endMs);
const dutyMinutes = (shift: SimShift): number => Math.round((dutyEndMs(shift) - shift.startMs) / 60_000);

const sumHundredths = (values: number[]): number => values.reduce((n, v) => n + v, 0);
const legKmHundredths = (legs: readonly RepositioningLeg[]): number | null =>
  legs.some(l => l.roadKm === null) ? null : sumHundredths(legs.map(l => hundredths(l.roadKm as number)));

// ── Sheet 1: Fahrtenbuch ───────────────────────────────────────────────────

export const CLOSING_RIDE_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Quelle', 'Fahrt-ID', 'Import-ID', 'Quellzeilen-Schluessel', 'Datum der Fahrt', 'Betriebstag',
  'Status', 'Fahrer', 'Fahrer-ID', 'Fahrerzuordnung', 'Kennzeichen', 'Schicht', 'Fahrtbeginn', 'Fahrtende',
  'Fahrpreis (EUR)', 'Trinkgeld (EUR)', 'Stornogebuehr (EUR)', 'Finanzstatus', 'Kilometer', 'Abholort', 'Zielort',
];

const IDENTITY_WORD: Record<RealTrip['identity'], string> = {
  driver_id: 'gespeicherte Fahrer-ID',
  name_only: 'nur Name (keine gespeicherte Fahrer-ID)',
  ambiguous: 'nicht eindeutig (mehrere Fahrer dieses Namens)',
  unresolved: 'kein Fahrer dieses Namens',
};

function realStatusWord(t: RealTrip): string {
  if (t.canceled || t.status === 'cancelled') return STATUS_WORD.cancelled;
  if (t.status === 'completed') return STATUS_WORD.completed;
  return t.status === 'unknown' ? 'unbekannt' : t.status;
}

const amountCell = (cents: number | null): Cell => (cents === null ? 'unlesbar' : cents / 100);

function realRideRow(t: RealTrip): Row {
  return [
    LABEL.imported, 'Import (fahrtenbuch_trips)', t.tripId, t.importId, t.sourceRowKey ?? '', t.tripDate, t.operatingDay,
    realStatusWord(t), t.driverName, t.driverId ?? '', IDENTITY_WORD[t.identity], t.plate ?? '', '',
    t.startMs !== null ? stamp(t.startMs) : (t.startTime ?? ''), t.endMs !== null ? stamp(t.endMs) : (t.endTime ?? ''),
    amountCell(t.fareCents), amountCell(t.tipCents), '', 'wie importiert, unveraendert', '',
    t.pickup ?? '', t.destination ?? '',
  ];
}

function simulatedRideRow(ride: SimRide, result: FullMonthResult): Row {
  const s = result.provenance.settings;
  const done = ride.status === 'completed';
  const day = dayOfRide(ride, s);
  return [
    LABEL.simulated, 'Fahrtengenerator', ride.tripId ?? '', '', '', day, day, STATUS_WORD[ride.status],
    ride.driver.name, ride.driver.id ?? '', 'simuliert', ride.vehicle.plate, ride.shiftId,
    stamp(ride.startMs), stamp(ride.endMs), done ? ride.fare : 0, done ? ride.tip : 0,
    euro(cancellationFeeOf(ride, s) ?? 0), financialStatus(ride, s), done ? ride.km : 0,
    ride.pickup.label, ride.dropoff.label,
  ];
}

/**
 * The real trips unchanged and the simulated rides, by operating day and start.
 * No declined order of either kind, and no empty drive: those are not rides of
 * the book.
 */
export function closingRidesSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const keyed: { day: string; at: number; id: string; row: Row }[] = [
    ...bookRealTrips(result).map(t => ({ day: t.operatingDay, at: t.startMs ?? Infinity, id: t.tripId, row: realRideRow(t) })),
    ...reportRides(result).map(r => ({
      day: dayOfRide(r, s), at: r.startMs ?? r.orderTransmittedMs, id: r.tripId ?? '', row: simulatedRideRow(r, result),
    })),
  ];
  keyed.sort((a, b) => a.day.localeCompare(b.day) || a.at - b.at || a.id.localeCompare(b.id));
  return [[...CLOSING_RIDE_HEADERS], ...keyed.map(k => k.row)];
}

// ── Sheet 2: Fahrerschichten ───────────────────────────────────────────────

export const SHIFT_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Fahrer-ID', 'Fahrer', 'Schicht-ID', 'Betriebstag', 'Schichtbeginn', 'Schichtende', 'Geplantes Ende',
  'Startbasis', 'Fahrzeug', 'Fahrten abgeschlossen', 'Fahrten storniert', 'Leerfahrzeit (Min)', 'Leerkilometer',
  'Dienststunden (simuliert)', 'Pausen', 'Abweichung', 'Status',
];

/** §4 ArbZG: more than six hours of work need a break, which this planner does not place. */
export const BREAK_FREE_MINUTES = 360;

function shiftRow(shift: SimShift, rides: readonly SimRide[], legs: readonly RepositioningLeg[], baseLabel: string): Row {
  const duty = dutyMinutes(shift);
  const planned = shift.plannedEndMs ?? shift.endMs;
  const overrun = Math.round((shift.endMs - planned) / 60_000);
  const routed = legs.every(l => l.roadSeconds !== null);
  const emptyMinutes = routed ? Math.round(legs.reduce((n, l) => n + (l.roadSeconds as number), 0) / 6) / 10 : 'nicht geroutet';
  const emptyKm = legKmHundredths(legs);
  const deviation = overrun > 0 ? `Ende ${overrun} Min nach dem geplanten Ende` : '';
  const needsBreak = duty > BREAK_FREE_MINUTES;
  return [
    LABEL.simulated, shift.driver.id ?? '', shift.driver.name, shift.id, shift.operatingDay, stamp(shift.startMs),
    stamp(shift.endMs), stamp(planned), baseLabel, shift.vehicle.plate,
    rides.filter(r => r.status === 'completed').length, rides.filter(r => r.status === 'cancelled').length,
    emptyMinutes, emptyKm === null ? 'nicht geroutet' : emptyKm / 100, hours(duty),
    needsBreak ? 'Pause erforderlich, nicht geplant (§ 4 ArbZG)' : 'keine Pause erforderlich (bis 6 Std., § 4 ArbZG)',
    deviation,
    needsBreak || deviation !== '' || !routed ? 'zu pruefen' : 'SIMULIERT - kein Arbeitszeitnachweis',
  ];
}

export function shiftsSheetRows(result: FullMonthResult): Row[] {
  const legs = legsByShift(result);
  const rides = ridesByShift(result);
  const base = result.provenance.base.label;
  const shifts = [...result.month.shifts].sort((a, b) =>
    a.driver.name.localeCompare(b.driver.name) || (a.driver.id ?? '').localeCompare(b.driver.id ?? '') || a.startMs - b.startMs);
  return [[...SHIFT_HEADERS], ...shifts.map(sh => shiftRow(sh, rides.get(sh.id) ?? [], legs.get(sh.id) ?? [], base))];
}

// ── Uber figures per driver (sheets 3, 4 and 6) ────────────────────────────

/** `salary_ratio` in basis points, so the commission is integer arithmetic. */
const ratioBasisPoints = (ratio: number | null): number | null =>
  ratio === null || !Number.isFinite(ratio) || ratio < 0 ? null : Math.round(ratio * 10_000);

/**
 * The product's rule for one Uber row: `(Umsatz + Aktionen) × salary_ratio +
 * Trinkgeld`, in cents, rounded once per row. A calculation, never a salary.
 */
export function commissionCents(row: { umsatzCents: number; aktionenCents: number; tipsImportedCents: number }, ratioBp: number | null): number | null {
  if (ratioBp === null) return null;
  return Math.round(((row.umsatzCents + row.aktionenCents) * ratioBp) / 10_000) + row.tipsImportedCents;
}

function ratiosByDriver(result: FullMonthResult): Map<string, number | null> {
  return new Map(result.driverPlans.map(p => [p.driverId, ratioBasisPoints(p.printed.salaryRatio)]));
}

/** The Uber rows that count in the month: every day row and the weeks inside it. */
function monthUberRows(result: FullMonthResult): (DriverDayReconciliation | PeriodReconciliation)[] {
  return [...result.financial.days, ...result.financial.periods.filter(p => p.placement === 'inside_month')];
}

// ── Sheet 3: Lohn und Arbeitszeit ──────────────────────────────────────────

/**
 * The hours range is salary divided by the hourly rate, with no premium for
 * night, Sunday or holiday work (D1 point 2). A premium would lower the hours a
 * salary buys, but its rate is the driver's contract's and no contract rate is
 * stored anywhere, so none is assumed. The sheet says so, not only this code.
 */
export const HOURS_RULE_SHORT = 'Gehalt / Stundenlohn, ohne Zuschlaege';
export const NO_PREMIUM = 'nicht beruecksichtigt: keine Zuschlagssaetze (Nacht, Sonntag, Feiertag) aus den Arbeitsvertraegen hinterlegt; kein Satz wird angenommen, die Stunden sind Gehalt / Stundenlohn';

export const PAY_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Fahrer-ID', 'Fahrer', 'Beschaeftigung', 'Provisionssatz (Konfiguration)', 'Stundenlohn (EUR, Konfiguration)',
  'Gehaltsrahmen min (EUR, Konfiguration)', 'Gehaltsrahmen max (EUR, Konfiguration)', `Stundenrahmen min (${HOURS_RULE_SHORT})`, `Stundenrahmen max (${HOURS_RULE_SHORT})`, 'Geplante Stunden', 'Platzierte Stunden (simuliert)',
  'Tatsaechliche Stunden', 'Umsatz importiert (EUR)', 'Aktionen importiert (EUR)', 'Trinkgeld importiert (EUR)',
  'Provision nach Regel (EUR, berechnet, nicht gebucht)', 'Stunden x Stundenlohn (EUR, simuliert)',
  'Differenz Provision - Stunden x Lohn (EUR, berechnet, nicht gebucht)', 'Gebuchtes Gehalt', 'Bruttolohn', 'Offene Punkte',
];

export const NOT_READ_SALARIES = 'nicht gelesen: der Simulator liest die Tabellen des Moduls Gehaelter nicht';
export const NO_ACTUAL_HOURS = 'nicht verfuegbar: simulierte Schichten sind keine gearbeiteten Stunden';
export const NO_GROSS_WAGE = 'nicht berechnet: kein Lohnmodell festgelegt (D4)';


const POSITION_WORD: Record<string, string> = {
  below: 'unter dem Stundenrahmen', above_cap: 'ueber dem Stundenrahmen', no_range: 'kein Stundenrahmen',
  no_hours: 'keine Stunden', in_range: '', owner: '',
};

export function paySheetRows(result: FullMonthResult): Row[] {
  const outcomes = new Map(result.driverOutcomes.map(o => [o.driverId, o]));
  const uberRows = monthUberRows(result);
  const body = [...result.driverPlans]
    .sort((a, b) => a.driverName.localeCompare(b.driverName) || a.driverId.localeCompare(b.driverId))
    .map((plan): Row => {
      const outcome = outcomes.get(plan.driverId);
      const mine = uberRows.filter(r => r.driverId === plan.driverId);
      const umsatz = mine.reduce((n, r) => n + r.umsatzCents, 0);
      const aktionen = mine.reduce((n, r) => n + r.aktionenCents, 0);
      const tips = mine.reduce((n, r) => n + r.tipsImportedCents, 0);
      const ratioBp = ratioBasisPoints(plan.printed.salaryRatio);
      const commission = result.financial.uberRead && ratioBp !== null
        ? mine.reduce((n, r) => n + (commissionCents(r, ratioBp) as number), 0) : null;
      const placedMinutes = outcome?.placedMinutes ?? 0;
      const rate = plan.printed.hourlyRate;
      const byHours = rate !== null && Number.isFinite(rate) ? Math.round((placedMinutes / 60) * rate * 100) : null;
      const open: string[] = [];
      if (!result.financial.uberRead) open.push('Uber-Zahlen nicht gelesen');
      if (ratioBp === null) open.push('kein Provisionssatz');
      if (rate === null) open.push('kein Stundenlohn');
      for (const problem of plan.range.problems) open.push(`Stundenrahmen: ${problem}`);
      const position = outcome ? POSITION_WORD[outcome.assessment.position] ?? outcome.assessment.position : '';
      if (position) open.push(position);
      if (outcome && outcome.missedDays.length > 0) open.push(`${outcome.missedDays.length} geplante Tage ohne Schicht`);
      if (commission !== null && byHours !== null && commission !== byHours) open.push('Provision und Stunden x Lohn weichen ab (nicht aufgeloest, D4)');
      return [
        LABEL.derived, plan.driverId, plan.driverName, plan.isOwner ? 'Inhaber' : (plan.employmentType ?? ''),
        plan.printed.salaryRatio ?? '', rate ?? '', plan.printed.minSalary ?? '', plan.printed.maxSalary ?? '',
        plan.range.minHours ?? '', plan.range.effectiveMaxHours ?? '', hours(plan.plannedMinutes), hours(placedMinutes),
        NO_ACTUAL_HOURS, result.financial.uberRead ? euro(umsatz) : 'nicht gelesen',
        result.financial.uberRead ? euro(aktionen) : 'nicht gelesen', result.financial.uberRead ? euro(tips) : 'nicht gelesen',
        euroOrEmpty(commission), euroOrEmpty(byHours),
        commission !== null && byHours !== null ? euro(commission - byHours) : '',
        NOT_READ_SALARIES, NO_GROSS_WAGE, open.join('; '),
      ];
    });
  return [[...PAY_HEADERS], ...body];
}

// ── Sheet 4: Uber Tagesabgleich ────────────────────────────────────────────

/** The share's column on sheets 4 and 6: it names what the share is (D1). */
export const SHARE_HEADER = 'Unternehmensanteil (EUR, berechnet, nicht gebucht)';

/**
 * The gap between what Uber paid out as turnover and what the book's fares add
 * up to, per driver and operating day (D1, owner 27.11.2026). It is shown and
 * never closed: no fare is fitted to Uber's daily figure (spec §4, §5).
 */
export const FARE_GAP_HEADER = 'Differenz Umsatz - Fahrpreise (EUR, angezeigt, nicht ausgeglichen)';

export const UBER_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Zeilenart', 'Datum', 'Bis', 'Fahrer-ID', 'Fahrer', 'Umsatz (EUR, importiert)', 'Aktionen (EUR, importiert)',
  'Bargeld (EUR, importiert)', 'Basis (EUR)', 'Satz (%)', SHARE_HEADER,
  'Trinkgeld importiert (EUR)', 'Trinkgeld verteilt (EUR, simuliert)', 'Differenz Trinkgeld (EUR, Verteilung)', 'Simulierte Fahrten',
  'Simulierte Fahrpreise (EUR, nicht tatsaechlich)', 'Echte Fahrpreise (EUR, importiert)', FARE_GAP_HEADER,
  'Formelergebnis (EUR, Unternehmensanteil = Umsatz x Satz)', 'Hinweise', 'Status',
];

const NOTE_TEXT: Record<DriverDayNote, string> = {
  negative_figure: 'negativer Uber-Wert',
  also_in_period: 'auch in einem Wochenwert enthalten',
  no_uber_row: 'kein Uber-Wert fuer diesen Fahrertag',
  share_not_computable: 'Anteil nicht berechenbar',
};

const TIP_OUTCOME_TEXT: Record<TipOutcome, string> = {
  allocated: 'verteilt',
  no_simulated_ride: 'keine simulierte Fahrt im Zeitraum',
  negative: 'negativer Trinkgeldwert',
  conflict: 'Tageswert und Wochenwert zugleich',
  not_attributable: 'Woche ueber die Monatsgrenze',
};

const rateCell = (bp: number | null): Cell => (bp === null ? '' : bp / 100);

export const UBER_NOT_READ = 'nicht gelesen';
export const NO_UBER_ROW = 'kein Uber-Wert';

/** The fares of the driver's real trips that day, when there are any. */
function realFaresByDriverDay(result: FullMonthResult): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const t of bookRealTrips(result)) {
    if (t.driverId === null || !realCompleted(t)) continue;
    const key = `${t.driverId}|${t.operatingDay}`;
    const before = out.has(key) ? out.get(key) as number | null : 0;
    out.set(key, before === null || t.fareCents === null ? null : before + t.fareCents);
  }
  return out;
}

export const FARE_UNREADABLE = 'unlesbar';

/**
 * Umsatz minus simulated and real fares for one driver-day, in cents, or the
 * word for why there is none: Uber not read, no Uber row, or a real fare that
 * could not be read. A day with no real trip counts its real fares as 0.
 */
function dayFareGap(result: FullMonthResult, d: DriverDayReconciliation, real: number | null | undefined): number | string {
  if (!result.financial.uberRead) return UBER_NOT_READ;
  if (d.notes.includes('no_uber_row')) return NO_UBER_ROW;
  if (real === null) return FARE_UNREADABLE;
  return d.umsatzCents - d.simulatedFareCents - (real ?? 0);
}

/** Every day's gap, in the order of `financial.days`. */
function fareGaps(result: FullMonthResult): (number | string)[] {
  const realFares = realFaresByDriverDay(result);
  return result.financial.days.map(d => dayFareGap(result, d, realFares.get(`${d.driverId}|${d.day}`)));
}

/** The outcome of each day-scoped Uber tip, by driver and day. */
function dayTipOutcomes(result: FullMonthResult): Map<string, TipOutcome> {
  return new Map(result.financial.tips.filter(t => t.scope === 'day').map(t => [`${t.driverId}|${t.from}`, t.outcome]));
}

/**
 * D10 per row: a cent the allocation cannot account for fails; a figure that
 * is missing, or a tip that was not allocated, is incomplete; a row with no
 * share rate needs configuring; the rest is reconciled.
 */
function dayStatus(d: DriverDayReconciliation, tip: TipOutcome | undefined): string {
  if (d.tipDifferenceCents !== 0) return 'FAILED';
  if (d.notes.length > 0 || (tip !== undefined && tip !== 'allocated')) return 'INCOMPLETE';
  return d.shareCents === null ? 'CONFIGURATION_REQUIRED' : 'RECONCILED';
}

const PERIOD_NOTE_TEXT: Record<PeriodNote, string> = {
  negative_figure: 'negativer Uber-Wert',
  also_in_days: 'Tage der Woche auch als Tageswert importiert',
  share_not_computable: 'Anteil nicht berechenbar (Satz je Tag)',
};

/** The same rule for a weekly row; a week across the month boundary is not in the month at all. */
function periodStatus(p: PeriodReconciliation, tip: TipOutcome | undefined): string {
  if (p.placement !== 'inside_month' || p.notes.length > 0 || (tip !== undefined && tip !== 'allocated')) return 'INCOMPLETE';
  return p.shareCents === null ? 'CONFIGURATION_REQUIRED' : 'RECONCILED';
}

export function uberSheetRows(result: FullMonthResult): Row[] {
  const realFares = realFaresByDriverDay(result);
  const tips = dayTipOutcomes(result);
  const gaps = fareGaps(result);
  const days = result.financial.days.map((d, i): Row => {
    const real = realFares.get(`${d.driverId}|${d.day}`);
    const gap = gaps[i];
    const tip = tips.get(`${d.driverId}|${d.day}`);
    const notes = [...d.notes.map(n => NOTE_TEXT[n] ?? n), ...(tip && tip !== 'allocated' ? [`Trinkgeld: ${TIP_OUTCOME_TEXT[tip] ?? tip}`] : [])];
    // A figure Uber never gave is not a zero: not read at all, or no row for this driver-day.
    const imported = (c: number): Cell => (!result.financial.uberRead ? UBER_NOT_READ
      : d.notes.includes('no_uber_row') ? NO_UBER_ROW : euro(c));
    return [
      LABEL.derived, 'Tag', d.day, d.day, d.driverId, d.driverName, imported(d.umsatzCents), imported(d.aktionenCents),
      imported(d.bargeldCents), imported(d.basisCents), rateCell(d.rateBasisPoints), euroOrEmpty(d.shareCents),
      imported(d.tipsImportedCents), euro(d.tipsAllocatedCents), imported(d.tipDifferenceCents), d.simulatedCompleted,
      euro(d.simulatedFareCents), real === undefined ? '' : (real === null ? FARE_UNREADABLE : euro(real)),
      typeof gap === 'number' ? euro(gap) : gap, euroOrEmpty(d.formulaTotalCents), notes.join('; '), dayStatus(d, tip),
    ];
  });
  const periodTips = new Map(result.financial.tips.filter(t => t.scope === 'period').map(t => [`${t.driverId}|${t.from}|${t.to}`, t.outcome]));
  const periods = result.financial.periods.map((p): Row => {
    const tip = periodTips.get(`${p.driverId}|${p.periodStart}|${p.periodEnd}`);
    const notes = ['Wochenwert: nicht auf Tage aufgeteilt', ...p.notes.map(n => PERIOD_NOTE_TEXT[n] ?? n),
      ...(tip && tip !== 'allocated' ? [`Trinkgeld: ${TIP_OUTCOME_TEXT[tip] ?? tip}`] : [])];
    return [
      LABEL.derived, p.placement === 'inside_month' ? 'Woche im Monat' : 'Woche ueber die Monatsgrenze (nicht im Monat gezaehlt)',
      p.periodStart, p.periodEnd, p.driverId, p.driverName, euro(p.umsatzCents), euro(p.aktionenCents), '', euro(p.umsatzCents),
      rateCell(p.rateBasisPoints), euroOrEmpty(p.shareCents), euro(p.tipsImportedCents), euro(p.tipsAllocatedCents),
      euro(p.tipsImportedCents - p.tipsAllocatedCents), '', '', '', '', euroOrEmpty(p.shareCents),
      notes.join('; '), periodStatus(p, tip),
    ];
  });
  const unallocated = result.financial.tips.filter(t => t.outcome !== 'allocated').map((t): Row => [
    LABEL.derived, 'Trinkgeld nicht verteilt', t.from, t.to, t.driverId, t.driverName, '', '', '', '', '', '',
    euro(t.importedCents), euro(t.allocatedCents), euro(t.importedCents - t.allocatedCents), t.completedRides, '', '', '', '',
    TIP_OUTCOME_TEXT[t.outcome] ?? t.outcome, 'INCOMPLETE',
  ]);
  return [[...UBER_HEADERS], ...days, ...periods, ...unallocated];
}

// ── Sheet 5: Fahrzeuge und Leerfahrten ─────────────────────────────────────

export const VEHICLE_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Zeilenart', 'Fahrzeug', 'Fahrzeug-ID', 'Fahrer', 'Fahrer-ID', 'Fahrerzuordnung', 'Schicht-ID', 'Betriebstag',
  'Fahrgast-km', 'Leer-km', 'Abfahrt Betriebssitz', 'Leerfahrt-ID', 'Zweck', 'Start', 'Start Breite', 'Start Laenge',
  'Ziel', 'Ziel Breite', 'Ziel Laenge', 'Abfahrt', 'Ankunft', 'Fahrzeit (s)', 'Verfuegbar (s)', 'Reserve (s)',
  'Anbieter', 'Status',
];

export const PURPOSE_WORD: Record<RepositioningPurpose, string> = {
  from_base: 'Abfahrt vom Betriebssitz',
  to_waiting_position: 'zum Warteplatz',
  to_pickup: 'zur Abholung',
  to_base: 'Rueckkehr zum Betriebssitz',
};

function legRow(leg: RepositioningLeg, shift: SimShift): Row {
  return [
    LABEL.simulated, 'Leerfahrt', leg.plate, leg.vehicleId ?? '', leg.driverName, leg.driverId ?? '', 'simuliert', leg.shiftId,
    shift.operatingDay, '', leg.roadKm ?? 'nicht geroutet', '', leg.legId, PURPOSE_WORD[leg.purpose] ?? leg.purpose,
    leg.from.label, leg.from.lat, leg.from.lon, leg.to.label, leg.to.lat, leg.to.lon, stamp(leg.departMs),
    stamp(leg.arriveMs), leg.roadSeconds ?? '', leg.availableSeconds, leg.slackSeconds ?? '', leg.routingSource,
    leg.verificationStatus,
  ];
}

/** Per shift a summary row (passenger and empty km, the departure from the base), then its empty drives. */
export function vehiclesSheetRows(result: FullMonthResult): Row[] {
  const legs = legsByShift(result);
  const rides = ridesByShift(result);
  const shifts = [...result.month.shifts].sort((a, b) => a.vehicle.plate.localeCompare(b.vehicle.plate) || a.startMs - b.startMs);
  const body: Row[] = [];
  for (const shift of shifts) {
    const mine = legs.get(shift.id) ?? [];
    const passenger = sumHundredths((rides.get(shift.id) ?? []).filter(r => r.status === 'completed').map(r => hundredths(r.km)));
    const empty = legKmHundredths(mine);
    const out = mine.find(l => l.purpose === 'from_base');
    const unverified = mine.filter(l => l.roadSeconds === null).length;
    body.push([
      LABEL.simulated, 'Schicht', shift.vehicle.plate, shift.vehicle.id ?? '', shift.driver.name, shift.driver.id ?? '',
      'simuliert', shift.id, shift.operatingDay, passenger / 100, empty === null ? 'nicht geroutet' : empty / 100,
      out ? stamp(out.departMs) : 'keine Abfahrt vom Betriebssitz erfasst', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      unverified > 0 ? `${unverified} Leerfahrten ohne Route` : (out ? 'vollstaendig' : 'zu pruefen'),
    ]);
    for (const leg of mine) body.push(legRow(leg, shift));
  }
  return [[...VEHICLE_HEADERS], ...body];
}

// ── Sheet 6: Kalendermonat ─────────────────────────────────────────────────

export const CALENDAR_HEADERS: readonly string[] = [
  LABEL_HEADER, 'Datum', 'Wochentag', 'Fahrpreise simuliert (EUR)', 'Fahrpreise echt (EUR, importiert)',
  'Trinkgeld simuliert (EUR)', 'Trinkgeld importiert (EUR)', 'Stornierungen simuliert', 'Stornogebuehren (EUR)',
  'Umsatz importiert (EUR)', 'Lohnberechnung nach Regel (EUR, nicht gebucht)', SHARE_HEADER,
  'Fahrgast-km', 'Leer-km', 'Dienststunden (simuliert)', 'Schichten', 'Echte Fahrten', 'Tag ohne Aktivitaet',
];

export const WEEKS_ROW_LABEL = 'Wochenwerte im Monat (nicht tagesgenau)';

interface CalendarFigures {
  simFare: number; realFare: number; realFareUnreadable: boolean; simTip: number; importedTip: number;
  cancelled: number; fee: number; umsatz: number; commission: number; commissionUnknown: boolean;
  share: number; passengerKm: number; emptyKm: number; emptyUnrouted: boolean; dutyMinutes: number;
  shifts: number; realTrips: number;
}

const emptyFigures = (): CalendarFigures => ({
  simFare: 0, realFare: 0, realFareUnreadable: false, simTip: 0, importedTip: 0, cancelled: 0, fee: 0, umsatz: 0,
  commission: 0, commissionUnknown: false, share: 0, passengerKm: 0, emptyKm: 0, emptyUnrouted: false,
  dutyMinutes: 0, shifts: 0, realTrips: 0,
});

function addUber(f: CalendarFigures, r: DriverDayReconciliation | PeriodReconciliation, ratioBp: number | null): void {
  f.umsatz += r.umsatzCents;
  f.importedTip += r.tipsImportedCents;
  f.share += r.shareCents ?? 0;
  const c = commissionCents(r, ratioBp);
  if (c === null) f.commissionUnknown = true; else f.commission += c;
}

function calendarRow(first: Cell, second: Cell, f: CalendarFigures, active: boolean | null, uberRead: boolean): Row {
  const uber = (cell: Cell): Cell => (uberRead ? cell : UBER_NOT_READ);
  return [
    LABEL.derived, first, second, euro(f.simFare), f.realFareUnreadable ? 'unlesbar' : euro(f.realFare), euro(f.simTip),
    uber(euro(f.importedTip)), f.cancelled, euro(f.fee), uber(euro(f.umsatz)),
    uber(f.commissionUnknown ? `${euro(f.commission)} (ohne Fahrer ohne Provisionssatz)` : euro(f.commission)), uber(euro(f.share)),
    f.passengerKm / 100, f.emptyUnrouted ? 'nicht geroutet' : f.emptyKm / 100, hours(f.dutyMinutes), f.shifts,
    f.realTrips, active === null ? '' : yesNo(!active),
  ];
}

/**
 * Every calendar day of the month, days without activity included, then the
 * weekly Uber values that cannot be put on a day, then the total. The total is
 * the sum of the rows above it, so every column reconciles with its sheet.
 */
export function calendarSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const read = result.financial.uberRead;
  const byDay = new Map(result.days.map(d => [d.day, emptyFigures()]));
  const at = (day: string): CalendarFigures | undefined => byDay.get(day);
  for (const ride of reportRides(result)) {
    const f = at(dayOfRide(ride, s));
    if (!f) continue;
    if (ride.status === 'completed') {
      f.simFare += Math.round(ride.fare * 100);
      f.simTip += Math.round(ride.tip * 100);
      f.passengerKm += hundredths(ride.km);
    } else if (ride.status === 'cancelled') {
      f.cancelled += 1;
      f.fee += cancellationFeeOf(ride, s) ?? 0;
    }
  }
  const legs = legsByShift(result);
  for (const shift of result.month.shifts) {
    const f = at(shift.operatingDay);
    if (!f) continue;
    f.shifts += 1;
    f.dutyMinutes += dutyMinutes(shift);
    const km = legKmHundredths(legs.get(shift.id) ?? []);
    if (km === null) f.emptyUnrouted = true; else f.emptyKm += km;
  }
  for (const t of bookRealTrips(result)) {
    const f = at(t.operatingDay);
    if (!f) continue;
    f.realTrips += 1;
    if (!realCompleted(t)) continue;
    if (t.fareCents === null) f.realFareUnreadable = true; else f.realFare += t.fareCents;
  }
  const ratios = ratiosByDriver(result);
  for (const d of result.financial.days) {
    const f = at(d.day);
    if (f) addUber(f, d, ratios.get(d.driverId) ?? null);
  }
  const weeks = emptyFigures();
  for (const p of result.financial.periods) {
    if (p.placement === 'inside_month') addUber(weeks, p, ratios.get(p.driverId) ?? null);
  }

  const total = emptyFigures();
  const all = [...byDay.values(), weeks];
  for (const f of all) {
    for (const key of Object.keys(total) as (keyof CalendarFigures)[]) {
      if (typeof total[key] === 'boolean') (total[key] as boolean) = (total[key] as boolean) || (f[key] as boolean);
      else (total[key] as number) += f[key] as number;
    }
  }
  const body = result.days.map(d => {
    const f = byDay.get(d.day) as CalendarFigures;
    const active = f.shifts > 0 || f.realTrips > 0 || f.umsatz !== 0;
    return calendarRow(d.day, WEEKDAYS[d.isoWeekday - 1] ?? '', f, active, read);
  });
  return [[...CALENDAR_HEADERS], ...body, calendarRow(WEEKS_ROW_LABEL, '', weeks, null, read), calendarRow(TOTAL_LABEL, '', total, null, read)];
}

// ── Sheet 7: Pruefung und Herkunft ─────────────────────────────────────────

export const CHECK_HEADERS: readonly string[] = [LABEL_HEADER, 'Bereich', 'Angabe', 'Wert'];

export function shareSettingText(setting: ShareSetting | null): string {
  if (setting === null) return 'nicht festgelegt (Kein Anteilssatz festgelegt)';
  if (setting.mode === 'fixed') return `fest ${setting.percent} %`;
  if (setting.mode === 'random') {
    return `zufaellig 30 bis 33 %, ${setting.scope === 'day' ? 'je Tag' : 'je Monat'}, Seed ${setting.seed}`;
  }
  return `ungueltig (${String((setting as { mode?: unknown }).mode)})`;
}

/**
 * Where the rate and the return to the base were read. A month built on a rate
 * typed into the script says so, so it never reads as the company's setting.
 */
export function settingsSourceText(source: SettingsSource): string {
  return source === 'script_arguments'
    ? 'Skriptargumente (--share-percent, --return-to-base): Firmeneinstellung auf diesem Stand nicht vorhanden'
    : 'Firmeneinstellung (company_simulation_settings)';
}

const section = (name: string, rows: Row[], label: RowLabel = LABEL.derived): Row[] =>
  rows.map(([what, value]) => [label, name, what ?? '', value ?? '']);

function distinct(values: readonly string[]): string {
  const set = [...new Set(values.filter(v => v !== ''))].sort();
  return set.length === 0 ? 'keine' : set.join(', ');
}

export const FARE_GAP_TOTAL_LABEL = 'Differenz Umsatz - Fahrpreise (EUR, Summe der Tage mit Uber-Wert)';

/** The month's gap: the sum of the days that have one, and how many days have none. */
function fareGapTotalText(result: FullMonthResult): string {
  if (!result.financial.uberRead) return UBER_NOT_READ;
  const gaps = fareGaps(result);
  const counted = gaps.filter((g): g is number => typeof g === 'number');
  const total = `${euro(counted.reduce((n, g) => n + g, 0))} EUR ueber ${counted.length} Fahrertage`;
  const unreadable = gaps.filter(g => g === FARE_UNREADABLE).length;
  const noRow = gaps.filter(g => g === NO_UBER_ROW).length;
  const left = [...(noRow > 0 ? [`${noRow} ohne Uber-Wert`] : []), ...(unreadable > 0 ? [`${unreadable} mit unlesbarem Fahrpreis`] : [])];
  return left.length === 0 ? total : `${total}; nicht enthalten: ${left.join(', ')}`;
}

export function checksSheetRows(result: FullMonthResult, verification: MonthVerification): Row[] {
  const p = result.provenance;
  const f = result.financial;
  const read = result.realTrips;
  const real = realTrips(result);
  const declined = real.filter(isRealDeclined).length;
  const mm = String(p.month).padStart(2, '0');
  const tipsOpen = f.tips.filter(t => t.outcome !== 'allocated');
  const outsideRange = result.driverOutcomes.filter(o => o.assessment.position === 'below' || o.assessment.position === 'above_cap');
  return [
    [...CHECK_HEADERS],
    [LABEL.simulated, 'Datei', 'Kennzeichnung', SIMULATED_NOTICE],
    ...section('Datei', [
      ['Inhalt', 'Monatsabschluss: echte Fahrten (IMPORTIERT, unveraendert), simulierte Fahrten, Schichten und Leerfahrten (SIMULIERT), Berechnungen (ABGELEITET)'],
      ...CLOSING_SHEET_ORDER.filter(n => n !== SIMULATED_SHEET_NAME).map((n, i): Row => [`Blatt ${i + 1}: ${n}`, AUDITOR_SHEET_NAME[n]]),
      [`Blatt 8: ${SIMULATED_SHEET_NAME}`, 'Hinweis, dass die Datei simulierte Daten enthaelt'],
    ]),
    ...section('Herkunft', [
      ['Lauf-ID', p.runId],
      ['Berichtsmonat', `${p.year}-${mm}`],
      ['Firma (Mandant)', p.tenantId ?? ''],
      ['Zeitzone', p.settings.timeZone],
      ['Betriebstag beginnt um (Stunde)', p.settings.operatingDayStartHour],
      ['Generatorversion', p.generatorVersion],
      ['Seed', p.seed],
      ['Import-IDs der echten Fahrten', read ? distinct(real.map(t => t.importId)) : 'nicht gelesen'],
      ['Pruefsumme echte Fahrten', p.realTrips?.digest ?? 'nicht gelesen'],
      ['Pruefsumme Uber-Zahlen', p.financial.uberDigest ?? 'nicht gelesen'],
      ['Uber-Zeilen gelesen (Tage / Wochen)', `${p.inputs.uberDays} / ${p.inputs.uberPeriods}`],
      ['Betriebssitz', p.base.label],
      ['Betriebssitz Herkunft', BASE_SOURCE_TEXT[p.base.source ?? 'none']],
      ['Betriebssitz Breite', p.base.lat],
      ['Betriebssitz Laenge', p.base.lon],
      ['Rueckkehr zum Betriebssitz am Schichtende', yesNo(p.returnToBase)],
    ]),
    ...section('Klassifikation', [
      [`${CLOSING_SHEET_RIDES}: IMPORTIERT`, 'echte Fahrten aus fahrtenbuch_trips, unveraendert'],
      [`${CLOSING_SHEET_RIDES}: SIMULIERT`, 'vom Fahrtengenerator erzeugte Fahrten und Stornierungen'],
      [CLOSING_SHEET_SHIFTS, 'SIMULIERT: Schichten des Generators, keine gearbeiteten Stunden'],
      [CLOSING_SHEET_PAY, 'ABGELEITET: Konfiguration der Fahrer, importierte Uber-Werte, simulierte Stunden; Spaltenkoepfe nennen die Quelle'],
      [CLOSING_SHEET_UBER, 'ABGELEITET: Umsatz, Aktionen, Bargeld, Trinkgeld importiert; Anteil berechnet; Fahrpreise simuliert'],
      [CLOSING_SHEET_VEHICLES, 'SIMULIERT: Leerfahrten des Generators, keine Fahrgastfahrten'],
      [CLOSING_SHEET_CALENDAR, 'ABGELEITET: Summen der anderen Blaetter je Kalendertag'],
    ]),
    ...section('Regeln', [
      ['Betriebstag', `${p.settings.operatingDayStartHour}:00 bis ${p.settings.operatingDayStartHour}:00 (${p.settings.timeZone})`],
      ['Anteil', 'Umsatz (importiert) x Satz, je Fahrer und Betriebstag; berechnet und angezeigt, nicht gebucht'],
      ['Anteil: Bedeutung', `${SHARE_MEANING_TEXT[f.share.meaning]} (D1, Entscheidung des Inhabers vom 27.11.2026); ein Prozentsatz des Umsatzes, kein Faktor auf die Fahrpreise`],
      ['Differenz Umsatz - Fahrpreise', 'Umsatz (importiert) minus simulierte und echte Fahrpreise, je Fahrer und Betriebstag; angezeigt, nicht ausgeglichen: kein Fahrpreis wird an den Uber-Wert angepasst (D1, 27.11.2026)'],
      ['Stundenrahmen', `Mindest- und Hoechstgehalt / Stundenlohn (D5), ohne Zuschlaege: ${NO_PREMIUM}`],
      ['Lohnberechnung nach Regel', '(Umsatz + Aktionen) x Provisionssatz + Trinkgeld, je Uber-Zeile auf Cent gerundet; keine Gehaltsbuchung'],
      ['Trinkgeld', 'nur aus Uber-Zahlen, centgenau auf simulierte Fahrten verteilt; nie erzeugt'],
      ['Stornogebuehr', 'nur wenn die Firma sie eingestellt hat'],
      ['Abgelehnte Auftraege', 'nie im Fahrtenbuch'],
      ['Leerfahrten', 'nie im Fahrtenbuch; eigenes Blatt'],
      ['Wartezeit auf den naechsten Auftrag', `hoechstens ${CALENDAR_MAX_WAIT_SECONDS / 60} Minuten nach einer Fahrt (Entscheidung des Inhabers vom 27.11.2026)`],
    ]),
    ...section('Satz', [
      ['Einstellung', shareSettingText(f.share.setting)],
      ['Einstellung Problem', f.share.settingProblem ?? ''],
      ['Einstellung aus', settingsSourceText(p.financial.settingsSource)],
    ]),
    ...section('Pruefung', [
      ['Exportstatus', `${verification.verdict} - ${VERDICT_TEXT[verification.verdict]}`],
      ['Routing', verification.routing === 'measured' ? 'gemessen' : 'nur Schaetzung'],
      ...verification.checks.map((c): Row => [c.label, `${c.outcome}: ${c.detail}`]),
      ...financialLines(result),
    ]),
    ...section('Offene Differenzen', [
      ['Regelverletzungen beim Zuruecklesen', result.violations.length === 0 ? 'keine' : result.violations.join('; ')],
      ['Finanzabgleich: Befunde', f.violations.length === 0 ? 'keine' : f.violations.join('; ')],
      ['Trinkgeldwerte nicht verteilt', `${tipsOpen.length} (${euro(tipsOpen.reduce((n, t) => n + t.importedCents, 0))} EUR)`],
      [FARE_GAP_TOTAL_LABEL, fareGapTotalText(result)],
      ['Fahrer ausserhalb ihres Stundenrahmens', outsideRange.length === 0 ? 'keine' : outsideRange.map(o => o.driverName).join(', ')],
      ['Abgelehnte Fahrertage', result.refusals.length === 0 ? 'keine'
        : distinct(result.refusals.map(r => REASON_TEXT[r.reason] ?? r.reason))],
    ]),
    ...section('Nicht verfuegbar', [
      ['Gebuchte Gehaelter', NOT_READ_SALARIES],
      ['Tatsaechliche Arbeitsstunden', NO_ACTUAL_HOURS],
      ['Bruttolohn', NO_GROSS_WAGE],
      ['Zuschlaege in den Stunden', NO_PREMIUM],
      ['Kilometer echter Fahrten', 'nicht gespeichert'],
      ['Abgelehnte echte Auftraege (nicht im Fahrtenbuch)', read ? declined : 'nicht gelesen'],
      ['Echte Fahrten ohne eindeutigen Fahrer', read ? read.unattributed.length : 'nicht gelesen'],
      ['Echte Fahrten mit unlesbarem Betrag', read ? read.unreadableAmounts.length : 'nicht gelesen'],
    ]),
    ...section('Einstellungen', [
      ...settingLines('Einstellung ', p.settings),
      ...settingLines('Option ', p.options),
      ...settingLines('Eingabe ', p.inputs),
      ...routingLines(result),
    ]),
  ];
}

// ── Assembly ───────────────────────────────────────────────────────────────

// The guard's own list, so a label this file writes is always one the import refuses.
const LABEL_WORDS: readonly string[] = REPORT_LABEL_VALUES;

/** Rows already carry their label; this checks it rather than adding one. */
function assembleClosing(tables: ReadonlyArray<readonly [string, Row[]]>): WorkbookPayload {
  const sheets = tables.map(([name, rows]) => {
    if (rows[0]?.[0] !== LABEL_HEADER) throw new Error(`${name}: die erste Spalte ist nicht ${LABEL_HEADER}.`);
    const unlabelled = rows.slice(1).findIndex(r => !LABEL_WORDS.includes(String(r[0])));
    if (unlabelled !== -1) throw new Error(`${name}: Zeile ${unlabelled + 2} hat keine gueltige Kennzeichnung.`);
    return { name, header: true as const, rows: rows.map(r => r.map(toPayloadCell)) };
  });
  sheets.push({ name: SIMULATED_SHEET_NAME, header: true as const, rows: [[SIMULATED_NOTICE]] });
  const payload: WorkbookPayload = { version: CONTRACT_VERSION, sheets };
  const problem = contractProblem(payloadCost(payload));
  if (problem) throw new Error(problem);
  return payload;
}

/**
 * The closing workbook as the payload the export service writes. Refuses a
 * Fahrtenbuch sheet that holds a declined order or an empty drive: built from
 * `reportRides` and the non-declined real trips, it cannot today; this is the
 * rule's second wall.
 */
export function buildMonthClosing(result: FullMonthResult, verification: MonthVerification = verifyMonth(result)): MonthReport {
  const rides = closingRidesSheetRows(result);
  const statusAt = CLOSING_RIDE_HEADERS.indexOf('Status');
  if (rides.slice(1).some(r => r[statusAt] === STATUS_WORD.declined || r[statusAt] === 'declined')) {
    throw new Error('Das Fahrtenbuch des Monatsabschlusses enthielte abgelehnte Auftraege; er wird nicht erstellt.');
  }
  const payload = assembleClosing([
    [CLOSING_SHEET_RIDES, rides],
    [CLOSING_SHEET_SHIFTS, shiftsSheetRows(result)],
    [CLOSING_SHEET_PAY, paySheetRows(result)],
    [CLOSING_SHEET_UBER, uberSheetRows(result)],
    [CLOSING_SHEET_VEHICLES, vehiclesSheetRows(result)],
    [CLOSING_SHEET_CALENDAR, calendarSheetRows(result)],
    [CLOSING_SHEET_CHECKS, checksSheetRows(result, verification)],
  ]);
  return { fileName: reportFileName('Monatsabschluss', result, verification), payload };
}
