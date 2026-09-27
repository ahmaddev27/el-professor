/**
 * A ride's start and end must be read by COLUMN NAME, never by the position of
 * an ISO-shaped value inside raw_data_json.
 *
 * The key order below is not invented. It was measured on staging on 27.09.2026
 * over all 13959 imported rides: for 13513 of them (96.8%) the FIRST ISO-shaped
 * value in raw_data_json is `Uhrzeit des Fahrtendes` — the ride's END — and the
 * second is `Uhrzeit des Fahrtbeginns`. Reading by position therefore produced
 * start = end and end = start.
 *
 *   nth | key                            | rides
 *   ----|--------------------------------|------
 *    1  | Uhrzeit des Fahrtendes         | 13513
 *    1  | Datum/Uhrzeit Auftragseingang  |   264
 *    1  | Geplante Abholzeit             |   173
 *    1  | Uhrzeit des Fahrtbeginns       |     9
 *    2  | Uhrzeit des Fahrtbeginns       | 13513
 *
 * The second test is the negative control: it runs the arithmetic that shipped,
 * so if a later change reintroduces positional reading, that test fails loudly
 * instead of the summary quietly emptying itself.
 */
import { describe, it, expect } from 'vitest'
import { resolveFullDatetime, parseFullDatetimeMs } from './historicalWorkingHoursCleanEngine'
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch'

/** One ride in staging's real column order: end first, start second. */
function stagingShapedTrip(overrides: Partial<FahrtenbuchTrip> = {}): FahrtenbuchTrip {
  return {
    id: 'trip-1',
    trip_date: '2026-08-01',
    start_time: '22:40:00',
    end_time: '23:05:00',
    raw_data_json: {
      'Datum der Fahrt': '01.08.2026',
      'Uhrzeit des Fahrtendes': '2026-08-01 23:05:00.000',
      'Uhrzeit des Fahrtbeginns': '2026-08-01 22:40:00.000',
      'Datum/Uhrzeit Auftragseingang': '2026-08-01 22:31:00.000',
    },
    ...overrides,
  } as FahrtenbuchTrip
}

/** The arithmetic that shipped, kept verbatim so it can be seen to fail. */
function positionalTimestamps(trip: FahrtenbuchTrip): { startMs: number; endMs: number } {
  const raw = trip.raw_data_json as Record<string, unknown> | null
  let startMs = 0
  let endMs = 0
  if (raw) {
    const datetimeLike: string[] = []
    for (const k of Object.keys(raw)) {
      const v = String(raw[k] ?? '')
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) datetimeLike.push(v)
    }
    if (datetimeLike.length >= 1) startMs = Date.parse(datetimeLike[0].replace(' ', 'T')) || 0
    if (datetimeLike.length >= 2) endMs = Date.parse(datetimeLike[1].replace(' ', 'T')) || 0
  }
  return { startMs, endMs }
}

describe('reading a ride’s start and end', () => {
  it('reads the named columns, so the start is the start', () => {
    const trip = stagingShapedTrip()
    const startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'))
    const endMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'end'))

    expect(new Date(startMs).toISOString()).toBe(new Date('2026-08-01T22:40:00').toISOString())
    expect(new Date(endMs).toISOString()).toBe(new Date('2026-08-01T23:05:00').toISOString())
    expect(endMs).toBeGreaterThan(startMs)
    expect((endMs - startMs) / 60000).toBe(25)
  })

  it('NEGATIVE CONTROL: reading by position swaps them, which addLohnart drops', () => {
    const { startMs, endMs } = positionalTimestamps(stagingShapedTrip())

    // The end read as the start, and the start read as the end.
    expect(new Date(startMs).toISOString()).toBe(new Date('2026-08-01T23:05:00').toISOString())
    expect(new Date(endMs).toISOString()).toBe(new Date('2026-08-01T22:40:00').toISOString())

    // addLohnart's guard is `if (endMs <= startMs) return`, so this ride never
    // reached computeLohnartSeconds and contributed nothing at all.
    expect(endMs).toBeLessThan(startMs)
  })

  it('accepts the German DD.MM.YYYY HH:MM form the sheet also produces', () => {
    const trip = stagingShapedTrip({
      raw_data_json: {
        'Uhrzeit des Fahrtendes': '01.08.2026 23:05',
        'Uhrzeit des Fahrtbeginns': '01.08.2026 22:40',
      },
    } as Partial<FahrtenbuchTrip>)

    const startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'))
    const endMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'end'))
    expect((endMs - startMs) / 60000).toBe(25)
  })

  it('falls back to trip_date plus start_time when raw_data_json has no datetimes', () => {
    const trip = stagingShapedTrip({
      raw_data_json: { 'Datum der Fahrt': '01.08.2026', Kennzeichen: 'B-XX-1234' },
    } as Partial<FahrtenbuchTrip>)

    const startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'))
    const endMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'end'))
    expect((endMs - startMs) / 60000).toBe(25)
  })

  it('reads the start from the named column even when it is the only datetime', () => {
    // The 9 staging rides whose first ISO value is already the start must not
    // change behaviour: the named read gives the same answer as before.
    const trip = stagingShapedTrip({
      raw_data_json: {
        'Uhrzeit des Fahrtbeginns': '2026-08-01 22:40:00.000',
        'Uhrzeit des Fahrtendes': '2026-08-01 23:05:00.000',
      },
    } as Partial<FahrtenbuchTrip>)

    const startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'))
    expect(new Date(startMs).toISOString()).toBe(new Date('2026-08-01T22:40:00').toISOString())
  })

  it('a ride over midnight keeps a positive duration', () => {
    const trip = stagingShapedTrip({
      trip_date: '2026-08-01',
      start_time: '23:45:00',
      end_time: '00:15:00',
      raw_data_json: {
        'Uhrzeit des Fahrtendes': '2026-08-02 00:15:00.000',
        'Uhrzeit des Fahrtbeginns': '2026-08-01 23:45:00.000',
      },
    } as Partial<FahrtenbuchTrip>)

    const startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'))
    const endMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'end'))
    expect((endMs - startMs) / 60000).toBe(30)
  })
})
