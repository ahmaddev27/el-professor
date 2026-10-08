/**
 * What the "Rückkehrpflicht & Adressen" tab derives, as pure functions.
 *
 * The tab adds no rule: placements and anomalies come from `src/utils/returnCheck`.
 * What is left is screen arithmetic — reading the Betriebssitz a person typed,
 * which rows are "to review", how an instant is written — kept out of the
 * component so it can be tested without a renderer. Nothing here reads the
 * clock, a database or the UI language: a label is returned as a dictionary key.
 *
 * Wording rule for everything this feeds: a list to review, never a verdict.
 */
import type { TranslationKey, TranslationVars } from '../i18n';
import type { ExportOptions } from './excelExport';
import {
  DEFAULT_RETURN_CHECK_SETTINGS,
  type AnomalyType,
  type CheckRide,
  type LatLon,
  type OrderPlacement,
  type ReturnCheckResult,
  type UnverifiableReason,
} from './returnCheck';

export const RADIUS_OPTIONS_KM: readonly number[] = [0.5, 1, 2, 3, 5];

/** The placements that land in the "Zu prüfen" table. */
export const REVIEW_PLACEMENTS = ['away_from_base', 'block_start_away'] as const;
export type ReviewPlacement = (typeof REVIEW_PLACEMENTS)[number];

export const PLACEMENT_KEYS: Record<OrderPlacement, TranslationKey> = {
  during_previous: 'returncheck.placement.during_previous',
  at_base: 'returncheck.placement.at_base',
  away_from_base: 'returncheck.placement.away_from_base',
  block_start_at_base: 'returncheck.placement.block_start_at_base',
  block_start_away: 'returncheck.placement.block_start_away',
  unverifiable: 'returncheck.placement.unverifiable',
};

export const ANOMALY_KEYS: Record<AnomalyType, TranslationKey> = {
  same_address: 'returncheck.anomaly.same_address',
  same_street: 'returncheck.anomaly.same_street',
  implausible_speed: 'returncheck.anomaly.implausible_speed',
  zero_distance: 'returncheck.anomaly.zero_distance',
  position_invalid: 'returncheck.anomaly.position_invalid',
  order_after_start: 'returncheck.anomaly.order_after_start',
};

/** One sentence per reason, with `{count}` for the number of rides. */
export const UNVERIFIABLE_KEYS: Record<UnverifiableReason, TranslationKey> = {
  no_order_time: 'returncheck.unverifiable.no_order_time',
  no_position: 'returncheck.unverifiable.no_position',
  no_base: 'returncheck.unverifiable.no_base',
  no_ride_times: 'returncheck.unverifiable.no_ride_times',
};

export const ANOMALY_ORDER: readonly AnomalyType[] = [
  'same_address', 'same_street', 'implausible_speed', 'zero_distance', 'position_invalid', 'order_after_start',
];

export const SUMMARY_PLACEMENT_ORDER: readonly OrderPlacement[] = [
  'during_previous', 'at_base', 'away_from_base', 'block_start_at_base', 'block_start_away', 'unverifiable',
];

// ── The Betriebssitz a person types ──────────────────────────────────────────

