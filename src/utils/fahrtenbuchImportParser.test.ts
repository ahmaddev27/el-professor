import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTUAL_END_TOKENS, ACTUAL_START_TOKENS } from './planningQualityChecks';
import {
  CANCELLED_STATUS_WORDS,
  COMPLETED_STATUS_WORDS,
  DECLINED_STATUS_WORDS,
  DATETIME_RE,
  GERMAN_DATETIME_RE,
  REVIEW_REASONS,
  TIME_RE,
  TIME_SOURCES,
  TRIP_STATUSES,
  applySourceRowKeys,
  buildTripRows,
  classifyTimestampCell,
  deriveTripTimes,
  driverMatchInfo,
  findOrderTransmissionColumn,
  isMissingCell,
  mapTripStatus,
  matchDriverName,
  normalise,
  normaliseDriverName,
  normalisePlate,
  durationMinutes,
  parseDate,
  parseTime,
  rideDurationMinutes,
  sha256HexOfBytes,
  sha256HexOfText,
  sourceRowKeyMaterial,
  summariseRows,
  wallAt,
  wallTimeToInstant,
  withoutStoredKeys,
  type BuildContext,
  type ColMap,
  type RawRow,
} from './fahrtenbuchImportParser';

/*
  Every row here is invented. The headers are the Uber export's, because the
  parser has to read that file; no value comes from a real one.
*/

const HEADERS = [
  'Datum/Uhrzeit Auftragseingang', 'Uhrzeit der Auftragsuebermittlung', 'Geplante Abholzeit',
  'Datum der Fahrt', 'Fahrtstatus', 'Standort des Fahrzeugs bei Auftragsuebermittlung',
  'Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes', 'Kennzeichen', 'Fahrzeugtyp',
  'Fahrername', 'Fahrpreis', 'Trinkgeld', 'Kilometer', 'Zahlungsart', 'Abholort', 'Zielort',
  'Vorreservierte Fahrt',
] as const;

const COL_MAP: ColMap = {
  trip_date: 'Datum der Fahrt',
  start_time: 'Uhrzeit des Fahrtbeginns',
  end_time: 'Uhrzeit des Fahrtendes',
  driver_name: 'Fahrername',
  car_identifier: 'Kennzeichen',
  price_amount: 'Fahrpreis',
  tip_amount: 'Trinkgeld',
  payment_method: 'Zahlungsart',
  route_start: 'Abholort',
  route_end: 'Zielort',
  description: 'Fahrzeugtyp',
};

interface RowSpec {
  order?: string;
  date?: string;
  status?: string;
  start?: string | number;
  end?: string | number;
  driver?: string;
  plate?: string;
  fare?: number;
  payment?: string;
}

let orderSeq = 0;

function uberRow(spec: RowSpec): RawRow {
  orderSeq += 1;
  const order = spec.order ?? `2026-08-01 09:${String(Math.floor(orderSeq / 60) % 60).padStart(2, '0')}:${String(orderSeq % 60).padStart(2, '0')}.000`;
  const values: Record<(typeof HEADERS)[number], string | number> = {
    'Datum/Uhrzeit Auftragseingang': order,
    'Uhrzeit der Auftragsuebermittlung': order,
    'Geplante Abholzeit': '\\N',
    'Datum der Fahrt': spec.date ?? '2026-08-01',
    'Fahrtstatus': spec.status ?? 'abgeschlossen',
    'Standort des Fahrzeugs bei Auftragsuebermittlung': '52.0 13.0',
    'Uhrzeit des Fahrtbeginns': spec.start ?? '2026-08-01 10:05:31.000',
    'Uhrzeit des Fahrtendes': spec.end ?? '2026-08-01 10:19:02.000',
    'Kennzeichen': spec.plate ?? 'X-TS 101',
    'Fahrzeugtyp': 'Test',
    'Fahrername': spec.driver ?? 'Fahrer Eins',
    'Fahrpreis': spec.fare ?? 12.5,
    'Trinkgeld': 0,
    'Kilometer': 3.2,
    'Zahlungsart': spec.payment ?? 'Online',
    'Abholort': 'Teststraße 1',
    'Zielort': 'Teststraße 2',
    'Vorreservierte Fahrt': 'Nein',
  };
  return values;
}

function context(rows: RawRow[], overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    rows,
    colMap: COL_MAP,
    statusCol: 'Fahrtstatus',
    orderTransmissionCol: findOrderTransmissionColumn([...HEADERS]),
    driverMatches: new Map(),
    carMatches: new Map(),
    ...overrides,
  };
}

function buildOne(spec: RowSpec) {
  const { built, stats } = buildTripRows(context([uberRow(spec)]));
  return { row: built[0]?.row, built, stats };
}

describe('the null marker', () => {
  it('reads \\N as an empty cell everywhere', () => {
    expect(isMissingCell('\\N')).toBe(true);
    expect(isMissingCell('  \\N  ')).toBe(true);
    expect(isMissingCell('')).toBe(true);
    expect(isMissingCell(null)).toBe(true);
    expect(isMissingCell(0)).toBe(false);
    expect(classifyTimestampCell('\\N')).toEqual({ kind: 'empty' });
    expect(parseTime('\\N')).toBeNull();
    expect(mapTripStatus('\\N')).toBe('unknown');
  });

  it('stores a cancelled ride whose clock is \\N with no times and no fake driver', () => {
    const { row } = buildOne({ status: 'storniert', start: '\\N', end: '\\N', driver: '\\N' });
    expect(row.is_canceled).toBe(true);
    expect(row.trip_status).toBe('cancelled');
    expect(row.trip_date).toBe('2026-08-01');
    expect(row.start_time).toBeNull();
    expect(row.end_time).toBeNull();
    expect(row.start_at).toBeNull();
    expect(row.time_source).toBe('missing');
    expect(row.original_driver_name).toBe('');
    expect(row.original_driver_name).not.toBe('Unbekannt');
    expect(row.review_reasons).toEqual(['missing_driver']);
    expect(row.needs_review).toBe(true);
    expect(row.plausibility_status).toBe('canceled');
  });
});

