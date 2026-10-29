import type { TravelRouter } from '../utils/travelRouting/prefetch';
import type { RoutingProvenance } from '../utils/simulatedRides/fullMonth';
import { POOL_MAX_AGE_DAYS } from '../utils/simulatedRides/addressPool';
import {
  countDropped,
  verifyPool,
  type DroppedAddress,
  type PoolVerification,
} from '../utils/simulatedRides/poolVerification';
import {
  buildRoutedMatrix,
  matrixCoverage,
  matrixTravelModel,
  pointKey,
  selectRoutingPoints,
  type RoutedMatrix,
  type TravelModel,
} from '../utils/simulatedRides/travelModel';
import type { GeoPoint, PoolAddress } from '../utils/simulatedRides/types';
import type { GeocodeClient } from './geocodeClient';

/**
 * Everything the simulator needs from the two services before it may claim a
 * drive time: the verified pool, the routed matrix over it, and the record of
 * how both were obtained (external audit round 4, decision 2 of 29.10.2026).
 *
 * The functions behind the clients run on another product's server behind a
 * rate-limited gateway, so this seam asks one call at a time with a pause, and
 * keeps both answers in the browser for 90 days like the address pool itself.
 * Nothing is written to the database: a pool address is not company data.
 *
 * ## What "too few" means
 *
 * Fewer than `MIN_ROUTED_POINTS` addresses that survive the check, or fewer
 * than that many with a route in and a route out, or a Betriebssitz with no
 * route in one direction. Below that the generator has no room to draw a
 * pickup that differs from the last drop-off, and a month built on it would be
 * the estimate in everything but name. The caller reports it and offers the
 * labelled estimate only on an explicit opt-in; this module never falls back.
 */

export const ROUTING_POINTS = 64;
export const MIN_ROUTED_POINTS = 8;
/** Between two service calls, so the gateways' budgets (5 and 40 a second) are never at their ceiling. */
export const SERVICE_PAUSE_MS = 300;

export type RoutingPhase = 'verify' | 'route';
export interface RoutingProgress { phase: RoutingPhase; done: number; total: number }

export type RoutingFailureReason =
  | 'verification_failed'
  | 'too_few_addresses'
  | 'routing_failed'
  | 'base_unroutable'
  | 'too_few_routes';

export type RoutingOutcome =
  | {
      ok: true;
      /** The routed points the generator may draw from: verified, and with a route in and out. */
      points: PoolAddress[];
      model: TravelModel;
      provenance: RoutingProvenance;
      cached: { verification: boolean; matrix: boolean };
    }
  | { ok: false; reason: RoutingFailureReason; detail: string | null; dropped: DroppedAddress[] };

export interface RoutingDeps {
  geocoder: GeocodeClient;
  router: TravelRouter;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pauseMs?: number;
}

// ── Cache ───────────────────────────────────────────────────────────────────

const VERIFIED_PREFIX = 'simulatedRides.verified.v1:';
const MATRIX_PREFIX = 'simulatedRides.matrix.v1:';

/** FNV-1a: stable across runs and machines. Paired with the length so two short inputs cannot meet by accident. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${text.length.toString(16)}`;
}

/** The matrix is a function of its points, so the points are its key; their order is not part of it. */
export function matrixCacheKey(points: readonly GeoPoint[]): string {
  return MATRIX_PREFIX + hashText([...points].map(pointKey).sort().join('|'));
}

/** The verification is a function of the addresses asked about, text and point both. */
export function verificationCacheKey(pool: readonly PoolAddress[]): string {
  return VERIFIED_PREFIX + hashText(pool.map(a => `${a.label}@${pointKey(a)}`).sort().join('|'));
}

interface Stamped<T> { storedAt: string; value: T }

function fresh(storedAt: unknown, now: Date): boolean {
  const age = now.getTime() - new Date(String(storedAt)).getTime();
  return Number.isFinite(age) && age >= 0 && age < POOL_MAX_AGE_DAYS * 86_400_000;
}

function readStamped<T>(storage: RoutingDeps['storage'], key: string, now: Date, valid: (v: unknown) => v is T): T | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<Stamped<unknown>>;
    return fresh(entry?.storedAt, now) && valid(entry.value) ? entry.value : null;
  } catch {
    return null;
  }
}

