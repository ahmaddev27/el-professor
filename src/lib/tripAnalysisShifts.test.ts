import { describe, expect, it } from 'vitest';
import {
  berlinOffsetMs,
  berlinWallClockToInstant,
  SAVED_STUNDENNACHWEIS_SOURCE,
  shiftsFromSavedStundennachweise,
  type SavedStundennachweisRecord,
} from './tripAnalysisShifts';

const iso = (ms: number) => new Date(ms).toISOString();

function record(rows: unknown[], extra: Partial<SavedStundennachweisRecord> = {}): SavedStundennachweisRecord {
  return { id: 'sn1', driver_id: 'drv1', month: 8, year: 2026, rows_json: rows, ...extra };
}

describe('berlinOffsetMs', () => {
  it('is +02:00 in summer and +01:00 in winter', () => {
    expect(berlinOffsetMs(Date.parse('2026-08-03T10:00:00Z'))).toBe(2 * 3_600_000);
    expect(berlinOffsetMs(Date.parse('2026-01-05T10:00:00Z'))).toBe(3_600_000);
  });
});

describe('berlinWallClockToInstant', () => {
  it("reads a summer and a winter time with Berlin's own offset", () => {
    expect(iso(berlinWallClockToInstant(2026, 8, 3, 8, 0).ms)).toBe('2026-08-03T06:00:00.000Z');
    expect(iso(berlinWallClockToInstant(2026, 1, 5, 8, 0).ms)).toBe('2026-01-05T07:00:00.000Z');
  });

  it('reads 24:00 as midnight at the end of the day', () => {
    expect(iso(berlinWallClockToInstant(2026, 8, 3, 24, 0).ms)).toBe('2026-08-03T22:00:00.000Z');
  });

  it('reads a time the spring switch skips with the winter offset, and says so', () => {
    const got = berlinWallClockToInstant(2026, 3, 29, 2, 30);
    expect(iso(got.ms)).toBe('2026-03-29T01:30:00.000Z');
    expect(got.adjusted).toBe(true);
  });

  it('takes the earlier of the two readings the autumn switch allows, and says so', () => {
    const got = berlinWallClockToInstant(2026, 10, 25, 2, 30);
    expect(iso(got.ms)).toBe('2026-10-25T00:30:00.000Z');
    expect(got.adjusted).toBe(true);
  });

  it('is exact on either side of a switch', () => {
    expect(berlinWallClockToInstant(2026, 3, 29, 1, 59).adjusted).toBe(false);
    expect(iso(berlinWallClockToInstant(2026, 3, 29, 3, 0).ms)).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(berlinWallClockToInstant(2026, 10, 25, 3, 0).ms)).toBe('2026-10-25T02:00:00.000Z');
  });
});

describe('shiftsFromSavedStundennachweise', () => {
  it("turns each von/bis pair into an absolute interval of the record's driver", () => {
    const { shifts, unreadable, dstAdjusted } = shiftsFromSavedStundennachweise([
      record([{ date_key: '2026-08-03', von1: '08:00', bis1: '12:00', von2: '13:00', bis2: '16:30', von3: '', bis3: '' }]),
    ]);
    expect(unreadable).toBe(0);
    expect(dstAdjusted).toBe(0);
    expect(shifts).toEqual([
      { id: 'sn1:2026-08-03:1', driver_id: 'drv1', start_ms: Date.parse('2026-08-03T06:00:00Z'), end_ms: Date.parse('2026-08-03T10:00:00Z'), source: SAVED_STUNDENNACHWEIS_SOURCE },
      { id: 'sn1:2026-08-03:2', driver_id: 'drv1', start_ms: Date.parse('2026-08-03T11:00:00Z'), end_ms: Date.parse('2026-08-03T14:30:00Z'), source: SAVED_STUNDENNACHWEIS_SOURCE },
    ]);
  });

  it('ends a pair whose bis is before its von on the next day', () => {
    const { shifts } = shiftsFromSavedStundennachweise([record([{ date_key: '2026-08-31', von1: '22:00', bis1: '02:15' }])]);
    expect(iso(shifts[0].start_ms)).toBe('2026-08-31T20:00:00.000Z');
    expect(iso(shifts[0].end_ms)).toBe('2026-09-01T00:15:00.000Z');
  });

  it('keeps the third pair', () => {
    const { shifts } = shiftsFromSavedStundennachweise([
      record([{ date_key: '2026-08-04', von1: '06:00', bis1: '07:00', von2: '08:00', bis2: '09:00', von3: '10:00', bis3: '11:00' }]),
    ]);
    expect(shifts.map(s => s.id)).toEqual(['sn1:2026-08-04:1', 'sn1:2026-08-04:2', 'sn1:2026-08-04:3']);
  });

  it("falls back to the day index in the record's month when a row has no date key", () => {
    const { shifts } = shiftsFromSavedStundennachweise([record([{ dayIndex: 7, von1: '09:00', bis1: '10:00' }])]);
    expect(shifts[0].id).toBe('sn1:2026-08-07:1');
    expect(iso(shifts[0].start_ms)).toBe('2026-08-07T07:00:00.000Z');
  });

  it('counts a half-filled or malformed pair as unreadable and skips it', () => {
    const { shifts, unreadable } = shiftsFromSavedStundennachweise([
      record([{ date_key: '2026-08-05', von1: '08:00', bis1: '', von2: 'acht', bis2: '09:00', von3: '10:00', bis3: '25:00' }]),
    ]);
    expect(shifts).toEqual([]);
    expect(unreadable).toBe(3);
  });

  it('skips a pair of zero minutes, as the Stundennachweis counts it', () => {
    const { shifts, unreadable } = shiftsFromSavedStundennachweise([record([{ date_key: '2026-08-05', von1: '08:00', bis1: '08:00' }])]);
    expect(shifts).toEqual([]);
    expect(unreadable).toBe(0);
  });

  it('counts the times that fell into a DST switch, and keeps the shift', () => {
    const { shifts, dstAdjusted } = shiftsFromSavedStundennachweise([
      record([{ date_key: '2026-10-25', von1: '01:00', bis1: '02:30' }], { month: 10 }),
    ]);
    expect(shifts).toHaveLength(1);
    expect(dstAdjusted).toBe(1);
    expect(iso(shifts[0].start_ms)).toBe('2026-10-24T23:00:00.000Z');
    expect(iso(shifts[0].end_ms)).toBe('2026-10-25T00:30:00.000Z');
  });

  it('reads nothing from a record without rows', () => {
    expect(shiftsFromSavedStundennachweise([record(null as unknown as unknown[])]).shifts).toEqual([]);
  });
});
