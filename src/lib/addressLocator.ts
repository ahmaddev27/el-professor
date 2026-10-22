/**
 * Where an address becomes a point, and why nothing is plugged in yet.
 *
 * The routing container (deploy/docker-compose.yml, service `osrm`) measures the
 * road between two POINTS. The Fahrtenbuch gives ADDRESSES: the Uber sheet has
 * 18 columns and exactly one coordinate, "Standort des Fahrzeugs bei
 * Auftragsuebermittlung", which is where the vehicle was when the order arrived
 * and is neither the pickup nor the drop-off. So the travel check can only
 * leave "nicht prüfbar" once something turns "Konrad-Adenauer-Strasse 12, 42651
 * Solingen" into a point. That something is an AddressLocator
 * (src/utils/travelRouting/prefetch.ts), and this is the one place the app
 * would name it. It is `null`, and with `null` the Fahrtenanalyse behaves
 * exactly as it did before the routing container existed: no request is made,
 * every travel check stays unverifiable, and `travelEstimatorSource` stays `none`.
 *
 * ## Why none is shipped
 *
 * A locator is a decision, and each way of making one has a price the owner
 * has not been asked about:
 *
 * - **A public geocoder (Nominatim's public instance, or any other).** The
 *   addresses are passengers'. Sending them to a third party is a data
 *   protection decision, and the public Nominatim's policy is about one request
 *   a second (src/utils/simulatedRides/addressPool.ts spaces its requests by
 *   1.1 s for that reason). The sample month in the repository root is 2,376
 *   rides and 3,944 distinct addresses: 72 minutes per fleet per month.
 * - **A Nominatim of our own.** The honest shape, in the same pattern as the
 *   routing container: a service on our network, off unless asked for, never
 *   called from the browser. It is a PostgreSQL import. For scale: the Nominatim
 *   that ridy runs on this host holds 106 GB of data, against 14.8 GB for its OSRM.
 * - **A postal-code table.** Free, and wrong: a postal area is kilometres wide, so
 *   two addresses in one area would be zero minutes apart and a pair would
 *   "pass" on a guess. That is the one outcome this feature exists to avoid.
 *
 * ## How to know a locator is good enough
 *
 * Every completed ride in the sheet carries the kilometres it was charged. A
 * locator and the router together are good enough when the routed distance
 * between a ride's pickup and drop-off agrees with that column across a month
 * of rides; the rides that do not agree are the addresses to look at. That is
 * the acceptance test, and it uses nothing that is not already in the file.
 */
import type { AddressLocator } from '../utils/travelRouting/prefetch';

export const addressLocator: AddressLocator | null = null;