function writeStamped(storage: RoutingDeps['storage'], key: string, value: unknown, now: Date): void {
  try {
    storage?.setItem(key, JSON.stringify({ storedAt: now.toISOString(), value }));
  } catch {
    // Storage full or refused: the answer is asked again next time.
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isVerification(v: unknown): v is PoolVerification {
  return isRecord(v) && Array.isArray(v.kept) && Array.isArray(v.dropped) && typeof v.checked === 'number';
}

function isMatrix(v: unknown): v is RoutedMatrix {
  return isRecord(v) && isRecord(v.legs) && isRecord(v.failures) && Array.isArray(v.points)
    && typeof v.source === 'string' && typeof v.computedAt === 'string';
}

// ── The pipeline ────────────────────────────────────────────────────────────

const mostCommon = (counts: Record<string, number>): string | null =>
  Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/** Points with at least one measured leg out of them and one into them. */
function usablePoints(points: readonly PoolAddress[], matrix: RoutedMatrix): PoolAddress[] {
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const key of Object.keys(matrix.legs)) {
    const [from, to] = key.split('>');
    outgoing.add(from);
    incoming.add(to);
  }
  return points.filter(p => outgoing.has(pointKey(p)) && incoming.has(pointKey(p)));
}

function baseRouted(base: GeoPoint, matrix: RoutedMatrix): boolean {
  const key = pointKey(base);
  const keys = Object.keys(matrix.legs);
  return keys.some(k => k.startsWith(`${key}>`)) && keys.some(k => k.endsWith(`>${key}`));
}

export async function prepareRouting(args: {
  pool: readonly PoolAddress[];
  base: GeoPoint;
  deps: RoutingDeps;
  onProgress?: (progress: RoutingProgress) => void;
}): Promise<RoutingOutcome> {
  const { pool, base, deps, onProgress } = args;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep;
  const pauseMs = deps.pauseMs ?? SERVICE_PAUSE_MS;

  // 1. Which addresses are real.
  const vKey = verificationCacheKey(pool);
  let verification = readStamped(deps.storage, vKey, now(), isVerification);
  const verificationCached = verification !== null;
  if (!verification) {
    const outcome = await verifyPool(pool, deps.geocoder, {
      pauseMs, sleep, onProgress: (done, total) => onProgress?.({ phase: 'verify', done, total }),
    });
    if (!outcome.ok) return { ok: false, reason: 'verification_failed', detail: outcome.reason, dropped: [] };
    verification = outcome;
    writeStamped(deps.storage, vKey, { kept: outcome.kept, dropped: outcome.dropped, checked: outcome.checked, dataUpdated: outcome.dataUpdated }, now());
  }
  if (verification.kept.length < MIN_ROUTED_POINTS) {
    return { ok: false, reason: 'too_few_addresses', detail: String(verification.kept.length), dropped: verification.dropped };
  }

  // 2. The roads between them.
  const chosen = selectRoutingPoints(verification.kept, ROUTING_POINTS);
  const mKey = matrixCacheKey([...chosen, base]);
  let matrix = readStamped(deps.storage, mKey, now(), isMatrix);
  const matrixCached = matrix !== null;
  if (!matrix) {
    matrix = await buildRoutedMatrix([...chosen, base], deps.router, {
      pauseMs, sleep, now, onProgress: (done, total) => onProgress?.({ phase: 'route', done, total }),
    });
    // A matrix with no measured leg at all is the service being away, not a result worth keeping.
    if (matrixCoverage(matrix).routed > 0) writeStamped(deps.storage, mKey, matrix, now());
  }

  const cover = matrixCoverage(matrix);
  if (cover.routed === 0) return { ok: false, reason: 'routing_failed', detail: mostCommon(cover.byReason), dropped: verification.dropped };
  if (!baseRouted(base, matrix)) return { ok: false, reason: 'base_unroutable', detail: null, dropped: verification.dropped };
  const points = usablePoints(chosen, matrix);
  if (points.length < MIN_ROUTED_POINTS) {
    return { ok: false, reason: 'too_few_routes', detail: String(points.length), dropped: verification.dropped };
  }

  return {
    ok: true,
    points,
    model: matrixTravelModel(matrix),
    cached: { verification: verificationCached, matrix: matrixCached },
    provenance: {
      points: matrix.points.length,
      routedPairs: cover.routed,
      failedPairs: cover.failed,
      failuresByReason: cover.byReason,
      computedAt: matrix.computedAt,
      addressesChecked: verification.checked,
      addressesKept: verification.kept.length,
      addressesDroppedByReason: countDropped(verification.dropped),
      geocoderSource: verification.dataUpdated,
    },
  };
}
