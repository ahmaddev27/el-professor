import type { DriverPlanningFacts } from '../../lib/simulationInputsClient';
import type { CompanySimulationSettings } from '../../lib/simulationSettingsClient';
import type { WerkstattCheckRow } from '../constraintDecisionLog';
import type { StructuredNote } from '../monatsplanungPhase3';
import type { BaseSource } from './baseSelection';
import type { CalendarFormResult } from './calendarForm';
import type { FullMonthInput, RoutingProvenance, SettingsSource } from './fullMonth';
import { readRealTrips, type RealTripDriverRef, type RealTripRow } from './realTrips';
import { resolveSettings } from './tenantSettings';
import type { TravelModel } from './travelModel';
import type { GeoPoint, PoolAddress } from './types';
import type { UberMonthImport } from './uberImport';
import { readUnavailability, type VehicleUnavailabilityRow } from './vehicleAvailability';

/**
 * The calendar month's input, built from what was loaded. One function, so the
 * `Fahrten simulieren` screen and `scripts/fleetbook-round8-month.mts` hand the
 * generator the same thing: a script that rebuilt this mapping would be a
 * second planner that only resembles the screen's, and its example months
 * would prove nothing about the screen.
 */

export interface CalendarCar { id: string; plate: string; tuev: string | null }

/** The Betriebssitz an administrator saved in `trip_analysis_settings`, or null when either half is missing. */
export function savedBasePoint(row: { base_latitude?: number | string | null; base_longitude?: number | string | null } | null): GeoPoint | null {
  const lat = Number(row?.base_latitude);
  const lon = Number(row?.base_longitude);
  return row?.base_latitude != null && row?.base_longitude != null && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export interface CalendarDriver { id: string; name: string }

/** Everything read for the month besides the cars, the drivers and the base. */
export interface CalendarEvents {
  notes: Map<string, StructuredNote[]>;
  facts: Map<string, DriverPlanningFacts>;
  checks: WerkstattCheckRow[];
  unavailability: VehicleUnavailabilityRow[];
  uber: UberMonthImport | null;
  /** The month's real trips and the drivers they name (Round 8, §4). */
  realTrips: { rows: RealTripRow[]; drivers: RealTripDriverRef[] } | null;
  /** The company's simulation settings as stored now (Round 8, S8). */
  simulation: CompanySimulationSettings | null;
}

/** The pool a run draws from and the model that times it. `travel` absent is the labelled estimate. */
export interface CalendarSourcing {
  points: readonly PoolAddress[];
  travel: TravelModel | undefined;
  provenance: RoutingProvenance | null;
  estimate: boolean;
}

export interface CalendarRunArgs {
  year: number;
  month: number;
  seed: number;
  tenantId: string;
  base: { point: GeoPoint; source: BaseSource; label: string };
  /** The fleet, and the ids of the cars chosen for the month. */
  cars: readonly CalendarCar[];
  carIds: readonly string[];
  drivers: readonly CalendarDriver[];
  events: CalendarEvents;
  sourcing: CalendarSourcing;
  /** A form `parseCalendarForm` accepted. */
  form: Extract<CalendarFormResult, { ok: true }>;
  /** Where `events.simulation` came from; the screen always reads the company's. */
  settingsSource?: SettingsSource;
}

export function calendarMonthInput(a: CalendarRunArgs): FullMonthInput {
  // Real trips are kept as read and their driver-days are not simulated
  // over; their operating day is cut the way the month's settings cut it.
  const cut = resolveSettings(a.form.settings);
  const realTrips = a.events.realTrips && cut.ok
    ? readRealTrips({ year: a.year, month: a.month, ...a.events.realTrips, timeZone: cut.settings.timeZone, operatingDayStartHour: cut.settings.operatingDayStartHour })
    : undefined;
  return {
    year: a.year, month: a.month, base: a.base.point, baseSource: a.base.source, baseLabel: a.base.label, pool: a.sourcing.points, seed: a.seed,
    vehicles: a.cars.filter(c => a.carIds.includes(c.id)).map(c => ({ id: c.id, plate: c.plate, type: 'Mietwagen', tuev_gueltig_bis: c.tuev })),
    // A driver whose row could not be read has no hours range, so he is
    // reported as CONFIGURATION_REQUIRED rather than planned on a guess.
    drivers: a.drivers.map(d => {
      const f = a.events.facts.get(d.id);
      return {
        id: d.id, name: d.name, status: f?.status ?? null, employment_type: f?.employment_type ?? null,
        allowed_weekdays: f?.allowed_weekdays ?? null, planning_enabled: f?.planning_enabled ?? true,
        work_window_start: f?.work_window_start ?? null, work_window_end: f?.work_window_end ?? null,
        is_full_day_available: f?.is_full_day_available ?? null,
        planning_min_salary: f?.planning_min_salary ?? null, planning_max_salary: f?.planning_max_salary ?? null,
        planning_hourly_rate: f?.planning_hourly_rate ?? null, salary_ratio: f?.salary_ratio ?? null,
        planning_target_salary: f?.planning_target_salary ?? null,
        target_monthly_hours: f?.target_monthly_hours ?? null, max_monthly_hours: f?.max_monthly_hours ?? null,
      };
    }),
    driverNotesMap: a.events.notes, werkstattChecks: a.events.checks,
    vehicleUnavailability: readUnavailability(a.events.unavailability), uber: a.events.uber ?? undefined, realTrips,
    // Section 5's share on the imported umsatz, computed and never booked,
    // at the company's stored rate. None stored is `share_not_configured`
    // in the report, never a rate made up here. The return to the base is
    // off unless the company turned it on (D8).
    shareSetting: a.events.simulation?.shareSetting ?? null,
    returnToBase: a.events.simulation?.returnToBase ?? false,
    settingsSource: a.settingsSource ?? 'company_settings',
    settings: a.form.settings, options: a.form.options, shiftsPerVehicleDay: a.form.shiftsPerVehicleDay,
    travel: a.sourcing.travel, routing: a.sourcing.provenance ?? undefined, tenantId: a.tenantId,
  };
}
