/**
 * Pure core of the route check: which consecutive rides of one vehicle or one
 * driver have a drive between them, and whether the gap holds that drive.
 *
 * No network, no file, no clock: scripts/fleetbook-route-check.mts feeds it
 * what the geocoder and the router answered and writes what comes out.
 *
 * The rule that matters: a transition is `ESTIMATE_FITS` only when BOTH ends
 * were located at house level AND a route was measured AND it fits. Everything
 * else that is not the same address is `UNVERIFIED` with a reason. A missing,
 * failed, NaN, infinite or negative route is never a zero and never a pass.
 * Even a pass is an estimate of the road time (free flow, no traffic), and the
 * labels say so.
 */

export type Grouping = 'vehicle' | 'driver';

export interface AuditRide {
  /** 1-based position in the source sheet. */
  readonly nr: number;
  /** Wall-clock start and end, read as if they were UTC (only differences and the hour are used). */
  readonly startMs: number;
  readonly endMs: number;
  readonly vehicle: string;
  readonly driver: string;
  readonly pickup: string;
  readonly dropoff: string;
  readonly cancelled: boolean;
}

export interface Transition {
  readonly grouping: Grouping;
  readonly group: string;
  readonly prevNr: number;
  readonly nextNr: number;
  /** Wall-clock "YYYY-MM-DD HH:MM:SS" of the previous ride's end. */
  readonly prevEnd: string;
  readonly nextStart: string;
  readonly availableSeconds: number;
  /** Where the previous ride ended and the next one starts, as written in the sheet. */
  readonly fromText: string;
  readonly toText: string;
}

export type GeocodeLookup =
  | { readonly kind: 'located'; readonly lat: number; readonly lon: number }
  | { readonly kind: 'unlocated'; readonly reason: string };

export type RouteLookup =
  | { readonly kind: 'route'; readonly seconds: number; readonly km: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type CheckStatus = 'ESTIMATE_FITS' | 'SAME_ADDRESS' | 'UNVERIFIED' | 'ROUTE_TIME_WARNING';

export interface CheckResult {
  readonly status: CheckStatus;
  readonly reason: string;
  readonly roadSeconds: number | null;
  readonly roadKm: number | null;
  /** available - road; negative = shortfall. */
  readonly marginSeconds: number | null;
}

export const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = {
  ESTIMATE_FITS: 'Estimated route time fits gap; an estimate, not proof of a real trip',
  SAME_ADDRESS: 'Same address; no drive needed',
  UNVERIFIED: 'Not verifiable',
  ROUTE_TIME_WARNING: 'Estimated route time exceeds gap; a warning on an estimate, not proven impossibility',
};

// -- Time ---------------------------------------------------------------------

const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/u;

/** "2026-09-07 04:40:31" as ms, the wall clock read as UTC; NaN when it is not that shape. */
export function wallMs(text: string): number {
  const m = WALL.exec(text.trim());
  if (m === null) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] === undefined ? 0 : +m[6]);
}

