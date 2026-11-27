/**
 * The figures of one simulated month, for the before/after comparison of
 * Round 8 (§13 item 14).
 *
 * The "before" month is built by the generator as Round 8 found it, run inside
 * a checkout of that commit (`scripts/fleetbook-round8-before.mts`); the
 * "after" month by `scripts/fleetbook-round8-month.mts`. Both hand their result
 * to this module, so it imports nothing from either tree and reads only the
 * fields both generators have: a shape described here, not a type borrowed from
 * one side, so neither side's figures are computed by the other side's code.
 *
 * No name, plate or address leaves it: counts, cents and minutes only.
 */

interface RideLike {
  status: string;
  shiftId: string;
  vehicle: { plate: string; id?: string };
  driver: { name: string; id?: string };
  startMs: number | null;
  km: number;
}

interface ShiftLike {
  id: string;
  operatingDay: string;
  startMs: number;
  endMs: number;
  vehicle: { plate: string; id?: string };
  driver: { name: string; id?: string };
}

export interface MonthResultLike {
  month: { rides: readonly RideLike[]; shifts: readonly ShiftLike[]; droppedShifts: number };
  revenue: { fareCents: number; tipCents: number; cancelledFeeCents: number };
  repositioningSummary: { legs: number; roadKm: number; byPurpose: Record<string, number> };
  refusals: readonly unknown[];
  violations: readonly unknown[];
}

export interface VerificationLike {
  verdict: string;
  routing: string;
  checks: readonly { code: string; outcome: string }[];
}

export interface MonthFigures {
  label: string;
  month: string;
  seed: number;
  /** How the shifts' starting point was chosen in this run, in words. */
  base: string;
  verdict: string;
  routing: string;
  checksNotPassed: string[];
  ridesByStatus: Record<string, number>;
  completedKm: number;
  fareCents: number;
  tipCents: number;
  cancelledFeeCents: number;
  shifts: number;
  droppedShifts: number;
  shiftMinutes: { min: number; median: number; max: number } | null;
  driversWithShifts: number;
  vehiclesWithShifts: number;
  operatingDaysWithShifts: number;
  /** The most shifts one driver held on one operating day. */
  maxShiftsPerDriverDay: number;
  emptyLegs: number;
  emptyRoadKm: number;
  emptyLegsByPurpose: Record<string, number>;
  capacityRefusals: number;
  violations: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function minutesSpread(values: number[]): MonthFigures['shiftMinutes'] {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median: round1(median), max: sorted[sorted.length - 1] };
}

const driverKey = (d: { name: string; id?: string }): string => d.id ?? `name:${d.name}`;
const vehicleKey = (v: { plate: string; id?: string }): string => v.id ?? `plate:${v.plate}`;

export function monthFigures(
  meta: { label: string; month: string; seed: number; base: string },
  result: MonthResultLike,
  verification: VerificationLike,
): MonthFigures {
  const { rides, shifts } = result.month;
  const ridesByStatus: Record<string, number> = {};
  for (const r of rides) ridesByStatus[r.status] = (ridesByStatus[r.status] ?? 0) + 1;
  const perDriverDay = new Map<string, number>();
  for (const s of shifts) {
    const key = `${driverKey(s.driver)}|${s.operatingDay}`;
    perDriverDay.set(key, (perDriverDay.get(key) ?? 0) + 1);
  }
  return {
    ...meta,
    verdict: verification.verdict,
    routing: verification.routing,
    checksNotPassed: verification.checks.filter(c => c.outcome !== 'passed').map(c => `${c.code}=${c.outcome}`),
    ridesByStatus,
    completedKm: round1(rides.filter(r => r.status === 'completed').reduce((sum, r) => sum + r.km, 0)),
    fareCents: result.revenue.fareCents,
    tipCents: result.revenue.tipCents,
    cancelledFeeCents: result.revenue.cancelledFeeCents,
    shifts: shifts.length,
    droppedShifts: result.month.droppedShifts,
    shiftMinutes: minutesSpread(shifts.map(s => Math.round((s.endMs - s.startMs) / 60_000))),
    driversWithShifts: new Set(shifts.map(s => driverKey(s.driver))).size,
    vehiclesWithShifts: new Set(shifts.map(s => vehicleKey(s.vehicle))).size,
    operatingDaysWithShifts: new Set(shifts.map(s => s.operatingDay)).size,
    maxShiftsPerDriverDay: Math.max(0, ...perDriverDay.values()),
    emptyLegs: result.repositioningSummary.legs,
    emptyRoadKm: round1(result.repositioningSummary.roadKm),
    emptyLegsByPurpose: { ...result.repositioningSummary.byPurpose },
    capacityRefusals: result.refusals.length,
    violations: result.violations.length,
  };
}

