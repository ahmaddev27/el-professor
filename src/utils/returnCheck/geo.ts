/**
 * Straight lines between two coordinates, and nothing more.
 *
 * Every distance this module answers is a great-circle distance — the line a
 * crow would fly — and the screen says "Luftlinie" beside it. It is never a
 * road distance and never stands in for one: it is used to say whether a
 * vehicle was near its Betriebssitz, where a straight line is the honest
 * measure, and nowhere else.
 */
import type { LatLon } from './types';

const EARTH_RADIUS_KM = 6371.0088;

export function distanceKm(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Germany's bounding box, slightly generous. A coordinate outside it is not a
 * position in a German Fahrtenbuch — most often latitude and longitude
 * swapped, or 0 0 — and is reported rather than measured.
 */
export function isInGermany(p: LatLon): boolean {
  return p.lat >= 47.2 && p.lat <= 55.1 && p.lon >= 5.8 && p.lon <= 15.1;
}
