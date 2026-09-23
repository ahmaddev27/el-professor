/**
 * Trip analysis engine (Fahrtenbuch analysis, slice B). It reads and reports;
 * it never reassigns a trip, shifts a time, cuts a trip or changes a price.
 * The contract is in ./types.ts.
 */
export * from './types';
export { analyzeTrips } from './analyze';
export { computeBudget, splitMinutes } from './budget';
export { analysisTripFromRow } from './adapter';
export { noRoutingEstimator, listTravelRequests } from './travel';
