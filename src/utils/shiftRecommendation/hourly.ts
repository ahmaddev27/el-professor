/**
 * The profile pooled into hours, for the screen's weekday × hour grid.
 *
 * A screen helper rather than screen code, so the grid and the planner read one
 * set of rules: only cells that carry a rate are pooled, exactly the cells the
 * planner may use, and an hour none of whose slots has enough evidence shows
 * nothing rather than a zero.
 */
import type { DayType, DemandProfile } from './types';

export interface HourCell {
  readonly dayType: DayType;
  /** 0-based hour within the operating day. */
  readonly hourIndex: number;
  /** Local clock hour 0–23 the cell starts at. */
  readonly clockHour: number;
  /** null when none of the hour's slots carries a rate. */
  readonly revenuePerHourCents: number | null;
  readonly vehicleMinutes: number;
}

/** 7 × 24 cells, by dayType, then hour of the operating day. Empty unless the profile is 'ok'. */
export function hourlyGrid(profile: DemandProfile): HourCell[] {
  if (profile.status !== 'ok') return [];
  const slotsPerHour = 60 / profile.settings.slotMinutes;
  const grid: HourCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      let revenue = 0;
      let minutes = 0;
      let rated = false;
      for (let k = 0; k < slotsPerHour; k += 1) {
        const cell = profile.cells[day * profile.positions + hour * slotsPerHour + k];
        if (!cell || cell.revenuePerHourCents === null) continue;
        rated = true;
        revenue += cell.revenueCents;
        minutes += cell.vehicleMinutes;
      }
      grid.push({
        dayType: day as DayType,
        hourIndex: hour,
        clockHour: (profile.settings.operatingDayStartHour + hour) % 24,
        revenuePerHourCents: rated && minutes > 0 ? Math.round((revenue / minutes) * 60) : null,
        vehicleMinutes: minutes,
      });
    }
  }
  return grid;
}
