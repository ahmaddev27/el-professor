/**
 * From what the routing container measured to what the Fahrtenanalyse may call
 * an estimate. This is the judgement; the function and the container only
 * report facts (supabase/functions/_shared/travel-route-core.ts).
 *
 * ## What an estimate here is, and is not
 *
 * OSRM answers the time a car needs on an empty road, from the speeds its car
 * profile assigns to each kind of road. It knows nothing of the rush hour, of
 * the weather or of the time of day, so `departureMs` of the request is not
 * sent: a time of day would only pretend to matter. The minutes are therefore a
 * floor and a model, `confidence` never rises above 'medium', and the existing
 * rule (travel.ts: required = estimate + travelMarginMinutes) is where the
 * company's own buffer for traffic lives. This module adds nothing to the
 * minutes and does not re-derive that rule.
 *
 * ## Straight lines stay straight lines
 *
 * A road distance from here is a second, labelled figure. It never replaces
 * what returnCheck/geo.ts prints as "Luftlinie": that module answers whether a
 * vehicle was near its Betriebssitz, where a straight line is the honest
 * measure, and says so in its header.
 */
import type { Confidence, TravelEstimate } from '../tripAnalysis/types';
import type { RouteResult } from '../../../supabase/functions/_shared/travel-route-core';

/** How sure the address locator is of the point it returned (the port is in prefetch.ts). */
export type AddressPrecision = 'exact' | 'approximate';

/**
 * A located address further than this from the nearest road is not believed.
 *
 * OSRM always snaps a point to the nearest road, however far away, and says
 * how far in `snapMeters`. A building's point sits a few tens of metres from its
 * street; a point hundreds of metres from any road is a wrong geocode, a rural
 * address or the middle of a park, and a drive time computed from the road end
 * of that jump says nothing about the address. This is a plausibility bound
 * and not a measurement: no real data has been used to tune it, it is the only
 * place it is written, and the tests pin the boundary (a point at exactly the
 * limit is believed). Beyond it the pair is unavailable, which the Fahrtenanalyse
 * shows as "nicht prüfbar" and never as "passed".
 */
export const MAX_SNAP_METERS = 250;

const SOURCE_PREFIX = 'osrm';

/** `osrm@2026-10` from the OSM timestamp of the map data; plain `osrm` when the data does not say. */
export function osrmSourceLabel(dataVersion: string | null | undefined): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}/.exec(dataVersion ?? '');
  return match ? `${SOURCE_PREFIX}@${match[1]}-${match[2]}` : SOURCE_PREFIX;
}

export interface EstimateContext {
  readonly source: string;
  /** ISO 8601, when the routing was asked. */
  readonly computedAt: string;
  readonly fromPrecision: AddressPrecision;
  readonly toPrecision: AddressPrecision;
}

function confidenceOf(context: EstimateContext): Confidence {
  return context.fromPrecision === 'exact' && context.toPrecision === 'exact' ? 'medium' : 'low';
}

/** One routing result as an estimate: a number only where OSRM measured one and both points sit on the road. */
export function estimateFromRoute(result: RouteResult, context: EstimateContext): TravelEstimate {
  if (result.kind === 'unavailable') return { kind: 'unavailable', source: context.source, reason: result.reason };
  if (result.snapMeters.some((snap) => snap > MAX_SNAP_METERS)) {
    return { kind: 'unavailable', source: context.source, reason: 'too_far_from_road' };
  }
  return {
    kind: 'estimated',
    minutes: result.durationSeconds / 60,
    source: context.source,
    confidence: confidenceOf(context),
    computedAt: context.computedAt,
  };
}
