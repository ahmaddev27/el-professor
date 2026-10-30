import { createRng, type Rng } from './rng';
import { DEFAULT_OPTIONS, SHIFT_LIMITS, runShift, type Context, type PlannedShift } from './generator';
import { daysInMonth, operatingDayStartMs } from './time';
import { normaliseDriverName } from '../fahrtenbuchImportParser';
import type { StructuredNote } from '../monatsplanungPhase3';
import { collapseDecisions, noteVerdict, vehicleVerdict, type ShiftDecision, type VehicleFacts } from './simulationConstraints';
import type { TravelModel } from './travelModel';
import type { GeneratedMonth, GeneratorOptions, GeoPoint, PoolAddress, SimDriver, SimRide, SimShift, SimVehicle } from './types';

/**
 * Rides that EXPLAIN the figures the system already holds.
 *
 * The books say what a driver earned in a business week: `income` rows of type
 * `umsatz`, `bargeld`, `trinkgeld` and `aktionen`. The generator never invents
 * a total. For each driver-week that has figures it makes rides whose fares add
 * up to exactly those figures, to the cent, so the Fahrtenbuch closes against
 * the books instead of contradicting them and no salary moves:
 *
 *   sum of the fares of all completed rides      = umsatz
 *   sum of the fares of the rides paid in cash   = bargeld
 *   sum of the tips                              = trinkgeld
 *
 * Money is integer cents throughout. A remainder is never rounded away: the last
 * ride of a group takes it, and `figuresOf(rides)` reads the totals back so the
 * caller asserts equality before anything is written.
 *
 * `aktionen` is not carried by any ride (the export has no column for a
 * promotion); it is left exactly as recorded and reported.
 *
 * A driver-week whose records contradict each other, that already has real
 * trips, or whose figures cannot be explained under the shift rules is REFUSED
 * with a finding. It is never smoothed over.
 */
export type FindingCode =
  | 'unknown_driver' | 'negative_amount' | 'fractional_cent' | 'cash_without_revenue'
  | 'cash_exceeds_revenue' | 'tip_without_revenue' | 'revenue_too_small' | 'real_trips_exist'
  | 'cannot_explain';

export interface Finding { driver: string; weekMonday: string; code: FindingCode; detail?: string }

export interface IncomeRow { driver_name: string; type: string; date: string; amount: number | string }

export interface WeekFigures {
  driver: string;
  weekMonday: string;
  umsatz: number;
  bargeld: number;
  trinkgeld: number;
  aktionen: number;
}

const MIN_FARE_CENTS = 500;
const AVG_FARE_CENTS = 1800;
const AVG_BAND_CENTS: readonly [number, number] = [900, 4800];
const RIDES_PER_SHIFT = 10;
const ATTEMPT_DELTAS = [0, 1, -1, 2, -2, 3] as const;
const DAY_MS = 86_400_000;

// ── Reading the books ───────────────────────────────────────────────────────

export function mondayOf(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Exact cents, or null when the amount has a fraction of a cent (never rounded). */
export function toCents(amount: number | string): number | null {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : null;
}

export const weekKey = (driver: string, monday: string): string => `${normaliseDriverName(driver)}|${monday}`;

/** The business weeks of a month: those whose Monday falls in it. */
export function mondaysOfMonth(year: number, month: number): string[] {
  const out: string[] = [];
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (mondayOf(date) === date) out.push(date);
  }
  return out;
}

interface Reading { figures: WeekFigures[]; findings: Finding[] }

