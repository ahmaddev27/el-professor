import { INFRASTRUCTURE_REASONS, type UnlocatedReason } from '../../../supabase/functions/_shared/geocode-core';
import type { GeocodeClient } from '../../lib/geocodeClient';
import type { GeoPoint } from './types';

/**
 * Where a simulated shift starts (FleetBook round 8, §3 and decision D7).
 *
 * Every shift leaves from the company's base. The base is chosen in this order,
 * and no other way:
 *
 * 1. The point an administrator saved in the Fahrtenanalyse
 *    (`trip_analysis_settings.base_latitude` / `base_longitude`).
 * 2. Otherwise, the company's address from Einstellungen (`company_settings`).
 *    It is geocoded at house level by our own geocoder and labelled as
 *    derived from the address.
 * 3. Otherwise `CONFIGURATION_REQUIRED`, and no month is generated.
 *
 * Until round 8 the screen fell back to the centre of the address pool. That
 * point is the average of whatever addresses the pool happened to hold, and
 * the company's vehicles do not stand there. It is not offered here in any
 * form. A street, a postal area or two houses that disagree are answers the
 * geocoder refuses, so they are refusals here too and never a coordinate.
 */

export type BaseSource = 'saved_point' | 'company_address';

export interface CompanyAddress {
  street?: string | null;
  house_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
}

export type BaseRefusal =
  /** No saved point and no address field at all. */
  | 'no_base_configured'
  /** An address with a field missing. `detail` names the missing fields. */
  | 'address_incomplete'
  /** The geocoder answered and the answer is not one house. `detail` is its reason. */
  | 'address_not_located'
  /** The geocoder could not answer. `detail` is why. */
  | 'geocoder_unavailable';

export type BaseResolution =
  | { ok: true; base: GeoPoint; source: BaseSource; label: string }
  | { ok: false; reason: BaseRefusal; detail: string | null };

/** How a base is named on a repositioning record and on the source sheet. Generated documents stay German. */
export const SAVED_POINT_LABEL = 'Betriebssitz (gespeicherter Punkt)';
const DERIVED_SUFFIX = ' (Betriebssitz aus der Firmenadresse abgeleitet)';

const ADDRESS_FIELDS = ['street', 'house_number', 'postal_code', 'city'] as const;

const trimmed = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '');

/** A saved point with both coordinates finite; anything else is no saved point. */
export function savedPoint(lat: unknown, lon: unknown): GeoPoint | null {
  if (lat === null || lat === undefined || lon === null || lon === undefined || lat === '' || lon === '') return null;
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? { lat: la, lon: lo } : null;
}

/** "Straße 12, 42651 Stadt": the shape the geocoder parses. Null when a field is missing. */
export function companyAddressText(address: CompanyAddress | null): { text: string } | { missing: string[] } {
  const values = Object.fromEntries(ADDRESS_FIELDS.map(f => [f, trimmed(address?.[f])])) as Record<(typeof ADDRESS_FIELDS)[number], string>;
  const missing = ADDRESS_FIELDS.filter(f => values[f] === '');
  if (missing.length > 0) return { missing };
  return { text: `${values.street} ${values.house_number}, ${values.postal_code} ${values.city}` };
}

export async function resolveBase(args: {
  saved: GeoPoint | null;
  address: CompanyAddress | null;
  geocoder: GeocodeClient;
}): Promise<BaseResolution> {
  if (args.saved) return { ok: true, base: args.saved, source: 'saved_point', label: SAVED_POINT_LABEL };
  const address = companyAddressText(args.address);
  if ('missing' in address) {
    const none = address.missing.length === ADDRESS_FIELDS.length;
    return none
      ? { ok: false, reason: 'no_base_configured', detail: null }
      : { ok: false, reason: 'address_incomplete', detail: address.missing.join(', ') };
  }
  const answer = await args.geocoder.geocode([{ id: 'company-base', text: address.text }]);
  if (!answer.ok) return { ok: false, reason: 'geocoder_unavailable', detail: answer.reason };
  const result = answer.results.find(r => r.id === 'company-base');
  if (!result) return { ok: false, reason: 'geocoder_unavailable', detail: 'bad_answer' };
  if (result.kind === 'unlocated') {
    const unavailable = INFRASTRUCTURE_REASONS.has(result.reason as UnlocatedReason);
    return { ok: false, reason: unavailable ? 'geocoder_unavailable' : 'address_not_located', detail: result.reason };
  }
  return {
    ok: true,
    base: { lat: result.lat, lon: result.lon },
    source: 'company_address',
    label: `${address.text}${DERIVED_SUFFIX}`,
  };
}