describe('absolute times', () => {
  it('reads the start and end as Europe/Berlin wall time, seconds kept', () => {
    const { row } = buildOne({});
    expect(row.start_at).toBe('2026-08-01T08:05:31.000Z');
    expect(row.end_at).toBe('2026-08-01T08:19:02.000Z');
    expect(row.time_zone).toBe('Europe/Berlin');
    expect(row.time_source).toBe('source_start_end');
    // The planning columns keep their meaning: minutes, as before.
    expect(row.start_time).toBe('10:05');
    expect(row.end_time).toBe('10:19');
    expect(row.duration_minutes).toBe(14);
    expect(row.needs_review).toBe(false);
    expect(row.review_reasons).toEqual([]);
  });

  it('carries a ride across midnight onto the next day', () => {
    const { row } = buildOne({ date: '2026-08-14', start: '2026-08-14 23:50:10.000', end: '2026-08-15 00:09:45.000' });
    expect(row.start_at).toBe('2026-08-14T21:50:10.000Z');
    expect(row.end_at).toBe('2026-08-14T22:09:45.000Z');
    expect(row.trip_date).toBe('2026-08-14');
    expect(row.duration_minutes).toBe(19);
  });

  it('puts a ride that starts after midnight on its own day, and leaves trip_date as the file says', () => {
    // The export dates such a ride on the day before ("Datum der Fahrt" is the
    // order's day). 22 rides of August 2026 have this shape.
    const { row, stats } = buildOne({ date: '2026-08-01', start: '2026-08-02 00:05:31.000', end: '2026-08-02 00:19:10.000' });
    expect(row.trip_date).toBe('2026-08-01');
    expect(row.start_at).toBe('2026-08-01T22:05:31.000Z');
    expect(wallAt(Date.parse(row.start_at as string), 'Europe/Berlin')).toMatchObject({ year: 2026, month: 8, day: 2, hour: 0, minute: 5, second: 31 });
    expect(stats.startDateDiffers).toBe(1);
  });

  it('counts only the rides whose start falls on another day', () => {
    const rows = [
      uberRow({}),
      uberRow({ date: '2026-08-01', start: '2026-08-02 00:29:00.000', end: '2026-08-02 00:40:00.000' }),
      uberRow({ date: '2026-08-01', start: '2026-08-01 23:59:00.000', end: '2026-08-02 00:10:00.000' }),
    ];
    expect(buildTripRows(context(rows)).stats.startDateDiffers).toBe(1);
  });

  describe('the change to summer time, last Sunday of March (29.03.2026)', () => {
    it('refuses to name an instant for a wall time that never happened', () => {
      expect(wallTimeToInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 })).toEqual({ kind: 'nonexistent' });
      const { row } = buildOne({ date: '2026-03-29', start: '2026-03-29 02:30:00.000', end: '2026-03-29 03:10:00.000' });
      expect(row.time_source).toBe('ambiguous');
      expect(row.start_at).toBeNull();
      expect(row.end_at).toBeNull();
      expect(row.time_zone).toBeNull();
    });

    it('measures a ride across the gap by the clock that was in force', () => {
      const { row } = buildOne({ date: '2026-03-29', start: '2026-03-29 01:50:00.000', end: '2026-03-29 03:10:00.000' });
      expect(row.start_at).toBe('2026-03-29T00:50:00.000Z');
      expect(row.end_at).toBe('2026-03-29T01:10:00.000Z');
      expect(Date.parse(row.end_at as string) - Date.parse(row.start_at as string)).toBe(20 * 60 * 1000);
      // `duration_minutes` is the ride, not the clock face. The HH:MM pair says
      // 03:10 − 01:50 = 80; the hour 02:00–03:00 did not happen, so the ride
      // lasted 20 minutes. This assertion read 80 before the derivation moved
      // onto the instants.
      expect(row.duration_minutes).toBe(20);
      // The stored HH:MM columns are untouched: they are what the file said.
      expect(row.start_time).toBe('01:50');
      expect(row.end_time).toBe('03:10');
    });

    it('reproduces the one production row this corrects, to the second', () => {
      // Production row 0ba35175-1c75-4ad0-884a-36e65dfb30b1 (read-only, 23.10.2026):
      // vehicle SG-YA14, assigned driver withheld, trip_date 2026-03-29,
      // start_at 00:42:40Z, end_at 01:01:46Z, duration_minutes 79 stored
      // against 19.10 minutes elapsed. Both wall times fall inside 00:00–04:00
      // on a Sunday. The stored row is NOT changed by this fix — the column is
      // immutable by trigger — and this test is a statement about what the
      // importer computes from the same input from now on.
      const { row } = buildOne({ date: '2026-03-29', start: '2026-03-29 01:42:40.000', end: '2026-03-29 03:01:46.000' });
      expect(row.start_at).toBe('2026-03-29T00:42:40.000Z');
      expect(row.end_at).toBe('2026-03-29T01:01:46.000Z');
      expect(row.start_time).toBe('01:42');
      expect(row.end_time).toBe('03:01');
      expect(durationMinutes('01:42', '03:01')).toBe(79);   // what was stored
      expect(row.duration_minutes).toBe(19);                // what is computed now
    });
  });

  describe('the change to winter time, last Sunday of October (25.10.2026)', () => {
    it('refuses to choose between the two instants a repeated hour names', () => {
      expect(wallTimeToInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 })).toEqual({ kind: 'ambiguous' });
      const { row } = buildOne({ date: '2026-10-25', start: '2026-10-25 02:30:00.000', end: '2026-10-25 02:45:00.000' });
      expect(row.time_source).toBe('ambiguous');
      expect(row.start_at).toBeNull();
    });

    it('reads the hours either side of the repeat without doubt', () => {
      expect(wallTimeToInstant({ year: 2026, month: 10, day: 25, hour: 1, minute: 59, second: 59 }))
        .toEqual({ kind: 'ok', ms: Date.parse('2026-10-24T23:59:59Z') });
      expect(wallTimeToInstant({ year: 2026, month: 10, day: 25, hour: 3, minute: 0, second: 0 }))
        .toEqual({ kind: 'ok', ms: Date.parse('2026-10-25T02:00:00Z') });
    });

    it('treats a time-of-day fallback in the repeated hour the same way', () => {
      const t = deriveTripTimes({ startCell: '02:30', endCell: '02:50', tripDate: '2026-10-25', startTime: '02:30', endTime: '02:50' });
      expect(t.timeSource).toBe('ambiguous');
      expect(t.startAt).toBeNull();
    });

    it('counts the repeated hour once for each time it happened', () => {
      // The mirror of the March case, and the one the wall clock under-states:
      // 01:30 is still CEST and 03:30 already CET, so the ride spans three
      // hours while the clock face shows two. Staging holds one real row of
      // this shape, stored 60 minutes short (measured 23.10.2026).
      const { row } = buildOne({ date: '2026-10-25', start: '2026-10-25 01:30:00.000', end: '2026-10-25 03:30:00.000' });
      expect(row.start_at).toBe('2026-10-24T23:30:00.000Z');
      expect(row.end_at).toBe('2026-10-25T02:30:00.000Z');
      expect(durationMinutes('01:30', '03:30')).toBe(120);  // the clock face
      expect(row.duration_minutes).toBe(180);               // the ride
    });
  });

  it('falls back to trip_date + HH:MM only when neither column carries a date', () => {
    const same = deriveTripTimes({ startCell: '10:05', endCell: '10:30', tripDate: '2026-08-03', startTime: '10:05', endTime: '10:30' });
    expect(same).toMatchObject({ startAt: '2026-08-03T08:05:00.000Z', endAt: '2026-08-03T08:30:00.000Z', timeSource: 'fallback_trip_date', timeZone: 'Europe/Berlin' });

    const overnight = deriveTripTimes({ startCell: '23:50', endCell: '00:10', tripDate: '2026-08-03', startTime: '23:50', endTime: '00:10' });
    expect(overnight).toMatchObject({ startAt: '2026-08-03T21:50:00.000Z', endAt: '2026-08-03T22:10:00.000Z', timeSource: 'fallback_trip_date' });

    // Across midnight into the October change: the end moves to the next
    // calendar day on the wall clock and is then read in that day's offset —
    // 23:50 CEST to 03:10 CET is 4 h 20 min, not a fixed 24 hours added to an
    // instant (resolveActualRideWindow's rule, which is wrong on these nights).
    const dstNight = deriveTripTimes({ startCell: '23:50', endCell: '03:10', tripDate: '2026-10-24', startTime: '23:50', endTime: '03:10' });
    expect(dstNight).toMatchObject({ startAt: '2026-10-24T21:50:00.000Z', endAt: '2026-10-25T02:10:00.000Z', timeSource: 'fallback_trip_date' });

    // An end equal to the start is a ride under a minute, not one of 24 hours.
    const instant = deriveTripTimes({ startCell: '10:05', endCell: '10:05', tripDate: '2026-08-03', startTime: '10:05', endTime: '10:05' });
    expect(instant.endAt).toBe(instant.startAt);

    // One dated column and one without: nothing is combined.
    const mixed = deriveTripTimes({ startCell: '2026-08-03 10:05:00', endCell: '10:30', tripDate: '2026-08-03', startTime: '10:05', endTime: '10:30' });
    expect(mixed).toMatchObject({ startAt: null, endAt: null, timeSource: 'unparsed' });
  });

  it('leaves a value it cannot read NULL and says so, never guessing', () => {
    expect(deriveTripTimes({ startCell: 'kaputt', endCell: '2026-08-01 10:19:02.000', tripDate: '2026-08-01', startTime: null, endTime: '10:19' }))
      .toMatchObject({ startAt: null, endAt: null, timeZone: null, timeSource: 'unparsed' });
    // An impossible calendar day, and a zone the file never writes, are not read.
    expect(classifyTimestampCell('2026-02-30 10:00:00.000')).toEqual({ kind: 'other' });
    expect(classifyTimestampCell('2026-08-01T10:00:00Z')).toEqual({ kind: 'other' });
    expect(classifyTimestampCell('2026-08-01 24:00:00')).toEqual({ kind: 'other' });
    expect(classifyTimestampCell(true)).toEqual({ kind: 'other' });
  });

  it('reads the German spelling, day first', () => {
    expect(classifyTimestampCell('01.08.2026 10:05')).toEqual({ kind: 'datetime', wall: { year: 2026, month: 8, day: 1, hour: 10, minute: 5, second: 0 } });
    expect(classifyTimestampCell('1.8.2026 10:19:02')).toEqual({ kind: 'datetime', wall: { year: 2026, month: 8, day: 1, hour: 10, minute: 19, second: 2 } });
    expect(classifyTimestampCell('31.02.2026 10:05')).toEqual({ kind: 'other' });
    expect(classifyTimestampCell('08/01/2026 10:05')).toEqual({ kind: 'other' });
  });

  it('reads an Excel date-and-time serial, and nothing else as one', () => {
    // 46235.5 is 2026-08-01 12:00.
    expect(classifyTimestampCell(46235.5)).toEqual({ kind: 'datetime', wall: { year: 2026, month: 8, day: 1, hour: 12, minute: 0, second: 0 } });
    expect(classifyTimestampCell(0.5)).toEqual({ kind: 'time' });
    expect(classifyTimestampCell(46235)).toEqual({ kind: 'other' });
    expect(classifyTimestampCell(-1)).toEqual({ kind: 'other' });
  });
});