export function readFigures(rows: readonly IncomeRow[], year: number, month: number, knownDrivers: readonly string[]): Reading {
  const mondays = new Set(mondaysOfMonth(year, month));
  const known = new Set(knownDrivers.map(normaliseDriverName));
  const groups = new Map<string, WeekFigures>();
  const findings: Finding[] = [];
  const flagged = new Set<string>();
  const flag = (f: Finding) => { const k = `${f.code}|${weekKey(f.driver, f.weekMonday)}`; if (!flagged.has(k)) { flagged.add(k); findings.push(f); } };

  for (const row of rows) {
    const monday = mondayOf(row.date);
    if (!mondays.has(monday)) continue;
    const key = weekKey(row.driver_name, monday);
    const entry = groups.get(key) ?? { driver: row.driver_name.trim(), weekMonday: monday, umsatz: 0, bargeld: 0, trinkgeld: 0, aktionen: 0 };
    groups.set(key, entry);
    const cents = toCents(row.amount);
    if (cents === null) { flag({ driver: entry.driver, weekMonday: monday, code: 'fractional_cent' }); continue; }
    if (row.type === 'umsatz' || row.type === 'bargeld' || row.type === 'trinkgeld' || row.type === 'aktionen') entry[row.type] += cents;
  }
  const figures: WeekFigures[] = [];
  for (const [key, f] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const finding = judge(f, known.has(key.split('|')[0]));
    if (finding) flag(finding);
    else if (!flagged.has(`fractional_cent|${key}`)) figures.push(f);
  }
  return { figures: figures.sort((a, b) => a.weekMonday.localeCompare(b.weekMonday) || a.driver.localeCompare(b.driver)), findings };
}

/** The contradictions the books can show on their own, before any ride exists. */
function judge(f: WeekFigures, known: boolean): Finding | null {
  const at = (code: FindingCode, detail?: string): Finding => ({ driver: f.driver, weekMonday: f.weekMonday, code, detail });
  if (!known) return at('unknown_driver');
  if (f.umsatz < 0 || f.bargeld < 0 || f.trinkgeld < 0) return at('negative_amount');
  if (f.umsatz === 0 && f.bargeld > 0) return at('cash_without_revenue');
  if (f.bargeld > f.umsatz) return at('cash_exceeds_revenue');
  if (f.umsatz === 0 && f.trinkgeld > 0) return at('tip_without_revenue');
  if (f.umsatz > 0 && f.umsatz < MIN_FARE_CENTS) return at('revenue_too_small');
  return f.umsatz === 0 ? at('revenue_too_small', 'nothing recorded to explain') : null;
}

// ── Exact allocation ────────────────────────────────────────────────────────

/**
 * Splits `total` cents over the weights: every share at least `min`, the shares
 * add up to `total` exactly, and the last share takes whatever the integer
 * division left. Null when the minimums do not fit.
 */
export function allocateCents(weights: readonly number[], total: number, min: number): number[] | null {
  const n = weights.length;
  if (n === 0 || total < n * min) return null;
  const spare = total - n * min;
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map(w => min + Math.floor((spare * w) / sum));
  const used = shares.reduce((a, b) => a + b, 0);
  shares[n - 1] += total - used;
  return shares;
}

/** What the rides say, in the books' terms, per driver and business week. */
export function figuresOf(rides: readonly SimRide[], dayOf: (r: SimRide) => string): Map<string, Omit<WeekFigures, 'aktionen'>> {
  const out = new Map<string, Omit<WeekFigures, 'aktionen'>>();
  for (const r of rides) {
    const monday = mondayOf(dayOf(r));
    const key = weekKey(r.driver.name, monday);
    const f = out.get(key) ?? { driver: r.driver.name, weekMonday: monday, umsatz: 0, bargeld: 0, trinkgeld: 0 };
    out.set(key, f);
    if (r.status !== 'completed') continue;
    const fare = Math.round(r.fare * 100);
    f.umsatz += fare;
    if (r.payment === 'Bar') f.bargeld += fare;
    f.trinkgeld += Math.round(r.tip * 100);
  }
  return out;
}

function pickCash(rng: Rng, weights: readonly number[], umsatz: number, bargeld: number): boolean[] {
  const n = weights.length;
  if (bargeld === 0) return weights.map(() => false);
  if (bargeld === umsatz) return weights.map(() => true);
  const order = weights.map((_, i) => i).sort(() => rng.next() - 0.5);
  const cash = new Array<boolean>(n).fill(false);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of order) {
    if (cash.filter(Boolean).length >= n - 1) break;
    if (acc / total >= bargeld / umsatz && cash.some(Boolean)) break;
    cash[i] = true;
    acc += weights[i];
  }
  return cash;
}

