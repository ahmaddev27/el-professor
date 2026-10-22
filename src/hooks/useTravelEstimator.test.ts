import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer, RoutePair } from '../../supabase/functions/_shared/travel-route-core';
import type { AnalysisTrip, TravelTimeEstimator } from '../utils/tripAnalysis/types';
import type { AddressLocator, TravelRouter } from '../utils/travelRouting/prefetch';
import { useTravelEstimator } from './useTravelEstimator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const BASE = new Date('2026-08-03T06:00:00').getTime();
const SETTINGS = { blockGapMinutes: 30, travelMarginMinutes: 5 };

function trip(id: string, startMin: number, endMin: number, pickup: string, dropoff: string): AnalysisTrip {
  return {
    id, driver_id: 'd1', driver_name: 'Fahrer', vehicle: 'X', start_ms: BASE + startMin * MIN, end_ms: BASE + endMin * MIN,
    status: 'completed', price: null, currency: null, source_row: null, pickup_address: pickup, dropoff_address: dropoff,
  };
}

const TRIPS = [trip('t1', 0, 30, 'P1', 'D1'), trip('t2', 40, 70, 'P2', 'D2')];

const locator: AddressLocator = {
  locate: async (addresses) => new Map(addresses.map((a, i) => [a, { kind: 'located' as const, point: { lat: 51 + i / 100, lon: 7 }, precision: 'exact' as const }])),
};

function routerWith(log: RoutePair[][]): TravelRouter {
  return {
    route: async (pairs): Promise<RouteBatchAnswer> => {
      log.push([...pairs]);
      return { ok: true, dataVersion: '2026-10-20T00:00:00Z', results: pairs.map((p) => ({ id: p.id, kind: 'route', durationSeconds: 600, distanceMeters: 4000, snapMeters: [4, 4] })) };
    },
  };
}

/** A router that answers only when `open()` is called, so the interval before an answer can be looked at. */
function gatedRouter(log: RoutePair[][]) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const inner = routerWith(log);
  const router: TravelRouter = { route: async (pairs) => { await gate; return inner.route(pairs); } };
  return { router, open: () => open() };
}

interface Probe { estimator: TravelTimeEstimator | undefined }
const probe: Probe = { estimator: undefined };

function Harness(props: { trips: readonly AnalysisTrip[]; settings: typeof SETTINGS | null; locator: AddressLocator | null; router: TravelRouter }) {
  probe.estimator = useTravelEstimator(props.trips, props.settings, { locator: props.locator, router: props.router });
  return null;
}

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

async function mount(props: Parameters<typeof Harness>[0]) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Harness, props)); });
  return renderer;
}

describe('useTravelEstimator', () => {
  it('is undefined, and asks nobody, while no locator exists: the analysis keeps saying nicht prüfbar', async () => {
    const calls: RoutePair[][] = [];
    await mount({ trips: TRIPS, settings: SETTINGS, locator: null, router: routerWith(calls) });
    await settle();
    expect(probe.estimator).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('is undefined without settings, because the analysis does not run without them either', async () => {
    const calls: RoutePair[][] = [];
    await mount({ trips: TRIPS, settings: null, locator, router: routerWith(calls) });
    await settle();
    expect(probe.estimator).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('prefetches the pairs the engine will ask about and then answers them', async () => {
    const calls: RoutePair[][] = [];
    const gated = gatedRouter(calls);
    await mount({ trips: TRIPS, settings: SETTINGS, locator, router: gated.router });
    expect(probe.estimator).toBeUndefined();
    gated.open();
    await settle();
    expect(calls).toHaveLength(1);
    expect(probe.estimator?.source).toBe('osrm@2026-10');
    const answer = probe.estimator?.estimate({ fromTripId: 't1', toTripId: 't2', fromAddress: 'D1', toAddress: 'P2', departureMs: 0 });
    expect(answer).toMatchObject({ kind: 'estimated', minutes: 10 });
  });

  it('does not hand a month the estimates of the month before: new trips wait for their own', async () => {
    const first = routerWith([]);
    const renderer = await mount({ trips: TRIPS, settings: SETTINGS, locator, router: first });
    await settle();
    expect(probe.estimator).toBeDefined();
    const other = [trip('u1', 0, 30, 'Q1', 'E1'), trip('u2', 40, 70, 'Q2', 'E2')];
    const second = gatedRouter([]);
    await act(async () => { renderer.update(createElement(Harness, { trips: other, settings: SETTINGS, locator, router: second.router })); });
    expect(probe.estimator).toBeUndefined();
    second.open();
    await settle();
    expect(probe.estimator?.estimate({ fromTripId: 'u1', toTripId: 'u2', fromAddress: 'E1', toAddress: 'Q2', departureMs: 0 }).kind).toBe('estimated');
    expect(probe.estimator?.estimate({ fromTripId: 't1', toTripId: 't2', fromAddress: 'D1', toAddress: 'P2', departureMs: 0 })).toMatchObject({ reason: 'not_prefetched' });
  });

  it('asks again for nothing when the trips are the same trips under a new array', async () => {
    const calls: RoutePair[][] = [];
    const router = routerWith(calls);
    const renderer = await mount({ trips: TRIPS, settings: SETTINGS, locator, router });
    await settle();
    await act(async () => { renderer.update(createElement(Harness, { trips: [...TRIPS], settings: { ...SETTINGS }, locator, router })); });
    await settle();
    expect(calls).toHaveLength(1);
    expect(probe.estimator).toBeDefined();
  });

  it('ignores the answer of a prefetch that was superseded', async () => {
    let release: (() => void) | null = null;
    const slow: AddressLocator = {
      locate: async (addresses) => {
        if (addresses.includes('P1')) await new Promise<void>((resolve) => { release = resolve; });
        return locator.locate(addresses);
      },
    };
    const calls: RoutePair[][] = [];
    const router = routerWith(calls);
    const renderer = await mount({ trips: TRIPS, settings: SETTINGS, locator: slow, router });
    const other = [trip('u1', 0, 30, 'Q1', 'E1'), trip('u2', 40, 70, 'Q2', 'E2')];
    await act(async () => { renderer.update(createElement(Harness, { trips: other, settings: SETTINGS, locator: slow, router })); });
    await settle();
    await act(async () => { release?.(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(probe.estimator?.estimate({ fromTripId: 'u1', toTripId: 'u2', fromAddress: 'E1', toAddress: 'Q2', departureMs: 0 }).kind).toBe('estimated');
    expect(probe.estimator?.estimate({ fromTripId: 't1', toTripId: 't2', fromAddress: 'D1', toAddress: 'P2', departureMs: 0 })).toMatchObject({ reason: 'not_prefetched' });
  });
});
