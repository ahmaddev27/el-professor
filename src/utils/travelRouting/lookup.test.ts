import { describe, expect, it } from 'vitest';
import type { TravelEstimate, TravelEstimateRequest } from '../tripAnalysis/types';
import { createLookupEstimator, pairKey } from './lookup';

const request = (from: string, to: string): TravelEstimateRequest => ({
  fromTripId: from,
  toTripId: to,
  fromAddress: 'A-Strasse 1, 42651 Solingen, Deutschland',
  toAddress: 'B-Strasse 2, 42651 Solingen, Deutschland',
  departureMs: 0,
});

const eleven: TravelEstimate = { kind: 'estimated', minutes: 11, source: 'osrm@2026-10', confidence: 'medium', computedAt: '2026-10-22T08:00:00.000Z' };

describe('createLookupEstimator', () => {
  it('names its source, which the analysis stores beside every result', () => {
    expect(createLookupEstimator('osrm@2026-10', new Map()).source).toBe('osrm@2026-10');
  });

  it('answers the estimate that was prefetched for exactly this pair of trips', () => {
    const lookup = createLookupEstimator('osrm@2026-10', new Map([[pairKey('t1', 't2'), eleven]]));
    expect(lookup.estimate(request('t1', 't2'))).toBe(eleven);
  });

  it('knows the direction: t2 after t1 is another question than t1 after t2', () => {
    const lookup = createLookupEstimator('osrm@2026-10', new Map([[pairKey('t1', 't2'), eleven]]));
    expect(lookup.estimate(request('t2', 't1'))).toEqual({ kind: 'unavailable', source: 'osrm@2026-10', reason: 'not_prefetched' });
  });

  it('never invents an answer for a pair it was not given', () => {
    const lookup = createLookupEstimator('osrm@2026-10', new Map());
    const answer = lookup.estimate(request('x', 'y'));
    expect(answer).toEqual({ kind: 'unavailable', source: 'osrm@2026-10', reason: 'not_prefetched' });
  });

  it('keeps a failed lookup as the failure it was', () => {
    const failed: TravelEstimate = { kind: 'unavailable', source: 'osrm', reason: 'timeout' };
    const lookup = createLookupEstimator('osrm', new Map([[pairKey('t1', 't2'), failed]]));
    expect(lookup.estimate(request('t1', 't2'))).toEqual(failed);
  });
});

describe('pairKey', () => {
  it('cannot confuse two different pairs', () => {
    expect(pairKey('a', 'b')).not.toBe(pairKey('b', 'a'));
    expect(pairKey('a>b', 'c')).not.toBe(pairKey('a', 'b>c'));
  });
});