/** `52,5200` and `52.52` both read; anything else, or an empty field, is null. */
export function parseCoordinate(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^[+-]?\d{1,3}(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type BaseProblem = 'lat' | 'lon';

export interface ParsedBase {
  readonly base: LatLon | null;
  /** Which field is filled in but unusable; an empty field is not a problem, just no base yet. */
  readonly problem: BaseProblem | null;
}

export function parseBase(latText: string, lonText: string): ParsedBase {
  const lat = parseCoordinate(latText);
  const lon = parseCoordinate(lonText);
  if (latText.trim() !== '' && (lat === null || lat < -90 || lat > 90)) return { base: null, problem: 'lat' };
  if (lonText.trim() !== '' && (lon === null || lon < -180 || lon > 180)) return { base: null, problem: 'lon' };
  if (lat === null || lon === null) return { base: null, problem: null };
  return { base: { lat, lon }, problem: null };
}

/** German decimal comma, five places (about a metre). */
export function formatCoordinate(value: number): string {
  return value.toFixed(5).replace('.', ',');
}

// ── Time in the product's own zone ───────────────────────────────────────────

const BERLIN_PARTS = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

interface BerlinStamp { readonly date: string; readonly time: string }

/** `YYYY-MM-DD` and `HH:MM` of an instant in Europe/Berlin (the ui's `formatDate` writes the date). */
export function berlinStamp(ms: number): BerlinStamp {
  const parts: Record<string, string> = {};
  for (const part of BERLIN_PARTS.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function de(value: number, digits = 0): string {
  return value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// ── "Zu prüfen" ──────────────────────────────────────────────────────────────

export interface ReviewRow {
  readonly id: string;
  readonly placement: ReviewPlacement;
  readonly date: string;
  readonly orderTime: string;
  readonly orderMs: number;
  readonly vehicle: string;
  readonly driver: string | null;
  readonly previousEndTime: string | null;
  readonly waitMinutes: number | null;
  readonly distanceKm: number | null;
  readonly prebooked: boolean;
  readonly samePostalCode: boolean;
}

const isReview = (p: OrderPlacement): p is ReviewPlacement => p === 'away_from_base' || p === 'block_start_away';

export function buildReviewRows(result: ReturnCheckResult, rides: readonly CheckRide[]): ReviewRow[] {
  const byId = new Map(rides.map(r => [r.id, r]));
  const rows: ReviewRow[] = [];
  for (const order of result.orders) {
    if (!isReview(order.placement)) continue;
    const ride = byId.get(order.rideId);
    /*
     * A block start is judged by its position alone and needs no order time, so
     * one without it is still a row to review: it is dated by the ride's start.
     * Dropping it would hide exactly the shift that began away from the base.
     */
    const ms = order.orderMs ?? ride?.startMs ?? null;
    if (ms === null) continue;
    const stamp = berlinStamp(ms);
    // A block start follows no ride: the hours since the previous block are a pause, not a wait after a ride.
    const blockStart = order.placement === 'block_start_away';
    rows.push({
      id: order.rideId,
      placement: order.placement,
      date: stamp.date,
      orderTime: stamp.time,
      orderMs: ms,
      vehicle: order.vehicle,
      driver: ride?.driverName ?? null,
      previousEndTime: blockStart || order.previousEndMs === null ? null : berlinStamp(order.previousEndMs).time,
      waitMinutes: blockStart ? null : order.waitMinutes,
      distanceKm: order.distanceKm,
      prebooked: order.prebooked === true,
      samePostalCode: order.samePostalCodeAsPreviousDestination === true,
    });
  }
  return sortReviewRows(rows);
}

/** Longest wait first; rows without a wait (block starts) after those; the earlier order first within a tie. */
export function sortReviewRows(rows: readonly ReviewRow[]): ReviewRow[] {
  return [...rows].sort((a, b) => {
    const wa = a.waitMinutes ?? -Infinity;
    const wb = b.waitMinutes ?? -Infinity;
    if (wa !== wb) return wb > wa ? 1 : -1;
    return a.orderMs - b.orderMs;
  });
}

export function filterReviewRows(rows: readonly ReviewRow[], vehicle: string, placement: '' | ReviewPlacement): ReviewRow[] {
  return rows.filter(r => (vehicle === '' || r.vehicle === vehicle) && (placement === '' || r.placement === placement));
}

export function reviewVehicles(rows: readonly ReviewRow[]): string[] {
  return [...new Set(rows.map(r => r.vehicle))].sort((a, b) => a.localeCompare(b, 'de'));
}

// ── "Auffällige Fahrten" ─────────────────────────────────────────────────────

export interface AnomalyRow {
  readonly id: string;
  readonly rideId: string;
  readonly type: AnomalyType;
  readonly date: string;
  readonly sortMs: number;
  readonly vehicle: string;
  readonly driver: string | null;
  readonly detail: { readonly key: TranslationKey; readonly vars: TranslationVars } | null;
  /** Only for the two address findings: the operator needs both texts to judge them. */
  readonly addresses: { readonly pickup: string; readonly dropoff: string } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A finding's values as a dictionary sentence; null when the values the sentence needs are absent. */
export function anomalyDetail(
  type: AnomalyType,
  values: Readonly<Record<string, string | number | boolean | null>>,
): AnomalyRow['detail'] {
  switch (type) {
    case 'implausible_speed': {
      const speed = num(values.speedKmh), km = num(values.km), minutes = num(values.minutes);
      if (speed === null || km === null || minutes === null) return null;
      return { key: 'returncheck.detail.speed', vars: { speed: de(speed), km: de(km, 1), minutes: de(minutes) } };
    }
    case 'zero_distance': {
      const minutes = num(values.minutes);
      return minutes === null ? null : { key: 'returncheck.detail.zeroDistance', vars: { minutes: de(minutes) } };
    }
    case 'order_after_start': {
      const minutes = num(values.minutes);
      return minutes === null ? null : { key: 'returncheck.detail.orderAfterStart', vars: { minutes: de(minutes) } };
    }
    case 'position_invalid': {
      const problem = values.problem;
      if (problem === 'missing') return { key: 'returncheck.detail.position.missing', vars: {} };
      if (problem === 'unparsed') return { key: 'returncheck.detail.position.unparsed', vars: {} };
      if (problem === 'outside_germany') return { key: 'returncheck.detail.position.outside_germany', vars: {} };
      return null;
    }
    default:
      return null;
  }
}

export function buildAnomalyRows(result: ReturnCheckResult, rides: readonly CheckRide[]): AnomalyRow[] {
  const byId = new Map(rides.map(r => [r.id, r]));
  const rows: AnomalyRow[] = [];
  result.anomalies.forEach((anomaly, index) => {
    const ride = byId.get(anomaly.rideId);
    if (!ride) return;
    const ms = ride.startMs ?? ride.orderMs;
    const wantsAddresses = anomaly.type === 'same_address' || anomaly.type === 'same_street';
    rows.push({
      id: `${anomaly.rideId}:${anomaly.type}:${index}`,
      rideId: anomaly.rideId,
      type: anomaly.type,
      date: ms === null ? '' : berlinStamp(ms).date,
      sortMs: ms ?? 0,
      vehicle: ride.vehicle ?? '',
      driver: ride.driverName,
      detail: anomalyDetail(anomaly.type, anomaly.values),
      addresses: wantsAddresses && ride.pickup && ride.dropoff ? { pickup: ride.pickup.raw, dropoff: ride.dropoff.raw } : null,
    });
  });
  return rows;
}

/** Unverifiable rides per reason, in the order of `UNVERIFIABLE_KEYS`, reasons with none left out. */
export function unverifiableCounts(result: ReturnCheckResult): { reason: UnverifiableReason; count: number }[] {
  const counts = new Map<UnverifiableReason, number>();
  for (const order of result.orders) {
    if (order.placement === 'unverifiable' && order.reason) counts.set(order.reason, (counts.get(order.reason) ?? 0) + 1);
  }
  return (Object.keys(UNVERIFIABLE_KEYS) as UnverifiableReason[])
    .filter(reason => (counts.get(reason) ?? 0) > 0)
    .map(reason => ({ reason, count: counts.get(reason) ?? 0 }));
}

// ── Excel ────────────────────────────────────────────────────────────────────

export interface ReviewExportLabels {
  readonly sheetTitle: string;
  readonly moduleName: string;
  readonly date: string;
  readonly vehicle: string;
  readonly driver: string;
  readonly orderAt: string;
  readonly previousEnd: string;
  readonly wait: string;
  readonly distance: string;
  readonly placement: string;
  readonly note: string;
  readonly placements: Readonly<Record<ReviewPlacement, string>>;
  readonly prebooked: string;
  readonly samePostalCode: string;
}

/** The "Zu prüfen" list as a sheet; headers follow the UI language (an operational list, not a statutory form). */
export function reviewExportOptions(rows: readonly ReviewRow[], labels: ReviewExportLabels, filterSummary: string[] = []): ExportOptions {
  return {
    filename: 'rueckkehrpflicht_zu_pruefen',
    sheetTitle: labels.sheetTitle,
    moduleName: labels.moduleName,
    filterSummary,
    columns: [
      { key: 'date', label: labels.date, width: 14 },
      { key: 'vehicle', label: labels.vehicle, width: 16 },
      { key: 'driver', label: labels.driver, width: 22 },
      { key: 'orderAt', label: labels.orderAt, width: 12 },
      { key: 'previousEnd', label: labels.previousEnd, width: 18 },
      { key: 'wait', label: labels.wait, width: 14, type: 'integer' },
      { key: 'distance', label: labels.distance, width: 22, type: 'number' },
      { key: 'placement', label: labels.placement, width: 24 },
      { key: 'note', label: labels.note, width: 36 },
    ],
    rows: rows.map(r => ({
      date: r.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2.$1'),
      vehicle: r.vehicle,
      driver: r.driver ?? '',
      orderAt: r.orderTime,
      previousEnd: r.previousEndTime ?? '',
      wait: r.waitMinutes === null ? '' : Math.round(r.waitMinutes),
      distance: r.distanceKm === null ? '' : Math.round(r.distanceKm * 10) / 10,
      placement: labels.placements[r.placement],
      note: [r.prebooked ? labels.prebooked : '', r.samePostalCode ? labels.samePostalCode : ''].filter(Boolean).join('; '),
    })),
  };
}

// ── The Betriebssitz form ───────────────────────────────────────────────────

/**
 * What the operator typed for the Betriebssitz, held by the page rather than
 * the tab: Radix unmounts an inactive tab, so state kept inside it was lost on
 * every switch to another tab and the proposal was written back over the
 * operator's own entry. `edited` is what keeps the proposal from doing that.
 */
export interface BaseForm {
  readonly latText: string;
  readonly lonText: string;
  readonly radiusKm: number;
  readonly edited: boolean;
}

export const EMPTY_BASE_FORM: BaseForm = {
  latText: '',
  lonText: '',
  radiusKm: DEFAULT_RETURN_CHECK_SETTINGS.baseRadiusKm,
  edited: false,
};

/** The Betriebssitz the company saved, or null when it saved none (or half of one). */
export interface SavedBase {
  readonly base: LatLon;
  readonly radiusKm: number | null;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** PostgREST may answer a numeric column as a string; both read the same. */
export function savedBaseFrom(row: {
  base_latitude?: number | string | null;
  base_longitude?: number | string | null;
  base_radius_km?: number | string | null;
} | null): SavedBase | null {
  if (!row) return null;
  const lat = numberOrNull(row.base_latitude);
  const lon = numberOrNull(row.base_longitude);
  if (lat === null || lon === null) return null;
  return { base: { lat, lon }, radiusKm: numberOrNull(row.base_radius_km) };
}

/** The form a saved base opens with. It counts as the operator's entry, so no proposal is written over it. */
export function baseFormFromSaved(saved: SavedBase): BaseForm {
  return {
    latText: formatCoordinate(saved.base.lat),
    lonText: formatCoordinate(saved.base.lon),
    radiusKm: saved.radiusKm ?? DEFAULT_RETURN_CHECK_SETTINGS.baseRadiusKm,
    edited: true,
  };
}

/** Whether the form says something other than what is saved — what the save button is for. */
export function baseFormDiffers(form: BaseForm, saved: SavedBase | null): boolean {
  const parsed = parseBase(form.latText, form.lonText);
  if (!parsed.base) return false;
  if (!saved) return true;
  const same = (a: number, b: number, places: number) => Math.round(a * 10 ** places) === Math.round(b * 10 ** places);
  return !(
    same(parsed.base.lat, saved.base.lat, 5) &&
    same(parsed.base.lon, saved.base.lon, 5) &&
    same(form.radiusKm, saved.radiusKm ?? DEFAULT_RETURN_CHECK_SETTINGS.baseRadiusKm, 1)
  );
}
