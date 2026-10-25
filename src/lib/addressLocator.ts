/**
 * Where an address becomes a point, and what that costs.
 *
 * The routing container (deploy/docker-compose.yml, service `osrm`) measures the
 * road between two POINTS. The Fahrtenbuch gives ADDRESSES: the Uber sheet has 18
 * columns and exactly one coordinate, "Standort des Fahrzeugs bei
 * Auftragsuebermittlung", which is where the vehicle was when the order arrived
 * and is neither the pickup nor the drop-off. So the travel check can only leave
 * "nicht prüfbar" once something turns "Konrad-Adenauer-Strasse 12, 42651
 * Solingen" into a point. This builds that something: the cache of the company,
 * then the geocode-address function (supabase/functions/geocode-address), then the
 * geocoder gateway of this stack (deploy/geocoder-gateway.conf), then the Nominatim
 * that ridy runs. What counts as a point is decided in
 * supabase/functions/_shared/geocode-core.ts: a house, for the number and the
 * postal code that were asked for, and nothing coarser.
 *
 * ## What was decided, by whom, and when
 *
 * The owner, on 22.10.2026: use the Nominatim ridy already runs on this host
 * (ridy-nominatim-1, image mediagis/nominatim:4.4, reached by its name on
 * ridy_default). Not a public geocoder: the addresses are passengers' and do not
 * leave the stack. Not one of our own: an import of Nordrhein-Westfalen was
 * designed first (about an hour of import, several gigabytes, a host script) and
 * dropped when the owner chose to share ridy's.
 *
 * ## What it costs, written here so that nobody has to discover it
 *
 * 1. Passengers' addresses are in ridy's request log. Their container logs with
 *    the json-file driver, so every address this feature asks for is in it, once.
 *    The owner accepted that for the operation of the feature. The feasibility
 *    probe of 22.10.2026 was a separate small debit against it: 47 requests, 17 real
 *    addresses of the May 2026 sheet and 3 public landmarks.
 * 2. It is theirs. They can rebuild it, upgrade it (a 5.x answer is another shape,
 *    and the parser reads a shape it does not know as bad_answer) or remove it. Our
 *    failure mode in each case is "nicht prüfbar" and never a guessed coordinate.
 *    Nothing of theirs is touched from here: no restart, no limit, no change; the
 *    gateway holds the restraint (5 requests a second, 2 in flight, only /search and
 *    /status) because they hold none.
 * 3. Its data is old and does not renew itself. Its /status said
 *    data_updated 2026-08-21 on 22.10.2026, although a replication URL is set: the
 *    claim that it keeps itself current was an inference from that setting and is
 *    wrong. A new building is missing from it. The data stamp is stored with every
 *    cached point.
 *
 * ## What it can place, and what it never will
 *
 * Of the 3,456 address cells of the May 2026 sheet 80.6 % are "Straße Nr, PLZ Ort,
 * Deutschland" and 2.0 % the same with a name in front: those can reach house
 * level. 11.6 % are a street without a number, 3.1 % a name and a street without a
 * number, 2.6 % a bare name (a station), 0.1 % other. A street does not have one
 * point, and a postal area even less: placing it would be the guess the
 * Fahrtenanalyse exists not to make (two addresses on one street are zero minutes
 * apart, so a pair would pass). So AT MOST about 83 % of the cells can be placed, a
 * ride needs both ends, and roughly a third of the rides stay "nicht prüfbar" by
 * design. That is not a defect to chase. It is what the sheet contains.
 *
 * What the geocoder did with 17 real addresses of that sheet (22.10.2026): all ten
 * plain addresses at house level with the number and postal code asked for; three of
 * four named ones at house level and one only at the street (that house number is
 * not in OpenStreetMap), which is refused; the three street-only ones at street,
 * square or hamlet level or not at all, refused. No query answered at postal-area
 * level.
 *
 * ## Switching it on, and the acceptance run
 *
 * Off unless the `travel_estimator` feature flag is on (locatorPlan.ts). It needs
 * the routing container, the geocoder gateway (COMPOSE_PROFILES names osrm and
 * geocoder) and the geocode_cache migration. The first real run after that IS the
 * acceptance run: each address is asked once and kept, and the placement report
 * (utils/travelRouting/placement.ts, over the cache and the trips, with no request
 * to anybody) says how many rides had both ends placed and which sheets' kilometres
 * are shorter than the straight line between the two placed points, which is either
 * a misplaced address or a bad cell. Nobody should run a month through ridy's
 * service a second time to see it again.
 */
import { createGeocodeCache, type GeocodeCacheDb } from './geocodeCache';
import { createGeocodeClient } from './geocodeClient';
import { supabase } from './supabase';
import { createGeocodingLocator } from '../utils/travelRouting/geocodingLocator';
import type { AddressLocator } from '../utils/travelRouting/prefetch';

export interface AppAddressLocatorOptions {
  readonly companyId: string;
  /** See locatorPlan.ts: an administrator of this company, and not a platform account. */
  readonly canWrite: boolean;
}

/** The locator of the running app: this company's cache and the real function. */
export function createAppAddressLocator(options: AppAddressLocatorOptions): AddressLocator {
  return createGeocodingLocator({
    client: createGeocodeClient(),
    cache: createGeocodeCache({
      db: supabase as unknown as GeocodeCacheDb,
      companyId: options.companyId,
      canWrite: options.canWrite,
    }),
  });
}
