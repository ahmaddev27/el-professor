import { parseGermanAmountToCents } from '../money';
import { SHIFT_LIMITS } from './generator';
import { isKnownTimeZone, type SimulationTenantSettings } from './tenantSettings';

/**
 * The calendar-month form, as text the operator typed, read into the settings
 * the generator takes (decision 1, 3 and 5 of 29.10.2026).
 *
 * The defaults are the owner's: declined rides on at 6,00 EUR, no fee on a
 * cancellation, the monthly share on with tips out of its basis and decline
 * fees in. They differ from `DEFAULT_SIMULATION_TENANT_SETTINGS` (which ships
 * both features off for every other caller) on purpose: this screen is where
 * the owner turned them on.
 *
 * A fee is whole cents or it is refused. 6,005 is not rounded to 6,01: money is
 * not changed silently, and the generator refuses a fractional cent as well.
 */
export interface CalendarForm {
  timeZone: string;
  operatingDayStartHour: string;
  shiftsPerVehicleDay: string;
  declinedRidesEnabled: boolean;
  declinedFee: string;
  chargeDeclinedFeeOnCancelled: boolean;
  monthlyRevenueShareEnabled: boolean;
  basisIncludesTips: boolean;
  basisIncludesDeclinedFees: boolean;
}

export const DEFAULT_CALENDAR_FORM: CalendarForm = {
  timeZone: 'Europe/Berlin',
  operatingDayStartHour: '4',
  shiftsPerVehicleDay: '1',
  declinedRidesEnabled: true,
  declinedFee: '6,00',
  chargeDeclinedFeeOnCancelled: false,
  monthlyRevenueShareEnabled: true,
  basisIncludesTips: false,
  basisIncludesDeclinedFees: true,
};

export type CalendarFormField = 'timeZone' | 'operatingDayStartHour' | 'shiftsPerVehicleDay' | 'declinedFee';

export type CalendarFormResult =
  | { ok: true; settings: Partial<SimulationTenantSettings>; shiftsPerVehicleDay: number }
  | { ok: false; field: CalendarFormField };

const wholeNumber = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null);

export function parseCalendarForm(form: CalendarForm): CalendarFormResult {
  const timeZone = form.timeZone.trim();
  if (!isKnownTimeZone(timeZone)) return { ok: false, field: 'timeZone' };
  const hour = wholeNumber(form.operatingDayStartHour);
  if (hour === null || hour > 23) return { ok: false, field: 'operatingDayStartHour' };
  const shifts = wholeNumber(form.shiftsPerVehicleDay);
  if (shifts === null || shifts < 1 || shifts > SHIFT_LIMITS.maxPerVehicleDay) return { ok: false, field: 'shiftsPerVehicleDay' };
  const fee = parseGermanAmountToCents(form.declinedFee);
  if (fee === null) return { ok: false, field: 'declinedFee' };
  return {
    ok: true,
    shiftsPerVehicleDay: shifts,
    settings: {
      timeZone,
      operatingDayStartHour: hour,
      declinedRidesEnabled: form.declinedRidesEnabled,
      declinedFeeCents: fee,
      chargeDeclinedFeeOnCancelled: form.chargeDeclinedFeeOnCancelled,
      monthlyRevenueShareEnabled: form.monthlyRevenueShareEnabled,
      basisIncludesTips: form.basisIncludesTips,
      basisIncludesDeclinedFees: form.basisIncludesDeclinedFees,
    },
  };
}