/** Writes the figures onto the week's rides; null (with a reason) when they cannot be met. */
export function applyFigures(rng: Rng, rides: SimRide[], f: WeekFigures): string | null {
  const done = rides.filter(r => r.status === 'completed');
  const n = done.length;
  if (n === 0) return 'no completed ride';
  if (f.bargeld > 0 && f.bargeld < f.umsatz && n < 2) return 'cash and app payment need two rides';
  const avg = f.umsatz / n;
  if (avg < AVG_BAND_CENTS[0] || avg > AVG_BAND_CENTS[1]) return `average fare ${(avg / 100).toFixed(2)} outside the plausible band`;
  const weights = done.map(r => 4 + 1.15 * r.km + 0.25 * ((r.endMs as number) - (r.startMs as number)) / 60_000);
  const cash = pickCash(rng, weights, f.umsatz, f.bargeld);
  const groups: [boolean, number][] = [[true, f.bargeld], [false, f.umsatz - f.bargeld]];
  for (const [isCash, total] of groups) {
    const idx = done.map((_, i) => i).filter(i => cash[i] === isCash);
    if (total === 0 && idx.length === 0) continue;
    const shares = allocateCents(idx.map(i => weights[i]), total, MIN_FARE_CENTS);
    if (!shares) return 'the fares do not fit the minimum fare';
    idx.forEach((i, k) => { done[i].fare = shares[k] / 100; done[i].payment = isCash ? 'Bar' : 'App'; done[i].tip = 0; });
  }
  for (const r of rides) if (r.status !== 'completed') { r.fare = 0; r.tip = 0; }
  return spreadTips(rng, done, f.trinkgeld);
}

function spreadTips(rng: Rng, done: SimRide[], tip: number): string | null {
  if (tip === 0) return null;
  const count = Math.max(1, Math.min(done.length, Math.round(tip / 300), Math.floor(tip / 50)));
  const chosen = [...done].sort(() => rng.next() - 0.5).slice(0, count);
  const shares = allocateCents(chosen.map(() => 1), tip, Math.min(50, Math.floor(tip / count)));
  if (!shares) return 'the tips do not fit';
  chosen.forEach((r, i) => { r.tip = shares[i] / 100; });
  return null;
}

// ── Making the shifts that carry the rides ──────────────────────────────────

export interface FiguresInput {
  year: number;
  month: number;
  base: GeoPoint;
  pool: readonly PoolAddress[];
  /** With `id` and the TÜV date when the caller has them: an expired TÜV keeps the vehicle off that day. */
  vehicles: readonly (SimVehicle & VehicleFacts & { id?: string })[];
  /** With `id` when the caller has it: notes are matched on the id, never on the name. */
  drivers: readonly SimDriver[];
  income: readonly IncomeRow[];
  /** `weekKey(driver, monday)` of every driver-week that already holds real trips. */
  occupied: ReadonlySet<string>;
  seed: number;
  options?: Partial<GeneratorOptions>;
  /** Structured notes keyed by `drivers.id`. Only a confirmed blocking window keeps a shift out. */
  driverNotesMap?: ReadonlyMap<string, readonly StructuredNote[]>;
  /** Where the drive times come from; absent is the labelled estimate. */
  travel?: TravelModel;
}

export interface FiguresResult {
  month: GeneratedMonth;
  findings: Finding[];
  /** The driver-weeks that were explained, with the figures they now match. */
  explained: WeekFigures[];
  /**
   * Every shift placed, and every window a driver's confirmed note or a
   * vehicle's expired TÜV kept a shift out of (decision 5 of 29.10.2026).
   */
  decisions: ShiftDecision[];
}

interface Busy { start: number; end: number }

interface Planner {
  ctx: Context;
  input: FiguresInput;
  vehicleBusy: Map<string, Busy[]>;
  driverLastEnd: Map<string, number>;
  nextId: number;
  decisions: ShiftDecision[];
}

const NO_NOTES: ReadonlyMap<string, readonly StructuredNote[]> = new Map();

function driverIdOf(p: Planner, name: string): string | undefined {
  const key = normaliseDriverName(name);
  return p.input.drivers.find(d => normaliseDriverName(d.name) === key)?.id;
}

function excluded(day: string, plate: string, driverId: string | undefined, code: string, reason: string, eventRef: string | null): ShiftDecision {
  return {
    day, plate, vehicleId: null, driverId: driverId ?? null, outcome: 'excluded', code, reason, eventRef,
    certainty: 'confirmed', startMs: null, endMs: null, count: 1,
  };
}

const clash = (list: readonly Busy[] | undefined, s: number, e: number, buffer: number): boolean =>
  (list ?? []).some(b => s < b.end + buffer && e > b.start - buffer);