describe('statuses', () => {
  it('maps the completed word and the old importer\'s cancel words, and nothing else', () => {
    expect(mapTripStatus('abgeschlossen')).toBe('completed');
    expect(mapTripStatus(' Abgeschlossen ')).toBe('completed');
    for (const cancelled of [
      'storniert', 'STORNIERT', ' Storno ', 'Storniert Fahrt', 'Stornierung',
      'cancelled', 'Canceled', 'abgebrochen', 'ABGEBROCHEN', 'nicht durchgefuhrt',
    ]) {
      expect(mapTripStatus(cancelled)).toBe('cancelled');
    }
    for (const other of ['unterwegs', 'offen', 'storn', '', '\\N', 'constructor', 'toString']) {
      expect(mapTripStatus(other)).toBe('unknown');
    }
  });

  it('keeps every cancel word as cancelled through the whole row', () => {
    for (const word of CANCELLED_STATUS_WORDS) {
      const { row } = buildOne({ status: word, start: '\\N', end: '\\N' });
      expect(row).toMatchObject({ trip_status: 'cancelled', is_canceled: true, source_status: word, plausibility_status: 'canceled' });
      expect(row.review_reasons).toEqual([]);
    }
  });

  it('stores an unknown status, flags it, and never counts it as completed', () => {
    const { row } = buildOne({ status: 'unterwegs' });
    expect(row.trip_status).toBe('unknown');
    expect(row.is_canceled).toBe(false);
    expect(row.source_status).toBe('unterwegs');
    expect(row.needs_review).toBe(true);
    expect(row.review_reasons).toEqual(['unknown_status']);
    const summary = summariseRows([row]);
    expect(summary).toMatchObject({ completed: 0, cancelled: 0, unknown: 1, needsReview: 1 });
  });

  it('reads a file without a status column as unknown status', () => {
    const { built } = buildTripRows(context([uberRow({})], { statusCol: '' }));
    expect(built[0].row.trip_status).toBe('unknown');
    expect(built[0].row.source_status).toBeNull();
  });
});

