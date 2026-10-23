import { describe, expect, it } from 'vitest';
import type { RouteResult } from '../../../supabase/functions/_shared/travel-route-core';
import { MAX_SNAP_METERS, estimateFromRoute, osrmSourceLabel, type EstimateContext } from './estimate';

const CONTEXT: EstimateContext = {
  source: 'osrm@2026-10',
  computedAt: '2026-10-22T08:00:00.000Z',
  fromPrecision: 'exact',
  toPrecision: 'exact',
};

const route = (over: Partial<Extract<RouteResult, { kind: 'route' }>> = {}): RouteResult => ({
  id: 'a>b',
  kind: 'route',
  durationSeconds: 612,
  distanceMeters: 4210,
  snapMeters: [8, 32],
  ...over,
});

describe('osrmSourceLabel', () => {
  it('names the month of the map data, as the estimate contract documents it', () => {
    expect(osrmSourceLabel('2026-10-20T23:29:32Z')).toBe('osrm@2026-10');
    expect(osrmSourceLabel('2026-01-01T00:00:00Z')).toBe('osrm@2026-01');
  });

  it.each([null, undefined, '', 'yesterday', '26-10-20', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z'])(
    'names no month when the data does not say one (%s)',
    (version) => {
      expect(osrmSourceLabel(version)).toBe('osrm');
    },
  );
});

describe('estimateFromRoute', () => {
  it('turns the road time into minutes, exactly and without rounding, and carries who computed it and when', () => {
    expect(estimateFromRoute(route(), CONTEXT)).toEqual({
      kind: 'estimated',
      minutes: 612 / 60,
      source: 'osrm@2026-10',
      confidence: 'medium',
      computedAt: '2026-10-22T08:00:00.000Z',
    });
  });

  it('is medium at best: a driving time without traffic is a model, never a measurement', () => {
    const answer = estimateFromRoute(route(), CONTEXT);
    expect(answer.kind === 'estimated' && answer.confidence).toBe('medium');
  });

  it('is low as soon as either address was placed only approximately', () => {
    for (const precision of [{ fromPrecision: 'approximate' }, { toPrecision: 'approximate' }] as const) {
      const answer = estimateFromRoute(route(), { ...CONTEXT, ...precision });
      expect(answer.kind === 'estimated' && answer.confidence).toBe('low');
    }
  });

  it('takes two points on the same spot as a drive of no minutes, not as an unknown', () => {
    const answer = estimateFromRoute(route({ durationSeconds: 0, distanceMeters: 0 }), CONTEXT);
    expect(answer).toMatchObject({ kind: 'estimated', minutes: 0 });
  });

  it('believes a point up to the limit from the road and refuses one beyond it', () => {
    const at = estimateFromRoute(route({ snapMeters: [MAX_SNAP_METERS, 0] }), CONTEXT);
    expect(at.kind).toBe('estimated');
    for (const snapMeters of [[MAX_SNAP_METERS + 0.1, 0], [0, MAX_SNAP_METERS + 0.1]] as const) {
      expect(estimateFromRoute(route({ snapMeters }), CONTEXT)).toEqual({
        kind: 'unavailable',
        source: 'osrm@2026-10',
        reason: 'too_far_from_road',
      });
    }
  });

  it('passes a failure on as unavailable with its own reason, and never a minute count', () => {
    const failed: RouteResult = { id: 'a>b', kind: 'unavailable', reason: 'no_route' };
    expect(estimateFromRoute(failed, CONTEXT)).toEqual({ kind: 'unavailable', source: 'osrm@2026-10', reason: 'no_route' });
  });
});
