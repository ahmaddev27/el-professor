import { parseGermanAmountToCents } from '../money';
import { DEFAULT_OPTIONS, SHIFT_LIMITS } from './generator';
import { marginProblem } from './repositioning';
import { isKnownTimeZone, type SimulationTenantSettings } from './tenantSettings';
import type { GeneratorOptions } from './types';

/**
 * The calendar-month form, as text the operator typed, read into the settings
 * the generator takes (decision 1, 3 and 5 of 29.10.2026).
 *
 * The defaults are the owner's: declined orders on at 6,00 EUR (kept in the
 * internal operational report only, never in the Fahrtenbuch report), a
 * cancellation fee of 6,00 EUR on (round 6: "6 € is acceptable in this
 * scenario"), the monthly share on with tips out of its basis and cancellation
 * fees in. They differ from `DEFAULT_SIMULATION_TENANT_SETTINGS` (which ships
 * every fee off for every other caller) on purpose: this screen is where the
 * owner turned them on. The safety margin on every empty drive is the
 * generator's default, 60 s plus 15 % of the road time.
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
  cancellationFeeEnabled: boolean;
  cancellationFee: string;
  monthlyRevenueShareEnabled: boolean;
  basisIncludesTips: boolean;
  basisIncludesCancellationFees: boolean;
  marginSeconds: string;
  marginPercent: string;
}

export const DEFAULT_CALENDAR_FORM: CalendarForm = {
  timeZone: 'Europe/Berlin',
  operatingDayStartHour: '4',
  shiftsPerVehicleDay: '1',
  declinedRidesEnabled: true,
  declinedFee: '6,00',
  cancellationFeeEnabled: true,
  cancellationFee: '6,00',
  monthlyRevenueShareEnabled: true,
  basisIncludesTips: false,
  basisIncludesCancellationFees: true,
  marginSeconds: String(DEFAULT_OPTIONS.repositioningMarginSeconds),
  marginPercent: String(DEFAULT_OPTIONS.repositioningMarginPercent),
};

export type CalendarFormField =
  | 'timeZone' | 'operatingDayStartHour' | 'shiftsPerVehicleDay' | 'declinedFee' | 'cancellationFee'
  | 'marginSeconds' | 'marginPercent';

export type CalendarFormResult =
  | {
      ok: true;
      settings: Partial<SimulationTenantSettings>;
      options: Pick<GeneratorOptions, 'repositioningMarginSeconds' | 'repositioningMarginPercent'>;
      shiftsPerVehicleDay: number;
    }
  | { ok: false; field: CalendarFormField };

const UP_TO_TWO_DIGITS = /^\d{1,2}$/;
const UP_TO_THREE_DIGITS = /^\d{1,3}$/;

const wholeNumber = (text: string, pattern: RegExp = UP_TO_TWO_DIGITS): number | null =>
  (pattern.test(text.trim()) ? Number(text.trim()) : null);

export function parseCalendarForm(form: CalendarForm): CalendarFormResult {
  const timeZone = form.timeZone.trim();
  if (!isKnownTimeZone(timeZone)) return { ok: false, field: 'timeZone' };
  const hour = wholeNumber(form.operatingDayStartHour);
  if (hour === null || hour > 23) return { ok: false, field: 'operatingDayStartHour' };
  const shifts = wholeNumber(form.shiftsPerVehicleDay);
  if (shifts === null || shifts < 1 || shifts > SHIFT_LIMITS.maxPerVehicleDay) return { ok: false, field: 'shiftsPerVehicleDay' };
  const fee = parseGermanAmountToCents(form.declinedFee);
  if (fee === null) return { ok: false, field: 'declinedFee' };
  const cancellationFee = parseGermanAmountToCents(form.cancellationFee);
  if (cancellationFee === null) return { ok: false, field: 'cancellationFee' };
  const marginSeconds = wholeNumber(form.marginSeconds, UP_TO_THREE_DIGITS);
  if (marginSeconds === null) return { ok: false, field: 'marginSeconds' };
  const marginPercent = wholeNumber(form.marginPercent, UP_TO_THREE_DIGITS);
  if (marginPercent === null) return { ok: false, field: 'marginPercent' };
  const options = { repositioningMarginSeconds: marginSeconds, repositioningMarginPercent: marginPercent };
  const problem = marginProblem(options);
  if (problem) return { ok: false, field: problem === 'margin_seconds_invalid' ? 'marginSeconds' : 'marginPercent' };
  return {
    ok: true,
    shiftsPerVehicleDay: shifts,
    options,
    settings: {
      timeZone,
      operatingDayStartHour: hour,
      declinedRidesEnabled: form.declinedRidesEnabled,
      declinedFeeCents: fee,
      cancellationFeeEnabled: form.cancellationFeeEnabled,
      cancellationFeeCents: cancellationFee,
      monthlyRevenueShareEnabled: form.monthlyRevenueShareEnabled,
      basisIncludesTips: form.basisIncludesTips,
      basisIncludesCancellationFees: form.basisIncludesCancellationFees,
    },
  };
}