describe('duration_minutes is the ride, measured from the instants', () => {
  it('agrees with the old HH:MM rule on every ride length of an ordinary day', () => {
    // This is the safety claim behind correcting the writer and leaving the
    // stored rows alone: off a DST transition the new figure is not merely
    // close to the old one, it is the same number. Each instant is truncated
    // to its own minute before subtracting, which is exactly what reading the
    // HH:MM pair did — the seconds were never part of the old figure, so they
    // must not round it now.
    const hhmm = (m: number) =>
      `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    let compared = 0;
    for (let startMin = 0; startMin < 24 * 60; startMin += 7) {
      for (const lengthMin of [1, 14, 59, 60, 137, 480, 1439]) {
        const startTime = hhmm(startMin);
        const endTime = hhmm(startMin + lengthMin);
        const t = deriveTripTimes({
          startCell: startTime, endCell: endTime,
          tripDate: '2026-08-12', startTime, endTime,   // an ordinary Wednesday
        });
        expect(t.startAt).not.toBeNull();
        expect(rideDurationMinutes(t.startAt, t.endAt, startTime, endTime))
          .toBe(durationMinutes(startTime, endTime));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(1400);
  });

  it('keeps the seconds out of the figure, as the HH:MM rule did', () => {
    // 23:50:10 → 00:09:45 is 19 minutes 35 seconds. The old figure was 19,
    // and it stays 19: rounding the elapsed time would have made it 20 and
    // moved a column on every ordinary row in the database.
    const { row } = buildOne({ date: '2026-08-14', start: '2026-08-14 23:50:10.000', end: '2026-08-15 00:09:45.000' });
    expect(row.duration_minutes).toBe(19);
    expect(row.duration_minutes).toBe(durationMinutes('23:50', '00:09'));
  });

  it('keeps the HH:MM figure when the row carries no instants', () => {
    // A wall time inside the spring gap names no instant at all, and none is
    // invented. The old rule is what is left to read, so it stands.
    expect(rideDurationMinutes(null, null, '02:30', '03:10')).toBe(40);
    const { row } = buildOne({ date: '2026-03-29', start: '2026-03-29 02:30:00.000', end: '2026-03-29 03:10:00.000' });
    expect(row.time_source).toBe('ambiguous');
    expect(row.start_at).toBeNull();
    expect(row.duration_minutes).toBe(40);
  });

  it('keeps the HH:MM figure when the instants run backwards, so the row still inserts', () => {
    // The column is CHECK (duration_minutes >= 0). A negative figure would
    // refuse the insert and lose a ride that the importer otherwise keeps and
    // flags `end_before_start`.
    const back = rideDurationMinutes('2026-08-12T10:00:00.000Z', '2026-08-12T09:00:00.000Z', '12:00', '11:00');
    expect(back).toBe(durationMinutes('12:00', '11:00'));
    expect(back).toBeGreaterThanOrEqual(0);
  });

  it('never returns a non-number, whatever it is handed', () => {
    expect(rideDurationMinutes('not a timestamp', 'nor this', '10:00', '10:30')).toBe(30);
    expect(rideDurationMinutes(null, '2026-08-12T10:00:00.000Z', '10:00', '10:30')).toBe(30);
    expect(rideDurationMinutes('2026-08-12T10:00:00.000Z', null, '10:00', '10:30')).toBe(30);
  });

  it('leaves a cancelled ride without a figure, instants or not', () => {
    // The gate at the call site is unchanged. This row is cancelled, so it has
    // no clock times — but its cells do parse, so it does have instants, and
    // the figure must still be NULL. Staging holds one such row.
    const { row } = buildOne({ status: 'storniert' });
    expect(row.is_canceled).toBe(true);
    expect(row.start_at).not.toBeNull();
    expect(row.start_time).toBeNull();
    expect(row.duration_minutes).toBeNull();
  });
});

describe('incomplete rows are kept and flagged', () => {
  it('keeps a completed ride with no end', () => {
    const { row } = buildOne({ end: '\\N' });
    expect(row.start_time).toBe('10:05');
    expect(row.end_time).toBeNull();
    expect(row.duration_minutes).toBeNull();
    expect(row.time_source).toBe('missing');
    expect(row.start_at).toBeNull();
    expect(row.review_reasons).toEqual(['missing_end']);
  });

  it('keeps a ride with no start and tells an empty cell from an unreadable one', () => {
    expect(buildOne({ start: '\\N' }).row.review_reasons).toEqual(['missing_start']);
    const unreadable = buildOne({ start: 'kaputt' });
    expect(unreadable.row.review_reasons).toEqual(['unreadable_start']);
    expect(unreadable.row.time_source).toBe('unparsed');
    expect(unreadable.stats.sampleUnreadableStart).toEqual(['kaputt']);
  });

  it('keeps a ride with no driver, with an empty name and a flag', () => {
    const { row } = buildOne({ driver: '' });
    expect(row.original_driver_name).toBe('');
    expect(row.assigned_driver_name).toBe('');
    expect(row.review_reasons).toEqual(['missing_driver']);
  });

  it('dates a ride with no "Datum der Fahrt" by its own start, and flags it', () => {
    const { row } = buildOne({ date: '\\N', start: '2026-08-02 00:05:31.000', end: '2026-08-02 00:19:10.000' });
    expect(row.trip_date).toBe('2026-08-02');
    expect(row.review_reasons).toEqual(['missing_trip_date']);
  });

  it('invents no date: a row with no date anywhere is held back and counted', () => {
    const { built, stats } = buildTripRows(context([
      uberRow({ date: '\\N', status: 'storniert', start: '\\N', end: '\\N' }),
      uberRow({}),
    ]));
    expect(built).toHaveLength(1);
    expect(stats.heldBackNoDate).toBe(1);
    expect(stats.heldBackRows).toEqual([1]);
    expect(built[0].row.trip_date).toBe('2026-08-01');
  });

  it('flags an end before the start', () => {
    const { row } = buildOne({ start: '2026-08-01 10:19:02.000', end: '2026-08-01 10:05:31.000' });
    expect(row.review_reasons).toEqual(['end_before_start']);
  });

  it('refuses a clock reading outside the day instead of passing it to the database', () => {
    expect(parseTime('25:10')).toBeNull();
    expect(parseTime('10:75')).toBeNull();
    expect(parseTime('24:00')).toBe('24:00');
    expect(parseTime('2026-08-01 10:05:31.000')).toBe('10:05');
  });

  it('writes the reasons in one fixed order', () => {
    const { row } = buildOne({ status: 'unterwegs', start: '\\N', end: 'kaputt', driver: '' });
    expect(row.review_reasons).toEqual(['missing_start', 'unreadable_end', 'missing_driver', 'unknown_status']);
  });
});

describe('currency and price', () => {
  it('assumes EUR, says it assumed it, and leaves the fare as read', () => {
    const { row } = buildOne({ fare: 41.47, payment: 'Bar' });
    expect(row.currency).toBe('EUR');
    expect(row.currency_source).toBe('assumed');
    expect(row.price_amount).toBe(41.47);
    expect(row.cash_amount).toBe(41.47);
    expect(row.online_amount).toBe(0);
  });

  it('keeps a cancelled ride\'s fee as its price and books it to neither cash nor online', () => {
    const { row } = buildOne({ status: 'storniert', start: '\\N', end: '\\N', fare: 5, payment: 'Bar' });
    expect(row.price_amount).toBe(5);
    expect(row.cash_amount).toBe(0);
    expect(row.online_amount).toBe(0);
  });
});

describe('the file hash and the row key', () => {
  it('computes SHA-256 as the standard says', async () => {
    expect(await sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256HexOfBytes(new Uint8Array([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('finds the order-transmission column by its exact name only', () => {
    expect(findOrderTransmissionColumn([...HEADERS])).toBe('Uhrzeit der Auftragsuebermittlung');
    expect(findOrderTransmissionColumn(['Uhrzeit der Auftragsübermittlung'])).toBe('Uhrzeit der Auftragsübermittlung');
    expect(findOrderTransmissionColumn(['Standort des Fahrzeugs bei Auftragsuebermittlung'])).toBe('');
  });

  it('keys a row by its order time, driver and plate when the file has an order time', () => {
    const key = sourceRowKeyMaterial({ orderTransmission: '2026-08-01 09:00:01.000', driverName: 'Fahrer Eins', startWallText: null, plate: 'X-TS 101' });
    expect(key?.basis).toBe('derived_order_transmission');
    const same = sourceRowKeyMaterial({ orderTransmission: ' 2026-08-01 09:00:01.000 ', driverName: '  fahrer   EINS ', startWallText: '2026-08-01 10:05:31', plate: 'xts101' });
    expect(same?.material).toBe(key?.material);
    const otherDriver = sourceRowKeyMaterial({ orderTransmission: '2026-08-01 09:00:01.000', driverName: 'Fahrer Zwei', startWallText: null, plate: 'X-TS 101' });
    expect(otherDriver?.material).not.toBe(key?.material);
  });

  it('keys by start, driver and plate without an order time, and not at all with neither', () => {
    const key = sourceRowKeyMaterial({ orderTransmission: '\\N', driverName: 'Fahrer Eins', startWallText: '2026-08-01 10:05:31', plate: 'X-TS 101' });
    expect(key?.basis).toBe('derived_driver_start_plate');
    expect(sourceRowKeyMaterial({ orderTransmission: null, driverName: 'Fahrer Eins', startWallText: null, plate: null })).toBeNull();
    expect(normaliseDriverName('  Max   Müller ')).toBe('max müller');
    expect(normalisePlate('b-ab 123')).toBe('BAB123');
  });

  it('drops the second copy of a ride within one file', async () => {
    const twin = uberRow({ order: '2026-08-01 09:30:00.000' });
    const { built } = buildTripRows(context([twin, { ...twin }, uberRow({})]));
    const { rows, inFileDuplicates } = await applySourceRowKeys(built);
    expect(inFileDuplicates).toBe(1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source_row_key).toMatch(/^[0-9a-f]{64}$/);
      expect(r.source_row_key_basis).toBe('derived_order_transmission');
    }
  });

  it('refuses the rows a stored import already holds', async () => {
    const { built } = buildTripRows(context([uberRow({}), uberRow({})]));
    const { rows } = await applySourceRowKeys(built);
    const result = withoutStoredKeys(rows, new Set([rows[0].source_row_key as string]));
    expect(result.refused).toBe(1);
    expect(result.rows).toEqual([rows[1]]);
  });

  it('gives a row without key material no key, and never drops it as a duplicate', async () => {
    const noKey = { ...uberRow({ status: 'storniert', start: '\\N', end: '\\N' }), 'Uhrzeit der Auftragsuebermittlung': '\\N' };
    const { built } = buildTripRows(context([noKey, { ...noKey }]));
    const { rows, inFileDuplicates } = await applySourceRowKeys(built);
    expect(inFileDuplicates).toBe(0);
    expect(rows.map(r => r.source_row_key)).toEqual([null, null]);
    expect(rows.map(r => r.source_row_key_basis)).toEqual([null, null]);
  });
});

describe('dates', () => {
  it('refuses a day the calendar does not have instead of passing it to the database', () => {
    expect(parseDate('2026-08-01')).toBe('2026-08-01');
    expect(parseDate('01.08.2026')).toBe('2026-08-01');
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('45.13.2026')).toBeNull();
    expect(parseDate('2026-02-29')).toBeNull();
    expect(parseDate('2028-02-29')).toBe('2028-02-29');
    expect(parseDate('\\N')).toBeNull();
  });
});

/*
  The migration's backfill applies these rules to the trips stored before it
  (tests/rls/fahrtenbuch-import.sql runs the same cases in SQL). These read the
  migration's text, so the day one side changes and the other does not, the
  build fails here rather than in a month's payroll.
*/
describe('the migration derives what the browser derives', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const migration = read('../../supabase/migrations/20260922100000_fahrtenbuch_import_reliability.sql');
  const quoted = (list: string) => [...list.matchAll(/'([^']*)'/g)].map(m => m[1]);

  /*
    `review_reasons` is the one list here that a LATER migration redefines:
    `20261023170000` widened the CHECK to admit a ninth reason, and the next
    one will widen it again. So that assertion must read the NEWEST migration
    that defines the set, not the one that introduced it -- the rule
    `rolePageKeys.test.ts` and `planFeatures.test.ts` already follow for the
    two other lists this codebase holds in both a migration and TypeScript.
    Everything else in this block still reads 20260922100000, which is where it
    lives and where it has not moved.
  */
  const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const newestDefining = (needle: string) => {
    const hits = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => readFileSync(join(migrationsDir, f), 'utf8').includes(needle))
      .sort();
    if (hits.length === 0) throw new Error(`no migration defines ${needle}`);
    return { file: hits[hits.length - 1], text: readFileSync(join(migrationsDir, hits[hits.length - 1]), 'utf8') };
  };
  const sqlConstant = (name: string) => {
    const m = migration.match(new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`));
    if (!m) throw new Error(`${name} not found in the migration`);
    return quoted(m[1]);
  };

  it('finds the start and end cells with the tokens resolveActualRideWindow uses', () => {
    expect(sqlConstant('c_start_tokens')).toEqual(ACTUAL_START_TOKENS);
    expect(sqlConstant('c_end_tokens')).toEqual(ACTUAL_END_TOKENS);
  });

  it('never reads a column planningQualityChecks refuses', () => {
    const source = read('./planningQualityChecks.ts');
    const m = source.match(/const REJECT_COL_FRAGMENTS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    expect(sqlConstant('c_reject_fragments')).toEqual(quoted((m as RegExpMatchArray)[1]));
  });

  it('reads a status word by the same three lists, in the newest migration that says so', () => {
    // `fahrtenbuch_map_status` is the second list here that a LATER migration
    // redefines: `20261027140000` taught it `abgelehnt`. So this assertion
    // reads the NEWEST definition, like the `review_reasons` one below — and
    // it is named, so a failure says which file was read instead of leaving
    // the next reader to guess whether the list moved or the parser did.
    const newest = newestDefining('FUNCTION app_private.fahrtenbuch_map_status');
    expect(newest.file).toBe('20261027140000_declined_trip_status.sql');
    const listIn = (name: string) => {
      const m = newest.text.match(new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`));
      if (!m) throw new Error(`${name} not found in ${newest.file}`);
      return quoted(m[1]);
    };
    expect(listIn('c_completed_words')).toEqual([...COMPLETED_STATUS_WORDS]);
    expect(listIn('c_cancelled_words')).toEqual([...CANCELLED_STATUS_WORDS]);
    expect(listIn('c_declined_words')).toEqual([...DECLINED_STATUS_WORDS]);
    // The list that introduced them is still the list it introduced: a
    // restatement that dropped a word would pass the three above only by
    // dropping it on both sides, and this is what catches that.
    expect(sqlConstant('c_completed_words')).toEqual([...COMPLETED_STATUS_WORDS]);
    expect(sqlConstant('c_cancelled_words')).toEqual([...CANCELLED_STATUS_WORDS]);
    // The old importer's CANCELED_STATUSES, minus the one normalisation made
    // unreachable ('nichtdurchgeführt').
    expect(CANCELLED_STATUS_WORDS).toEqual([
      'storno', 'storniert', 'storniertfahrt', 'stornierung',
      'cancelled', 'canceled', 'abgebrochen', 'nichtdurchgefuhrt',
    ]);
  });

  it('reads timestamps with the same three patterns', () => {
    expect(migration).toContain(`'${DATETIME_RE.source}'`);
    expect(migration).toContain(`'${GERMAN_DATETIME_RE.source}'`);
    expect(migration).toContain(`'${TIME_RE.source}'`);
  });

  it('allows exactly the review reasons the parser writes, in the newest migration that says so', () => {
    const newest = newestDefining('review_reasons <@ ARRAY[');
    // Named, so a failure says which file was read rather than leaving the
    // next reader to guess whether the list moved or the parser did.
    expect(newest.file).toBe('20261023170000_review_reason_order_transmission.sql');
    const reasons = newest.text.match(/review_reasons <@ ARRAY\[([^\]]*)\]/);
    expect(quoted((reasons as RegExpMatchArray)[1])).toEqual([...REVIEW_REASONS]);
    // And the migration that INTRODUCED the set still names the eight it knew,
    // so this assertion moving is always a deliberate widening and never a
    // rewrite of history: 20260922100000 ran once on every live database.
    const first = migration.match(/review_reasons <@ ARRAY\[([^\]]*)\]/);
    expect(quoted((first as RegExpMatchArray)[1])).toEqual(
      REVIEW_REASONS.filter(r => r !== 'unreadable_order_transmission'),
    );
  });

  it('allows exactly the time sources and statuses the parser writes', () => {
    const sources = migration.match(/CHECK \(time_source IN \(([^)]*)\)\)/);
    expect(quoted((sources as RegExpMatchArray)[1])).toEqual([...TIME_SOURCES]);
    const statuses = migration.match(/trip_status IN \(([^)]*)\)/);
    expect(quoted((statuses as RegExpMatchArray)[1])).toEqual([...TRIP_STATUSES]);
  });
});

describe('the preview counts', () => {
  it('counts completed, cancelled, unknown and review over the rows to be written', () => {
    const { built } = buildTripRows(context([
      uberRow({}),
      uberRow({ status: 'storniert', start: '\\N', end: '\\N' }),
      uberRow({ status: 'unterwegs' }),
      uberRow({ end: '\\N' }),
    ]));
    const summary = summariseRows(built.map(b => b.row));
    expect(summary).toMatchObject({ completed: 2, cancelled: 1, unknown: 1, needsReview: 2 });
    expect(summary.reasons.unknown_status).toBe(1);
    expect(summary.reasons.missing_end).toBe(1);
    expect(summary.timeSources).toMatchObject({ source_start_end: 2, missing: 2 });
  });
});

/*
  The wizard's step 2 picks which driver an imported name means. Until 28.09.2026
  it took the first driver in the company's list whose normalised name contained
  the imported one, or was contained in it, and marked the pair confirmed — so
  canGoNext let the step through and a month of rides was attributed without
  anyone looking.

  Measured 28.09.2026, production and staging alike: of 13,959 stored rides, 0
  carry the matcher's footprint — a ride whose assigned driver is still the one
  the import picked, while the file's name and that driver's name do not normalise
  alike. (Comparing against `drivers.name` as it reads today answers 9 instead,
  and all 9 are one staging driver renamed to 'probe-rename' after its import,
  which is why the comparison is made against the ride's own
  assigned_driver_name.) So every case below is latent, not a repair.

  `legacyFirstHit` is the code as it stood, kept here as the negative control:
  each test states what it answered, so a return to first-hit semantics fails the
  matchDriverName assertion beside it rather than passing unnoticed.
*/
interface TestDriver { id: string; name: string }

function legacyFirstHit(
  name: string,
  drivers: readonly TestDriver[],
): { matchedDriverId: string | null; confirmed: boolean } {
  const norm = normalise(name);
  const found = drivers.find(d =>
    normalise(d.name) === norm ||
    normalise(d.name).includes(norm) ||
    norm.includes(normalise(d.name))
  );
  return { matchedDriverId: found?.id || null, confirmed: !!found };
}

const THREE_DRIVERS: TestDriver[] = [
  { id: 'd1', name: 'Ali Hassan' },
  { id: 'd2', name: 'Alia Demir' },
  { id: 'd3', name: 'Bekir Yilmaz' },
];

describe('matching an imported driver name', () => {
  it('confirms a name a driver actually carries', () => {
    expect(matchDriverName('Ali Hassan', THREE_DRIVERS)).toEqual({
      kind: 'exact', driverId: 'd1', driverName: 'Ali Hassan',
    });
    expect(driverMatchInfo('Ali Hassan', THREE_DRIVERS)).toEqual({
      matchedDriverId: 'd1', matchedDriverName: 'Ali Hassan', confirmed: true,
    });
    // Spelling does not have to agree: normalise keeps [a-z0-9] only.
    expect(matchDriverName('  ali-hassan ', THREE_DRIVERS)).toMatchObject({ kind: 'exact', driverId: 'd1' });
  });

  it('offers a single near-match but leaves it for the user to confirm', () => {
    expect(matchDriverName('Bekir', THREE_DRIVERS)).toEqual({
      kind: 'suggestion', driverId: 'd3', driverName: 'Bekir Yilmaz',
    });
    expect(driverMatchInfo('Bekir', THREE_DRIVERS)).toEqual({
      matchedDriverId: 'd3', matchedDriverName: 'Bekir Yilmaz', confirmed: false,
    });
    // Negative control: the old matcher confirmed exactly this pair, which is
    // what let a shortened name through step 2 with nobody looking at it.
    expect(legacyFirstHit('Bekir', THREE_DRIVERS)).toEqual({ matchedDriverId: 'd3', confirmed: true });
  });

  it('offers nothing when two drivers could be meant, and does not depend on list order', () => {
    const reversed = [THREE_DRIVERS[1], THREE_DRIVERS[0], THREE_DRIVERS[2]];
    expect(matchDriverName('Ali', THREE_DRIVERS)).toEqual({ kind: 'ambiguous' });
    expect(matchDriverName('Ali', reversed)).toEqual({ kind: 'ambiguous' });
    expect(driverMatchInfo('Ali', THREE_DRIVERS)).toEqual({
      matchedDriverId: null, matchedDriverName: 'Ali', confirmed: false,
    });
    // Negative control: "Ali" is a substring of both "Ali Hassan" and
    // "Alia Demir", so the old matcher confirmed whichever the company's driver
    // list happened to hold first — a different person for the same file.
    expect(legacyFirstHit('Ali', THREE_DRIVERS)).toEqual({ matchedDriverId: 'd1', confirmed: true });
    expect(legacyFirstHit('Ali', reversed)).toEqual({ matchedDriverId: 'd2', confirmed: true });
  });

  it('offers nothing when two drivers normalise to the same name', () => {
    const twins: TestDriver[] = [
      { id: 'a', name: 'Max Müller' },
      { id: 'b', name: 'MaxMüller' },
    ];
    expect(normalise('Max Müller')).toBe(normalise('MaxMüller'));
    expect(matchDriverName('Max Müller', twins)).toEqual({ kind: 'ambiguous' });
    // Negative control: the old matcher confirmed the first of the two.
    expect(legacyFirstHit('Max Müller', twins)).toEqual({ matchedDriverId: 'a', confirmed: true });
  });

  it('offers nothing for a name that names nobody', () => {
    expect(matchDriverName('Zoe Schmidt', THREE_DRIVERS)).toEqual({ kind: 'none' });
    expect(driverMatchInfo('Zoe Schmidt', THREE_DRIVERS)).toEqual({
      matchedDriverId: null, matchedDriverName: 'Zoe Schmidt', confirmed: false,
    });
    // The old matcher agreed here — this is the one case it got right.
    expect(legacyFirstHit('Zoe Schmidt', THREE_DRIVERS)).toEqual({ matchedDriverId: null, confirmed: false });
  });

  it('matches nobody to a cell that normalises to nothing', () => {
    // isMissingCell only drops an empty cell and the \N marker, so a driver
    // column holding "-" reaches the matcher as the name "-".
    expect(isMissingCell('-')).toBe(false);
    expect(normalise('-')).toBe('');
    expect(matchDriverName('-', THREE_DRIVERS)).toEqual({ kind: 'none' });
    // Negative control: '' is a substring of every name, so the old matcher
    // confirmed the first driver in the list for a cell naming nobody.
    expect(legacyFirstHit('-', THREE_DRIVERS)).toEqual({ matchedDriverId: 'd1', confirmed: true });
  });

  it('never treats a driver whose own name normalises to nothing as a candidate', () => {
    const withBlank: TestDriver[] = [{ id: 'x', name: '---' }, THREE_DRIVERS[0]];
    expect(matchDriverName('Ali', withBlank)).toEqual({
      kind: 'suggestion', driverId: 'd1', driverName: 'Ali Hassan',
    });
    // Negative control: every name contains '', so the old matcher answered the
    // blank-named driver for every imported name and confirmed it.
    expect(legacyFirstHit('Ali', withBlank)).toEqual({ matchedDriverId: 'x', confirmed: true });
  });

  it('leaves normalise alone: an umlaut still does not match its transcription', () => {
    /*
      Characterization, not a wish. normalise drops every character outside
      [a-z0-9], so "Müller" becomes "mller" and "Muller" becomes "muller" and
      neither contains the other. The pair therefore reaches the user unmatched,
      which is safe. Widening normalise is a separate decision: the importer reads
      headers and status words with the same function, and normaliseDriverName —
      which does keep the letters — feeds source_row_key and must not be used
      here.
    */
    const one: TestDriver[] = [{ id: 'm', name: 'Max Muller' }];
    expect(matchDriverName('Max Müller', one)).toEqual({ kind: 'none' });
    expect(legacyFirstHit('Max Müller', one)).toEqual({ matchedDriverId: null, confirmed: false });
  });
});

describe('an order-transmission cell that is not a timestamp (FB-HIGH-001)', () => {
  /*
    The audited month carried 52 cells of "Uhrzeit der Auftragsuebermittlung"
    with two decimal points. DATETIME_RE admits one fractional group, so such a
    value does not parse — and this column is parsed into no column of the
    trip: it is hashed as text into source_row_key and copied into
    raw_data_json. Before this count nothing anywhere said that a row holds an
    order time which cannot be read.

    The row is still kept and no value is invented. Since 20261023170000 it is
    also FLAGGED: that migration widened fahrtenbuch_trips_review_check to
    admit a ninth value, 'unreadable_order_transmission', and these tests pin
    both halves -- the count the wizard shows before the operator confirms, and
    the reason written onto the row.

    The flag keys on classifyTimestampCell answering 'other', never on "fails
    the timestamp patterns": an empty cell and the null marker both answer
    'empty', and nothing to read is not the same as something unreadable.
    Measured on staging, that distinction is worth exactly three rows -- a SQL
    regex over the stored text counts 372 where the parser counts 369, and the
    extra three hold the null marker and are real customer rows, not simulated.

    The name is not unreadable_start, because the ride's start IS readable;
    saying otherwise would put a false statement on a row that feeds the
    Stundennachweis.
  */
  const MALFORMED = '2026-10-01 18:49:25.441.665771484375';
  const ALSO_MALFORMED = '2026-10-01 18:55:41.929.50390625';

  it('counts the row and keeps an example of what the cell held', () => {
    const { stats } = buildTripRows(context([
      uberRow({ order: MALFORMED }),
      uberRow({ order: '2026-10-01 18:30:00.146' }),
      uberRow({ order: ALSO_MALFORMED }),
    ]));
    expect(stats.unreadableOrderTransmission).toBe(2);
    expect(stats.sampleUnreadableOrderTransmission).toEqual([MALFORMED, ALSO_MALFORMED]);
  });

  it('keeps the row, invents no time, and still gives it its key', () => {
    const { built, stats } = buildTripRows(context([uberRow({ order: MALFORMED })]));
    expect(built.length).toBe(1);
    expect(stats.unreadableOrderTransmission).toBe(1);
    expect(built[0].row.source_row_key_basis).toBe('derived_order_transmission');
    expect(built[0].keyMaterial).toContain(MALFORMED);
    // Start and end are untouched: those columns were readable.
    expect(built[0].row.time_source).toBe('source_start_end');
    expect(built[0].row.start_at).not.toBeNull();
  });

  it('flags the row, and names only the cell that could not be read', () => {
    const { built } = buildTripRows(context([uberRow({ order: MALFORMED })]));
    expect(built[0].row.review_reasons).toEqual(['unreadable_order_transmission']);
    expect(built[0].row.needs_review).toBe(true);
    // NOT unreadable_start: the ride's own start parsed, and claiming it did
    // not would be a false statement on the row.
    expect(built[0].row.start_time).not.toBeNull();
    expect(built[0].row.end_time).not.toBeNull();
  });

  it('does not change how the row is keyed or deduped', () => {
    // Measured on staging: all 369 rows whose order cell the parser cannot
    // read are keyed, all with basis derived_order_transmission, and all 369
    // keys are distinct. The key hashes the cell as TEXT, so a malformed value
    // hashes like any other and the per-company dedupe is unaffected -- the
    // flag is a statement about the row, not about its key.
    const flagged = buildTripRows(context([uberRow({ order: MALFORMED })]));
    const clean = buildTripRows(context([uberRow({ order: '2026-10-01 18:30:00.146' })]));
    expect(flagged.built[0].row.source_row_key_basis)
      .toBe(clean.built[0].row.source_row_key_basis);
    expect(flagged.built[0].keyMaterial).not.toBe(clean.built[0].keyMaterial);
    expect(flagged.built[0].keyMaterial).toBeTruthy();
  });

  it('takes its place last in the canonical order, beside the other reasons', () => {
    const { built } = buildTripRows(context([
      uberRow({ order: MALFORMED, driver: '', status: 'wer weiss' }),
    ]));
    expect(built[0].row.review_reasons).toEqual([
      'missing_driver', 'unknown_status', 'unreadable_order_transmission',
    ]);
    expect(built[0].row.needs_review).toBe(true);
  });

  it('reports nothing for a value the published format accepts, a longer fraction included', () => {
    const { stats } = buildTripRows(context([
      uberRow({ order: '2026-10-01 18:30:00.146' }),
      uberRow({ order: '2026-10-01 18:30:01.146789' }),
      uberRow({ order: '2026-10-01 18:30:02' }),
      uberRow({ order: '01.10.2026 18:30:03' }),
    ]));
    expect(stats.unreadableOrderTransmission).toBe(0);
    expect(stats.sampleUnreadableOrderTransmission).toEqual([]);
  });

  it('flags no row for a value the published format accepts', () => {
    const { built } = buildTripRows(context([
      uberRow({ order: '2026-10-01 18:30:00.146' }),
      uberRow({ order: '01.10.2026 18:30:03' }),
    ]));
    expect(built.map(b => b.row.review_reasons)).toEqual([[], []]);
    expect(built.map(b => b.row.needs_review)).toEqual([false, false]);
  });

  it('reports nothing for an empty cell, for the null marker, or for a file with no such column', () => {
    const empty = buildTripRows(context([uberRow({ order: '\\N' }), uberRow({ order: '' })]));
    expect(empty.stats.unreadableOrderTransmission).toBe(0);
    const noColumn = buildTripRows(context([uberRow({ order: MALFORMED })], { orderTransmissionCol: '' }));
    expect(noColumn.stats.unreadableOrderTransmission).toBe(0);
    expect(noColumn.built[0].row.source_row_key_basis).toBe('derived_driver_start_plate');
  });

  it('FLAGS no row for an empty cell or the null marker either, which is the three-row difference', () => {
    // isMissingCell recognises the two-character null marker, so
    // classifyTimestampCell answers 'empty' and not 'other'. Three REAL
    // (non-simulated) staging rows hold it, and a SQL regex over the stored
    // text counts them as malformed where the parser does not -- which is why
    // the flag keys on the classification and not on a pattern match.
    const { built } = buildTripRows(context([
      uberRow({ order: '\\N' }), uberRow({ order: '' }),
    ]));
    expect(built.map(b => b.row.review_reasons)).toEqual([[], []]);
    expect(built.map(b => b.row.needs_review)).toEqual([false, false]);
    // A file with no such column at all flags nothing either: there is no cell.
    const noColumn = buildTripRows(context([uberRow({ order: MALFORMED })], { orderTransmissionCol: '' }));
    expect(noColumn.built[0].row.review_reasons).toEqual([]);
    expect(noColumn.built[0].row.needs_review).toBe(false);
  });
});
