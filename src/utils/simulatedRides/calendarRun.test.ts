import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR_FORM, parseCalendarForm } from './calendarForm';
import { calendarMonthInput, savedBasePoint, type CalendarEvents, type CalendarRunArgs } from './calendarRun';

const form = parseCalendarForm(DEFAULT_CALENDAR_FORM);
if (!form.ok) throw new Error('the default calendar form must parse');

const events = (over: Partial<CalendarEvents> = {}): CalendarEvents => ({
  notes: new Map(), facts: new Map(), checks: [], unavailability: [], uber: null, realTrips: null, simulation: null, ...over,
});

const args = (over: Partial<CalendarRunArgs> = {}): CalendarRunArgs => ({
  year: 2026, month: 9, seed: 7, tenantId: 'company-a',
  base: { point: { lat: 51.2, lon: 7.1 }, source: 'saved_point', label: 'Gespeicherter Betriebssitz' },
  cars: [{ id: 'car-1', plate: 'W-AB 1', tuev: '2027-01-31' }, { id: 'car-2', plate: 'W-AB 2', tuev: null }],
  carIds: ['car-2'],
  drivers: [{ id: 'd-1', name: 'Anna' }],
  events: events(),
  sourcing: { points: [], travel: undefined, provenance: null, estimate: true },
  form,
  ...over,
});

describe('calendarMonthInput: the one place the screen and the script build the month', () => {
  it('takes only the chosen cars, as Mietwagen with their TÜV date', () => {
    expect(calendarMonthInput(args()).vehicles).toEqual([{ id: 'car-2', plate: 'W-AB 2', type: 'Mietwagen', tuev_gueltig_bis: null }]);
  });

  it('a driver whose planning row was not read has no range, so the month reports him rather than guessing one', () => {
    const [driver] = calendarMonthInput(args()).drivers;
    expect(driver).toMatchObject({ id: 'd-1', name: 'Anna', planning_min_salary: null, planning_max_salary: null, planning_hourly_rate: null, allowed_weekdays: null });
    expect(driver.planning_enabled).toBe(true);
  });

  it('with no stored settings there is no rate and no return to the base, and the source is the company', () => {
    const input = calendarMonthInput(args());
    expect(input.shareSetting).toBeNull();
    expect(input.returnToBase).toBe(false);
    expect(input.settingsSource).toBe('company_settings');
  });

  it('the stored settings and their source are handed on as given', () => {
    const input = calendarMonthInput(args({
      events: events({ simulation: { shareSetting: { mode: 'fixed', percent: 31 }, returnToBase: true, stored: false, updatedAt: null } }),
      settingsSource: 'script_arguments',
    }));
    expect(input.shareSetting).toEqual({ mode: 'fixed', percent: 31 });
    expect(input.returnToBase).toBe(true);
    expect(input.settingsSource).toBe('script_arguments');
  });

  it('no real trips read is undefined, so the month stays VERIFICATION_INCOMPLETE; an empty read is a read', () => {
    expect(calendarMonthInput(args()).realTrips).toBeUndefined();
    const read = calendarMonthInput(args({ events: events({ realTrips: { rows: [], drivers: [] } }) })).realTrips;
    expect(read?.trips).toEqual([]);
  });

  it('the base keeps its source and label', () => {
    const input = calendarMonthInput(args({ base: { point: { lat: 51.3, lon: 7.2 }, source: 'company_address', label: 'Firmenanschrift' } }));
    expect(input).toMatchObject({ base: { lat: 51.3, lon: 7.2 }, baseSource: 'company_address', baseLabel: 'Firmenanschrift' });
  });
});

describe('savedBasePoint', () => {
  it('reads both halves, as numbers or numeric text, and refuses half a point', () => {
    expect(savedBasePoint({ base_latitude: '51.25', base_longitude: 7.15 })).toEqual({ lat: 51.25, lon: 7.15 });
    expect(savedBasePoint({ base_latitude: 51.25, base_longitude: null })).toBeNull();
    expect(savedBasePoint({ base_latitude: 'x', base_longitude: 7 })).toBeNull();
    expect(savedBasePoint(null)).toBeNull();
  });
});