export function formatWall(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** The local hour (0-23) of a wall-clock text; NaN when unreadable. */
export function wallHour(text: string): number {
  const m = WALL.exec(text.trim());
  return m === null ? Number.NaN : +m[4];
}

// -- Transitions --------------------------------------------------------------

/** The same place written twice is one key: case, spaces and a trailing country do not matter. */
export function sameAddressKey(text: string): string {
  const parts = text.normalize('NFC').split(',').map((p) => p.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('de-DE')).filter((p) => p !== '');
  if (parts.length > 0 && (parts[parts.length - 1] === 'deutschland' || parts[parts.length - 1] === 'germany')) parts.pop();
  return parts.join(', ');
}

function pairsOf(grouping: Grouping, group: string, rides: readonly AuditRide[]): Transition[] {
  const ordered = [...rides].sort((a, b) => a.startMs - b.startMs || a.nr - b.nr);
  const out: Transition[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    out.push({
      grouping,
      group,
      prevNr: prev.nr,
      nextNr: next.nr,
      prevEnd: formatWall(prev.endMs),
      nextStart: formatWall(next.startMs),
      availableSeconds: Math.round((next.startMs - prev.endMs) / 1000),
      fromText: prev.dropoff,
      toText: next.pickup,
    });
  }
  return out;
}

/**
 * Consecutive COMPLETED rides per vehicle and, separately, per driver, in start
 * order. A cancelled ride is not a ride and is skipped; a ride with an unreadable
 * time is skipped too (it has no gap to measure), and so is one with no name.
 */
export function buildTransitions(rides: readonly AuditRide[]): Transition[] {
  const usable = rides.filter((r) => !r.cancelled && Number.isFinite(r.startMs) && Number.isFinite(r.endMs));
  const out: Transition[] = [];
  for (const grouping of ['vehicle', 'driver'] as const) {
    const groups = new Map<string, AuditRide[]>();
    for (const ride of usable) {
      const key = grouping === 'vehicle' ? ride.vehicle : ride.driver;
      if (key.trim() === '') continue;
      groups.set(key, [...(groups.get(key) ?? []), ride]);
    }
    for (const [key, list] of groups) out.push(...pairsOf(grouping, key, list));
  }
  return out;
}

// -- Classification -----------------------------------------------------------

const usableNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const unverified = (reason: string): CheckResult => ({ status: 'UNVERIFIED', reason, roadSeconds: null, roadKm: null, marginSeconds: null });

/**
 * Decides one transition. `route` is whatever the router answered for the two
 * located points (undefined = nobody asked or no answer arrived).
 */
export function classifyTransition(
  t: Pick<Transition, 'availableSeconds' | 'fromText' | 'toText'>,
  from: GeocodeLookup | undefined,
  to: GeocodeLookup | undefined,
  route: RouteLookup | undefined,
): CheckResult {
  if (sameAddressKey(t.fromText) !== '' && sameAddressKey(t.fromText) === sameAddressKey(t.toText)) {
    return { status: 'SAME_ADDRESS', reason: STATUS_LABEL.SAME_ADDRESS, roadSeconds: 0, roadKm: 0, marginSeconds: t.availableSeconds };
  }
  const missing = [
    from === undefined || from.kind !== 'located' ? `dropoff:${from === undefined ? 'not_asked' : from.kind === 'unlocated' ? from.reason : 'bad'}` : null,
    to === undefined || to.kind !== 'located' ? `pickup:${to === undefined ? 'not_asked' : to.kind === 'unlocated' ? to.reason : 'bad'}` : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) return unverified(`geocode ${missing.join(' ')}`);
  if (!Number.isFinite(t.availableSeconds)) return unverified('available_seconds_unreadable');
  if (route === undefined) return unverified('route_not_asked');
  if (route.kind !== 'route') return unverified(`route ${route.kind === 'unavailable' ? route.reason : 'bad'}`);
  if (!usableNumber(route.seconds) || !usableNumber(route.km)) return unverified('route_invalid_number');
  const margin = Math.round(t.availableSeconds - route.seconds);
  const fits = route.seconds <= t.availableSeconds;
  return {
    status: fits ? 'ESTIMATE_FITS' : 'ROUTE_TIME_WARNING',
    reason: STATUS_LABEL[fits ? 'ESTIMATE_FITS' : 'ROUTE_TIME_WARNING'],
    roadSeconds: Math.round(route.seconds),
    roadKm: Math.round(route.km * 1000) / 1000,
    marginSeconds: margin,
  };
}

// -- Cause of a warning ---------------------------------------------------------

export type CauseClass = 'geocode' | 'model_violated' | 'engine_disagreement' | 'model_underestimate' | 'route_unavailable';

export interface CauseInput {
  readonly availableSeconds: number;
  readonly fromLocated: boolean;
  readonly toLocated: boolean;
  /** The generator's own model, deadheadSeconds(roadKm(from,to), hour); null when an end is not located. */
  readonly modelSeconds: number | null;
  /** The engine we can run (OSRM), null when it has no answer. */
  readonly engineSeconds: number | null;
}

/**
 * Why a warned pair was warned, in this order:
 * geocode (an end is not house-level, so nothing was measured), model_violated
 * (the gap is below what the generator's own rule demands: a different bug),
 * route_unavailable, engine_disagreement (our engine fits the gap, the
 * auditor's did not), model_underestimate (the gap honours the model, and the
 * engine needs longer than the gap).
 */
export function causeClass(c: CauseInput): CauseClass {
  if (!c.fromLocated || !c.toLocated || c.modelSeconds === null || !Number.isFinite(c.modelSeconds)) return 'geocode';
  if (c.availableSeconds < c.modelSeconds) return 'model_violated';
  if (c.engineSeconds === null || !usableNumber(c.engineSeconds)) return 'route_unavailable';
  return c.engineSeconds <= c.availableSeconds ? 'engine_disagreement' : 'model_underestimate';
}

// -- Statistics -----------------------------------------------------------------

/** Linear-interpolated percentile of a list (p in 0..1); NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// -- CSV ------------------------------------------------------------------------

/** RFC-4180 reader, BOM tolerant. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/u, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\r\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
  }).join(',');
}
