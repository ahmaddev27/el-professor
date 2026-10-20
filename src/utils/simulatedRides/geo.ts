import type { GeoPoint } from './types';

const EARTH_RADIUS_KM = 6371.0088;

/** Straight line to driven distance. A German city street grid costs about a third more. */
export const ROAD_FACTOR = 1.3;

/** Time to find the customer after arriving at the pickup. */
export const PICKUP_HANDLING_SECONDS = 45;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function roadKm(a: GeoPoint, b: GeoPoint): number {
  return haversineKm(a, b) * ROAD_FACTOR;
}

/** Average city speed by local hour of day: slow in the rush hours, fast at night. */
export function citySpeedKmh(hour: number): number {
  if ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 19)) return 21;
  if (hour >= 22 || hour < 5) return 36;
  return 28;
}

/**
 * Seconds to drive an empty vehicle over `km` road kilometres. This is the one
 * definition of "how long does it take to get there": the generator derives
 * every gap from it and `validateRides` checks every gap against it.
 */
export function deadheadSeconds(km: number, hour: number): number {
  return Math.ceil(PICKUP_HANDLING_SECONDS + (km / citySpeedKmh(hour)) * 3600);
}

export function minTravelSeconds(from: GeoPoint, to: GeoPoint, hour: number): number {
  return deadheadSeconds(roadKm(from, to), hour);
}

/** A ride with a customer: longer trips reach faster roads. */
export function rideSeconds(km: number, hour: number): number {
  const speed = citySpeedKmh(hour) * (1 + Math.min(km, 30) / 45);
  return Math.ceil(120 + (km / speed) * 3600);
}

export function interpolate(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
  const f = Math.min(1, Math.max(0, fraction));
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}