const euro = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

function changeOf(before: number, after: number): string {
  if (before === after) return 'gleich';
  const diff = after - before;
  const pct = before === 0 ? '' : ` (${diff > 0 ? '+' : ''}${round1((diff / before) * 100).toString().replace('.', ',')} %)`;
  return `${diff > 0 ? '+' : ''}${round1(diff).toString().replace('.', ',')}${pct}`;
}

/** The comparison as a Markdown table, one row per figure, then what differs in the inputs. */
export function compareFigures(before: MonthFigures, after: MonthFigures, inputNotes: readonly string[] = []): string {
  if (before.month !== after.month) throw new Error(`comparing ${before.month} with ${after.month}`);
  const statuses = [...new Set([...Object.keys(before.ridesByStatus), ...Object.keys(after.ridesByStatus)])].sort();
  const purposes = [...new Set([...Object.keys(before.emptyLegsByPurpose), ...Object.keys(after.emptyLegsByPurpose)])].sort();
  const num = (label: string, b: number, a: number): string[] => [label, String(b).replace('.', ','), String(a).replace('.', ','), changeOf(b, a)];
  const money = (label: string, b: number, a: number): string[] => [label, euro(b), euro(a), b === a ? 'gleich' : euro(a - b)];
  const text = (label: string, b: string, a: string): string[] => [label, b, a, b === a ? 'gleich' : 'geändert'];
  const spread = (m: MonthFigures['shiftMinutes']): string => (m ? `${m.min} / ${String(m.median).replace('.', ',')} / ${m.max}` : '—');
  const rows: string[][] = [
    text('Startpunkt der Schichten', before.base, after.base),
    text('Ergebnis', before.verdict, after.verdict),
    text('Routen', before.routing, after.routing),
    text('Nicht bestandene Prüfungen', before.checksNotPassed.join(', ') || 'keine', after.checksNotPassed.join(', ') || 'keine'),
    ...statuses.map(s => num(`Fahrten ${s}`, before.ridesByStatus[s] ?? 0, after.ridesByStatus[s] ?? 0)),
    num('km abgeschlossener Fahrten', before.completedKm, after.completedKm),
    money('Fahrpreise', before.fareCents, after.fareCents),
    money('Trinkgeld', before.tipCents, after.tipCents),
    money('Stornogebühren', before.cancelledFeeCents, after.cancelledFeeCents),
    num('Schichten', before.shifts, after.shifts),
    num('Verworfene Schichten', before.droppedShifts, after.droppedShifts),
    text('Schichtdauer min / Median / max (Minuten)', spread(before.shiftMinutes), spread(after.shiftMinutes)),
    num('Fahrer mit Schichten', before.driversWithShifts, after.driversWithShifts),
    num('Fahrzeuge mit Schichten', before.vehiclesWithShifts, after.vehiclesWithShifts),
    num('Betriebstage mit Schichten', before.operatingDaysWithShifts, after.operatingDaysWithShifts),
    num('Höchstens Schichten je Fahrer und Tag', before.maxShiftsPerDriverDay, after.maxShiftsPerDriverDay),
    num('Leerfahrten', before.emptyLegs, after.emptyLegs),
    num('Leerfahrten km (Straße)', before.emptyRoadKm, after.emptyRoadKm),
    ...purposes.map(p => num(`Leerfahrten ${p}`, before.emptyLegsByPurpose[p] ?? 0, after.emptyLegsByPurpose[p] ?? 0)),
    num('Kapazitätsablehnungen', before.capacityRefusals, after.capacityRefusals),
    num('Regelverstöße im Rücklesen', before.violations, after.violations),
  ];
  const line = (cells: readonly string[]): string => `| ${cells.map(c => c.replace(/\|/gu, '\\|')).join(' | ')} |`;
  return [
    `# Vorher / nachher: ${after.month}, Seed ${after.seed}`,
    '',
    `Vorher: ${before.label}. Nachher: ${after.label}. Alle Fahrten sind SIMULIERT.`,
    '',
    line(['Kennzahl', 'Vorher', 'Nachher', 'Änderung']),
    line(['---', '---:', '---:', '---']),
    ...rows.map(line),
    ...(inputNotes.length ? ['', '## Was an den Eingaben verschieden ist', '', ...inputNotes.map(n => `- ${n}`)] : []),
    '',
  ].join('\n');
}
