/**
 * The routing container, asked for real.
 *
 * Skipped unless OSRM_URL names a running osrm-routed (CI starts the pinned image
 * the way docker-compose.yml does, on a small extract, and points this at it;
 * nothing here runs against a customer's data, there is none). What it proves is
 * what no stub can: that the answer OSRM really gives is the shape
 * supabase/functions/_shared/travel-route-core.ts reads, that the flags in the
 * compose file are the ones in force, and how far the straight-line estimate
 * the product used to have (src/utils/simulatedRides/geo.ts: haversine times
 * 1.3 at a city speed) is from a measured road.
 *
 *   OSRM_URL           http://host:port of osrm-routed
 *   OSRM_LIVE_CENTER   "lat,lon" the pairs are drawn around; default Solingen
 *   OSRM_LIVE_RADIUS_KM  how far from the centre an origin may be; default 8
 *   OSRM_LIVE_PAIRS    pairs per distance band; default 60
 *
 * The pairs are invented (a seeded generator, so the same extract gives the same
 * table), not taken from any ride: a taxi's real pairs are passengers' places.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  interpretOsrmAnswer,
  routePairs,
  type GeoPoint,
  type RoutePair,
  type RouteResult,
} from '../../supabase/functions/_shared/travel-route-core';
import { MAX_SNAP_METERS, estimateFromRoute } from '../../src/utils/travelRouting/estimate';
import { ROAD_FACTOR, driveSeconds, haversineKm } from '../../src/utils/simulatedRides/geo';

const url = process.env.OSRM_URL ?? '';
const [centerLat, centerLon] = (process.env.OSRM_LIVE_CENTER ?? '51.1657,7.0671').split(',').map(Number);
const CENTER: GeoPoint = { lat: centerLat, lon: centerLon };
const RADIUS_KM = Number(process.env.OSRM_LIVE_RADIUS_KM ?? 8);
const PER_BAND = Number(process.env.OSRM_LIVE_PAIRS ?? 60);

const options = () => ({
  fetchFn: fetch,
  baseUrl: url,
  timeoutMs: 10_000,
  concurrency: 8,
  deadlineMs: 120_000,
  now: () => Date.now(),
});

/** mulberry32: small, seedable, good enough to draw points. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KM_PER_DEGREE = 111.32;
function offset(from: GeoPoint, km: number, bearing: number): GeoPoint {
  const dLat = (km * Math.cos(bearing)) / KM_PER_DEGREE;
  const dLon = (km * Math.sin(bearing)) / (KM_PER_DEGREE * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lon: from.lon + dLon };
}

/** Straight-line distance bands, in km. A taxi's gap between two rides is mostly in the first three. */
const BANDS: ReadonlyArray<readonly [number, number]> = [[0.5, 1], [1, 2], [2, 5], [5, 10], [10, 20]];

function candidate(random: () => number, low: number, high: number, index: number): RoutePair {
  const radius = RADIUS_KM * Math.sqrt(random());
  const origin = offset(CENTER, radius, random() * 2 * Math.PI);
  const km = low + random() * (high - low);
  return { id: `${low}-${high}#${index}`, from: origin, to: offset(origin, km, random() * 2 * Math.PI) };
}

type Route = Extract<RouteResult, { kind: 'route' }>;
interface Measured {
  readonly pair: RoutePair;
  readonly route: Route;
  /** Between the points as asked for, in km. */
  readonly straightKm: number;
}

/** A pair the road network can be held to: both points within 100 m of a road. */
const wellPlaced = (result: RouteResult): result is Route =>
  result.kind === 'route' && result.snapMeters.every((snap) => snap <= 100) && result.distanceMeters > 0;

async function collect(band: number): Promise<Measured[]> {
  const [low, high] = BANDS[band];
  const random = generator(1000 + band);
  const kept: Measured[] = [];
  let tried = 0;
  while (kept.length < PER_BAND && tried < PER_BAND * 20) {
    const batch = Array.from({ length: 100 }, (_, i) => candidate(random, low, high, tried + i));
    tried += batch.length;
    const { results } = await routePairs(batch, options());
    results.forEach((result, i) => {
      if (kept.length < PER_BAND && wellPlaced(result)) kept.push({ pair: batch[i], route: result, straightKm: haversineKm(batch[i].from, batch[i].to) });
    });
  }
  return kept;
}

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const spread = (values: readonly number[], digits = 2): string =>
  `${quantile(values, 0.5).toFixed(digits)} [${quantile(values, 0.1).toFixed(digits)} to ${quantile(values, 0.9).toFixed(digits)}]`;