function chooseDays(rng: Rng, k: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].sort(() => rng.next() - 0.5).slice(0, Math.min(k, 6)).sort((a, b) => a - b);
}

function planShift(p: Planner, f: WeekFigures, dayOffset: number, taken: Map<string, Busy[]>): PlannedShift | null {
  const { rng, opts } = p.ctx;
  const date = addDays(f.weekMonday, dayOffset);
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = operatingDayStartMs(y, m, d);
  if (dayStart === null) return null;
  const driverKey = normaliseDriverName(f.driver);
  const driverId = driverIdOf(p, f.driver);
  const notes = p.input.driverNotesMap ?? NO_NOTES;
  // Vehicles whose TÜV had expired before this day never carry a shift on it;
  // the filter consumes no random number, so a fleet without such a vehicle
  // gets the month it always got.
  const usable = p.input.vehicles.filter(v => {
    const verdict = vehicleVerdict(v, date);
    if (verdict.kind === 'blocked') p.decisions.push(excluded(date, v.plate, driverId, verdict.code, verdict.reason, 'tuev'));
    return verdict.kind !== 'blocked';
  });
  for (let tries = 0; tries < 8; tries++) {
    const len = rng.int(opts.minShiftMinutes / 15, opts.maxShiftMinutes / 15) * 15;
    const startMs = dayStart + rng.int(0, Math.floor((24 * 60 - len) / 15)) * 15 * 60_000;
    const endMs = startMs + len * 60_000;
    if (startMs < (p.driverLastEnd.get(driverKey) ?? -Infinity) + opts.minDriverRestMinutes * 60_000) continue;
    const blocking = noteVerdict(driverId, startMs, endMs, notes).blocking;
    if (blocking) {
      p.decisions.push(excluded(date, '', driverId, 'driver_blocked_by_note', `Bestätigte sperrende Notiz im Zeitfenster (${blocking.note_type})`, blocking.id));
      continue;
    }
    const free = usable.filter(v => {
      const buffer = opts.minVehicleGapMinutes * 60_000;
      return !clash(p.vehicleBusy.get(v.plate), startMs, endMs, buffer) && !clash(taken.get(v.plate), startMs, endMs, buffer);
    });
    if (free.length === 0) continue;
    return { vehicle: rng.pick(free), startMs, plannedEndMs: endMs, operatingDay: date };
  }
  return null;
}

interface Attempt { shifts: SimShift[]; rides: SimRide[]; busy: Map<string, Busy[]>; lastEnd: number; accepted: ShiftDecision[] }

/** The decision row of a placed shift, with the unconfirmed notes and the missing TÜV it ran past. */
function acceptedDecision(p: Planner, plan: PlannedShift, driver: SimDriver, endMs: number): ShiftDecision {
  const driverId = driver.id ?? driverIdOf(p, driver.name);
  const review = noteVerdict(driverId, plan.startMs, endMs, p.input.driverNotesMap ?? NO_NOTES).review;
  const vehicle = p.input.vehicles.find(v => v.plate === plan.vehicle.plate);
  const verdict = vehicle ? vehicleVerdict(vehicle, plan.operatingDay) : null;
  const reasons = [
    ...review.map(n => `Notiz ${n.note_type} ohne bestätigten Zeitraum - nicht sperrend, bitte prüfen`),
    ...(verdict?.kind === 'review' ? [verdict.reason] : []),
  ];
  return {
    day: plan.operatingDay,
    plate: plan.vehicle.plate,
    vehicleId: vehicle?.id ?? null,
    driverId: driverId ?? null,
    outcome: reasons.length > 0 ? 'accepted_with_review' : 'accepted',
    code: review.length > 0 ? 'unconfirmed_note' : verdict?.kind === 'review' ? verdict.code : 'accepted',
    reason: reasons.length > 0 ? reasons.join('; ') : 'Keine bestätigte Einschränkung im Zeitraum',
    eventRef: review[0]?.id ?? (verdict?.kind === 'review' ? 'tuev' : null),
    certainty: review.length > 0 ? 'assumed_from_notice_date' : verdict?.kind === 'review' ? 'reported' : null,
    startMs: plan.startMs,
    endMs,
    count: 1,
  };
}

