/**
 * Invented rows, shaped like the tables the screens read.
 *
 * The vehicles and drivers are the design preview's own (src/design-preview/
 * sampleData.ts), so a converted Fahrzeuge screen can be laid beside the
 * approved prototype screenshots and compared row for row. The fixed costs are
 * new; the preview had none. Nothing here is a real company.
 */
import { PREVIEW_DRIVERS, PREVIEW_VEHICLES } from '../src/design-preview/sampleData';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID } from './scenario';

export type Row = Record<string, unknown>;

const CREATED_AT = '2026-01-12T08:30:00+00:00';

export function carsRows(): Row[] {
  return PREVIEW_VEHICLES.map(vehicle => ({
    id: vehicle.id,
    company_id: HARNESS_COMPANY_ID,
    kennzeichen: vehicle.plate,
    tuev_gueltig_bis: vehicle.tuevValidUntil,
    letzte_hu: vehicle.lastHu,
    status: 'active',
    created_by: HARNESS_USER_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
}

export function driversRows(): Row[] {
  return PREVIEW_DRIVERS.map(driver => ({
    id: driver.id,
    company_id: HARNESS_COMPANY_ID,
    name: driver.name,
    status: 'active',
  }));
}

export function assignmentRows(): Row[] {
  return PREVIEW_VEHICLES.flatMap(vehicle =>
    vehicle.driverIds.map(driverId => ({
      id: `${vehicle.id}-${driverId}`,
      company_id: HARNESS_COMPANY_ID,
      car_id: vehicle.id,
      driver_id: driverId,
      created_by: HARNESS_USER_ID,
      drivers: { id: driverId, name: PREVIEW_DRIVERS.find(driver => driver.id === driverId)?.name ?? driverId },
    })),
  );
}

/** A small fleet's standing monthly costs; the amounts are the column's unit, euros. */
export function fixedCostRows(): Row[] {
  const costs: Array<[string, number]> = [
    ['Kfz-Versicherung Flotte', 2184.37],
    ['Miete Stellplätze Hof', 1250],
    ['Buchhaltung und Steuerberatung', 650],
    ['Funkzentrale Taxi-Ruf', 420],
    ['Taxameter-Wartung', 89.9],
    ['Telefon und Internet', 64.99],
  ];
  return costs.map(([description, amount], index) => ({
    id: `fc-${index + 1}`,
    company_id: HARNESS_COMPANY_ID,
    description,
    amount,
    created_by: HARNESS_USER_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
}
