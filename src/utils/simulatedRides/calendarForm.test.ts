import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR_FORM, parseCalendarForm, type CalendarForm } from './calendarForm';

const form = (patch: Partial<CalendarForm> = {}): CalendarForm => ({ ...DEFAULT_CALENDAR_FORM, ...patch });

describe('parseCalendarForm', () => {
  it('reads the owner\'s defaults: declined at 6,00, no fee on a cancellation, share on, tips out, fees in', () => {
    expect(parseCalendarForm(form())).toEqual({
      ok: true,
      shiftsPerVehicleDay: 1,
      settings: {
        timeZone: 'Europe/Berlin', operatingDayStartHour: 4,
        declinedRidesEnabled: true, declinedFeeCents: 600, chargeDeclinedFeeOnCancelled: false,
        monthlyRevenueShareEnabled: true, basisIncludesTips: false, basisIncludesDeclinedFees: true,
      },
    });
  });

  it('reads a fee in whole cents, comma or dot', () => {
    expect(parseCalendarForm(form({ declinedFee: '7,50' }))).toMatchObject({ settings: { declinedFeeCents: 750 } });
    expect(parseCalendarForm(form({ declinedFee: '7.5' }))).toMatchObject({ settings: { declinedFeeCents: 750 } });
  });

  it.each([
    ['a fraction of a cent', { declinedFee: '6,005' }, 'declinedFee'],
    ['a fee that is no amount', { declinedFee: 'sechs' }, 'declinedFee'],
    ['a negative fee', { declinedFee: '-6,00' }, 'declinedFee'],
    ['an unknown zone', { timeZone: 'Mars/Olympus' }, 'timeZone'],
    ['an empty zone', { timeZone: '  ' }, 'timeZone'],
    ['hour 24', { operatingDayStartHour: '24' }, 'operatingDayStartHour'],
    ['a non-numeric hour', { operatingDayStartHour: 'vier' }, 'operatingDayStartHour'],
    ['no shifts', { shiftsPerVehicleDay: '0' }, 'shiftsPerVehicleDay'],
    ['four shifts', { shiftsPerVehicleDay: '4' }, 'shiftsPerVehicleDay'],
  ] as const)('refuses %s and names the field', (_name, patch, field) => {
    expect(parseCalendarForm(form(patch))).toEqual({ ok: false, field });
  });

  it('accepts hour 0 and 23, and three shifts', () => {
    expect(parseCalendarForm(form({ operatingDayStartHour: '0', shiftsPerVehicleDay: '3' }))).toMatchObject({ ok: true, shiftsPerVehicleDay: 3, settings: { operatingDayStartHour: 0 } });
    expect(parseCalendarForm(form({ operatingDayStartHour: '23' }))).toMatchObject({ ok: true, settings: { operatingDayStartHour: 23 } });
  });
});