function runWeek(p: Planner, f: WeekFigures, k: number): Attempt | string {
  const taken = new Map<string, Busy[]>();
  const attempt: Attempt = { shifts: [], rides: [], busy: taken, lastEnd: -Infinity, accepted: [] };
  const driver = p.input.drivers.find(x => normaliseDriverName(x.name) === normaliseDriverName(f.driver)) as SimDriver;
  const driverKey = normaliseDriverName(f.driver);
  for (const offset of chooseDays(p.ctx.rng, k)) {
    const plan = planShift(p, f, offset, taken);
    if (!plan) return 'no vehicle or rest window left for a shift';
    const id = `S${p.nextId + attempt.shifts.length}`;
    const run = runShift(p.ctx, plan, { shiftId: id, vehicle: plan.vehicle, driver });
    if (!run) return 'a shift could not be built';
    if (run.endMs - plan.startMs < SHIFT_LIMITS.minMinutes * 60_000) return 'a shift ended before its minimum length';
    taken.set(plan.vehicle.plate, [...(taken.get(plan.vehicle.plate) ?? []), { start: plan.startMs, end: run.endMs }]);
    attempt.shifts.push({ id, vehicle: plan.vehicle, driver, operatingDay: plan.operatingDay, startMs: plan.startMs, endMs: run.endMs });
    attempt.accepted.push(acceptedDecision(p, plan, driver, run.endMs));
    attempt.rides.push(...run.rides);
    p.driverLastEnd.set(driverKey, run.endMs);
    attempt.lastEnd = run.endMs;
  }
  return attempt;
}

function explainWeek(p: Planner, f: WeekFigures): Attempt | string {
  const startRides = Math.max(1, Math.round(f.umsatz / AVG_FARE_CENTS));
  const k0 = Math.min(6, Math.max(1, Math.ceil(startRides / RIDES_PER_SHIFT)));
  const driverKey = normaliseDriverName(f.driver);
  const before = p.driverLastEnd.get(driverKey);
  let reason = 'no attempt';
  for (const delta of ATTEMPT_DELTAS) {
    const k = Math.min(6, Math.max(1, k0 + delta));
    p.driverLastEnd.set(driverKey, before ?? -Infinity);
    const result = runWeek(p, f, k);
    if (typeof result === 'string') { reason = result; continue; }
    const why = applyFigures(p.ctx.rng, result.rides, f);
    if (why === null) return result;
    reason = why;
  }
  p.driverLastEnd.set(driverKey, before ?? -Infinity);
  return reason;
}

export function generateFromFigures(input: FiguresInput): FiguresResult {
  const opts: GeneratorOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const ctx: Context = { rng: createRng(input.seed), opts, base: input.base, pool: input.pool, usedTransmits: new Set(), travel: input.travel };
  const planner: Planner = { ctx, input, vehicleBusy: new Map(), driverLastEnd: new Map(), nextId: 1, decisions: [] };
  const reading = readFigures(input.income, input.year, input.month, input.drivers.map(d => d.name));
  const findings = [...reading.findings];
  const month: GeneratedMonth = { shifts: [], rides: [], droppedShifts: 0 };
  const explained: WeekFigures[] = [];
  if (input.pool.length < 8 || input.vehicles.length === 0) return { month, findings, explained, decisions: [] };

  for (const f of reading.figures) {
    if (input.occupied.has(weekKey(f.driver, f.weekMonday))) {
      findings.push({ driver: f.driver, weekMonday: f.weekMonday, code: 'real_trips_exist' });
      continue;
    }
    const result = explainWeek(planner, f);
    if (typeof result === 'string') {
      findings.push({ driver: f.driver, weekMonday: f.weekMonday, code: 'cannot_explain', detail: result });
      continue;
    }
    for (const [plate, list] of result.busy) planner.vehicleBusy.set(plate, [...(planner.vehicleBusy.get(plate) ?? []), ...list]);
    planner.nextId += result.shifts.length;
    month.shifts.push(...result.shifts);
    month.rides.push(...result.rides);
    planner.decisions.push(...result.accepted);
    explained.push(f);
  }
  month.rides.sort((a, b) => a.orderTransmittedMs - b.orderTransmittedMs);
  return { month, findings, explained, decisions: collapseDecisions(planner.decisions) };
}
