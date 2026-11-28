import { describe, expect, it } from 'vitest';
import { readUnavailability, unavailableDuring, type VehicleUnavailabilityRow } from './vehicleAvailability';

// Invented ids; the table stores wall-clock moments in Europe/Berlin.
const CAR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const row = (starts: string, ends: string | null, over: Partial<VehicleUnavailabilityRow> = {}): VehicleUnavailabilityRow =>
  ({ id: 'u-1', car_id: CAR, starts_local: starts, ends_local: ends, reason: 'werkstatt', ...over });
const utc = (iso: string) => Date.parse(iso);

describe('readUnavailability', () => {
  it('reads a summer window as Berlin wall time, with or without seconds and with a T', () => {
    const [w] = readUnavailability([row('2026-09-10 08:00:00', '2026-09-12T18:00')]);
    expect(w.startMs).toBe(utc('2026-09-10T06:00:00Z'));
    expect(w.endMs).toBe(utc('2026-09-12T16:00:00Z'));
    expect(w).toMatchObject({ widened: false, unreadable: false, carId: CAR, reason: 'werkstatt' });
  });

  it('an open end is unavailable to the end of time', () => {
    const [w] = readUnavailability([row('2026-01-05 07:30:00', null)]);
    expect(w.startMs).toBe(utc('2026-01-05T06:30:00Z'));
    expect(w.endMs).toBe(Infinity);
    expect(w.unreadable).toBe(false);
  });

  it('a start the clocks skip moves an hour earlier, never later', () => {
    // 29.03.2026 02:30 does not exist in Berlin; 01:30 CET is 00:30 UTC.
    const [w] = readUnavailability([row('2026-03-29 02:30:00', '2026-03-29 12:00:00')]);
    expect(w.startMs).toBe(utc('2026-03-29T00:30:00Z'));
    expect(w.endMs).toBe(utc('2026-03-29T10:00:00Z'));
    expect(w.widened).toBe(true);
  });

  it('a boundary the clocks repeat is widened outwards on both sides', () => {
    // 25.10.2026 02:30 happens twice. As a start it moves to 01:30 CEST, as an end to 03:30 CET.
    const [asStart] = readUnavailability([row('2026-10-25 02:30:00', '2026-10-25 12:00:00')]);
    expect(asStart.startMs).toBe(utc('2026-10-24T23:30:00Z'));
    expect(asStart.widened).toBe(true);
    const [asEnd] = readUnavailability([row('2026-10-24 20:00:00', '2026-10-25 02:30:00')]);
    expect(asEnd.endMs).toBe(utc('2026-10-25T02:30:00Z'));
    expect(asEnd.widened).toBe(true);
    // Either reading of the repeated 02:30 lies inside the widened window.
    for (const reading of [utc('2026-10-25T00:30:00Z'), utc('2026-10-25T01:30:00Z')]) {
      expect(reading).toBeGreaterThan(asEnd.startMs);
      expect(reading).toBeLessThan(asEnd.endMs);
    }
  });

  it.each([
    ['a start that is not a time', 'gestern', null],
    ['a day that does not exist', '2026-02-30 08:00:00', '2026-03-02 08:00:00'],
    ['an end before its start', '2026-09-12 08:00:00', '2026-09-10 08:00:00'],
    ['an end equal to its start', '2026-09-12 08:00:00', '2026-09-12 08:00:00'],
    ['an end that is not a time', '2026-09-12 08:00:00', 'morgen'],
  ])('negative: %s blocks the car at every moment and is marked unreadable', (_n, starts, ends) => {
    const [w] = readUnavailability([row(starts, ends)]);
    expect(w).toMatchObject({ startMs: -Infinity, endMs: Infinity, unreadable: true, carId: CAR });
    expect(unavailableDuring([w], CAR, utc('2030-01-01T00:00:00Z'), utc('2030-01-01T01:00:00Z'))).toBe(w);
  });
});

describe('unavailableDuring', () => {
  const windows = readUnavailability([
    row('2026-09-10 08:00:00', '2026-09-10 12:00:00', { id: 'u-a' }),
    row('2026-09-11 08:00:00', null, { id: 'u-b', car_id: OTHER }),
  ]);

  it('is half-open: a shift may end as the window starts and start as it ends', () => {
    expect(unavailableDuring(windows, CAR, utc('2026-09-10T04:00:00Z'), utc('2026-09-10T06:00:00Z'))).toBeNull();
    expect(unavailableDuring(windows, CAR, utc('2026-09-10T10:00:00Z'), utc('2026-09-10T12:00:00Z'))).toBeNull();
    expect(unavailableDuring(windows, CAR, utc('2026-09-10T05:59:00Z'), utc('2026-09-10T06:01:00Z'))?.id).toBe('u-a');
    expect(unavailableDuring(windows, CAR, utc('2026-09-10T09:59:00Z'), utc('2026-09-10T11:00:00Z'))?.id).toBe('u-a');
  });

  it('answers for the car it is asked about only', () => {
    expect(unavailableDuring(windows, CAR, utc('2026-12-01T08:00:00Z'), utc('2026-12-01T09:00:00Z'))).toBeNull();
    expect(unavailableDuring(windows, OTHER, utc('2026-12-01T08:00:00Z'), utc('2026-12-01T09:00:00Z'))?.id).toBe('u-b');
    expect(unavailableDuring(windows, OTHER, utc('2026-09-10T06:00:00Z'), utc('2026-09-10T08:00:00Z'))).toBeNull();
  });
});
