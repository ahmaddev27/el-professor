import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTUAL_END_TOKENS, ACTUAL_START_TOKENS } from './planningQualityChecks';
import {
  CANCELLED_STATUS_WORDS,
  COMPLETED_STATUS_WORDS,
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
  findOrderTransmissionColumn,
  isMissingCell,
  mapTripStatus,
  normaliseDriverName,
  normalisePlate,
  parseDate,
  parseTime,
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
      // duration_minutes keeps its old rule (HH:MM arithmetic); start_at/end_at are the real length.
      expect(row.duration_minutes).toBe(80);
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

  it('reads a status word by the same two lists', () => {
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

  it('allows exactly the review reasons, time sources and statuses the parser writes', () => {
    const reasons = migration.match(/review_reasons <@ ARRAY\[([^\]]*)\]/);
    expect(quoted((reasons as RegExpMatchArray)[1])).toEqual([...REVIEW_REASONS]);
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