/** The product's old estimate of a drive of this pair at 14:00: haversine x 1.3 km at the city speed of that hour. */
const modelMinutes = (m: Measured): number => driveSeconds(m.straightKm * ROAD_FACTOR, 14) / 60;

function tableRow(label: string, rows: readonly Measured[]): string {
  const roadFactor = rows.map((m) => m.route.distanceMeters / 1000 / m.straightKm);
  const distanceVsModel = rows.map((m) => m.route.distanceMeters / 1000 / (m.straightKm * ROAD_FACTOR));
  const minutes = rows.map((m) => m.route.durationSeconds / 60);
  const minutesVsModel = rows.map((m) => m.route.durationSeconds / 60 / modelMinutes(m));
  return `| ${label} | ${rows.length} | ${spread(roadFactor)} | ${spread(distanceVsModel)} | ${quantile(minutes, 0.5).toFixed(1)} | ${quantile(rows.map(modelMinutes), 0.5).toFixed(1)} | ${spread(minutesVsModel)} |`;
}

function table(bands: readonly Measured[][]): string {
  const head = [
    '| straight line | pairs | OSRM road km / straight km (median [p10 to p90]) | OSRM km / (straight km x 1.3) | OSRM minutes (median) | old model minutes at 14:00 (median) | OSRM minutes / old model minutes |',
    '|---|---|---|---|---|---|---|',
  ];
  const rows = bands.map((rows, i) => tableRow(`${BANDS[i][0]} to ${BANDS[i][1]} km`, rows));
  return [...head, ...rows, tableRow('all', bands.flat())].join('\n');
}

describe.skipIf(url === '')('the routing container, live', () => {
  it('answers in the shape the parser reads, and says which map it holds', async () => {
    const batch = Array.from({ length: 30 }, (_, i) => candidate(generator(7), 1, 3, i));
    const started = Date.now();
    const outcome = await routePairs(batch, options());
    console.log(`30 routes in ${Date.now() - started} ms through routePairs, ${outcome.results.filter((r) => r.kind === 'route').length} answered with a route`);
    expect(outcome.results.filter((r) => r.kind === 'route').length).toBeGreaterThan(15);
    expect(outcome.dataVersion).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    console.log(`data_version: ${outcome.dataVersion}`);
  });

  it('holds the road to the straight line: the road plus the two moves onto it is never shorter than the line', async () => {
    const rows = (await collect(2)).slice(0, 40);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const m of rows) {
      const snapKm = (m.route.snapMeters[0] + m.route.snapMeters[1]) / 1000;
      expect(m.route.distanceMeters / 1000 + snapKm).toBeGreaterThanOrEqual(m.straightKm * 0.995);
      expect(m.route.durationSeconds).toBeGreaterThan(0);
    }
  });

  it('refuses a third coordinate, which is the flag in the compose file doing its work', async () => {
    const response = await fetch(`${url}/route/v1/driving/${CENTER.lon},${CENTER.lat};${CENTER.lon + 0.01},${CENTER.lat};${CENTER.lon + 0.02},${CENTER.lat}?overview=false`);
    const body: unknown = await response.json();
    expect(response.status).toBe(400);
    expect(interpretOsrmAnswer(response.status, body)).toEqual({ kind: 'unavailable', reason: 'request_rejected' });
  });

  it.skipIf(!process.env.OSRM_LIVE_OUTSIDE)('never turns a point outside the map into an estimate', async () => {
    const [lat, lon] = (process.env.OSRM_LIVE_OUTSIDE ?? '').split(',').map(Number);
    const pair: RoutePair = { id: 'outside', from: CENTER, to: { lat, lon } };
    const { results } = await routePairs([pair], options());
    const estimate = estimateFromRoute(results[0], { source: 'osrm', computedAt: new Date().toISOString(), fromPrecision: 'exact', toPrecision: 'exact' });
    console.log(`outside the map: ${JSON.stringify(results[0])} -> ${estimate.kind}${estimate.kind === 'unavailable' ? ` (${estimate.reason})` : ''}; the limit is ${MAX_SNAP_METERS} m`);
    expect(estimate.kind).toBe('unavailable');
  });

  it('measures how far the old straight-line estimate was from the road, by distance band', async () => {
    const bands: Measured[][] = [];
    for (let band = 0; band < BANDS.length; band += 1) bands.push(await collect(band));
    const text = table(bands);
    console.log(`\n${text}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### OSRM against the old estimate (haversine x ${ROAD_FACTOR})\n\n${text}\n\n`);
    }
    for (const rows of bands) expect(rows.length).toBeGreaterThanOrEqual(10);
  }, 600_000);
});
