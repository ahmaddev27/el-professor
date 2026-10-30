import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR_FORM, parseCalendarForm, type CalendarForm } from './calendarForm';

const form = (patch: Partial<CalendarForm> = {}): CalendarForm => ({ ...DEFAULT_CALENDAR_FORM, ...patch });

describe('parseCalendarForm', () => {
  it('reads the scenario defaults: declined at 6,00 internal, a 6,00 cancellation fee, share on, tips out, cancellation fees in', () => {
    expect(parseCalendarForm(form())).toEqual({
      ok: true,
      shiftsPerVehicleDay: 1,
      options: { repositioningMarginSeconds: 60, repositioningMarginPercent: 15 },
      settings: {
        timeZone: 'Europe/Berlin', operatingDayStartHour: 4,
        declinedRidesEnabled: true, declinedFeeCents: 600, cancellationFeeEnabled: true, cancellationFeeCents: 600,
        monthlyRevenueShareEnabled: true, basisIncludesTips: false, basisIncludesCancellationFees: true,
      },
    });
  });

  it('reads the safety margin, and refuses one out of range', () => {
    expect(parseCalendarForm(form({ marginSeconds: '0', marginPercent: '0' })))
      .toMatchObject({ ok: true, options: { repositioningMarginSeconds: 0, repositioningMarginPercent: 0 } });
    expect(parseCalendarForm(form({ marginSeconds: '901' }))).toEqual({ ok: false, field: 'marginSeconds' });
    expect(parseCalendarForm(form({ marginPercent: '101' }))).toEqual({ ok: false, field: 'marginPercent' });
    expect(parseCalendarForm(form({ marginSeconds: '1,5' }))).toEqual({ ok: false, field: 'marginSeconds' });
    expect(parseCalendarForm(form({ cancellationFee: 'sechs' }))).toEqual({ ok: false, field: 'cancellationFee' });
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
