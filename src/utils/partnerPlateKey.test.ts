import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isValidKennzeichen, normalise } from './fahrtenbuchImportParser'

/*
  `app_private.plate_key` (20261013120000) is the SQL twin of this file's two
  functions: it resolves the plate a driver's app sends to one of our cars the
  way FahrtenbuchImportModal.buildCarMatches resolves a plate in an import.

  The key the browser would compute: `normalise` of a value that
  `isValidKennzeichen` accepts, null otherwise. The same samples are asserted in
  the migration's self-check against the SQL function, and this test fails when
  a sample is edited on one side only.
*/
const browserKey = (raw: string | null): string | null => {
  if (!isValidKennzeichen(raw)) return null
  const key = normalise(String(raw))
  return key === '' ? null : key
}

const KEYED: Array<[string, string]> = [
  ['B-XX 1234', 'bxx1234'],
  ['b xx1234', 'bxx1234'],
  ['  B-XX-1234  ', 'bxx1234'],
  ['M-AB 12E', 'mab12e'],
]
const NO_VEHICLE: Array<string | null> = [
  null, '', '   ', 'null', 'NULL', 'undefined', '\\N', '12345678', '52.52 13.40', '- -',
]

const migration = readFileSync(
  new URL('../../supabase/migrations/20261013120000_partner_note_all_types_and_vehicle.sql', import.meta.url),
  'utf8',
)

describe('the plate key', () => {
  it.each(KEYED)('%s has the key %s in the browser', (raw, key) => {
    expect(browserKey(raw)).toBe(key)
  })

  it.each(NO_VEHICLE)('%j names no vehicle in the browser', (raw) => {
    expect(browserKey(raw)).toBeNull()
  })

  it('keeps two different plates apart', () => {
    expect(browserKey('B-XX 1234')).not.toBe(browserKey('B-XX 1235'))
  })

  it('is asserted on the same samples by the migration self-check', () => {
    for (const [raw, key] of KEYED) {
      expect(migration).toContain(`plate_key('${raw}') IS DISTINCT FROM '${key}'`)
    }
    for (const raw of NO_VEHICLE) {
      if (raw === null) continue // NULL has its own spelling in SQL
      expect(migration).toContain(`plate_key('${raw}') IS NOT NULL`)
    }
  })

  it('normalises the way normalise() does: lower case, letters and digits only', () => {
    expect(migration).toContain("regexp_replace(lower(p_plate), '[^a-z0-9]', '', 'g')")
  })
})
