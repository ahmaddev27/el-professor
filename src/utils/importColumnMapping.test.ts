/*
  The per-company memory of a Fahrtenbuch import's column mapping
  (20261023210000).

  Three things are pinned here, and the second is the one the feature exists
  for:

    1. what counts as the same export format (the shape key), including the
       drift it tolerates and the change it does not;
    2. that a remembered column the uploaded file has not got leaves its field
       EMPTY and is reported — never resolved to the automatic match, never to
       a different column. The case is the one measured on staging on
       23.10.2026: a company with an 18-column shape and an 11-column one whose
       headers are a strict subset of it;
    3. that the eleven fields the browser may store are the eleven the database
       admits, read out of the newest migration that defines the CHECK rather
       than written down twice (rolePageKeys.test.ts's rule).
*/
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAPPING_FIELDS,
  MAX_SOURCE_HEADERS,
  MAX_SOURCE_HEADER_LENGTH,
  REQUIRED_MAPPING_FIELDS,
  applyRememberedMapping,
  emptyColMap,
  fieldMapOf,
  isStorableMapping,
  parseFieldMap,
  parseSourceHeaders,
  sourceShapeKey,
  sourceShapeMaterial,
  type FieldMap,
  type StoredColumnMapping,
} from './importColumnMapping';
import type { ColMap } from './fahrtenbuchImportParser';

// ── The two shapes one staging company really holds ──────────────────────────

/** `DEMO_Fahrtenbuch_Dezember_2026.xlsx`, read from staging on 23.10.2026. */
const WIDE_HEADERS = [
  'Datum/Uhrzeit Auftragseingang', 'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit', 'Datum der Fahrt', 'Fahrtstatus',
  'Standort des Fahrzeugs bei Auftragsuebermittlung',
  'Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes', 'Kennzeichen',
  'Fahrzeugtyp', 'Fahrername', 'Fahrpreis', 'Trinkgeld', 'Kilometer',
  'Zahlungsart', 'Abholort', 'Zielort', 'Vorreservierte Fahrt',
];

/** `DEMO_Fahrtenbuch_Oktober_2026.xlsx`: a strict subset of the above. */
const NARROW_HEADERS = [
  'Datum der Fahrt', 'Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes',
  'Kennzeichen', 'Fahrername', 'Fahrpreis', 'Trinkgeld', 'Kilometer',
  'Fahrtstatus', 'Abholort', 'Zielort',
];

/** The mapping an operator confirms on the wide file. */
const WIDE_FIELD_MAP: FieldMap = {
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

function stored(headers: string[], fieldMap: FieldMap): StoredColumnMapping {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source_shape_key: 'a'.repeat(64),
    source_headers: headers,
    field_map: fieldMap,
    updated_at: '2026-10-20T08:00:00.000Z',
  };
}

/** What the wizard's AUTO_MATCH would produce; only the parts a test needs. */
function autoMatch(partial: Partial<ColMap> = {}): ColMap {
  return { ...emptyColMap(), ...partial };
}

// ── 1. the shape key ─────────────────────────────────────────────────────────

describe('what counts as the same export format', () => {
  it('is insensitive to the order of the columns', async () => {
    const reversed = [...WIDE_HEADERS].reverse();
    expect(await sourceShapeKey(WIDE_HEADERS)).toBe(await sourceShapeKey(reversed));
  });

  it('is insensitive to case, spacing and punctuation — the drift a writer adds', async () => {
    const respelled = WIDE_HEADERS.map(h => ` ${h.toUpperCase().replace(/\//g, ' – ')}  `);
    expect(await sourceShapeKey(WIDE_HEADERS)).toBe(await sourceShapeKey(respelled));
  });

  it('changes when a column is gained or lost — that is a different format', async () => {
    const wide = await sourceShapeKey(WIDE_HEADERS);
    expect(await sourceShapeKey(NARROW_HEADERS)).not.toBe(wide);
    expect(await sourceShapeKey([...WIDE_HEADERS, 'Wartezeit'])).not.toBe(wide);
    expect(await sourceShapeKey(WIDE_HEADERS.slice(1))).not.toBe(wide);
  });

  it('cannot be made the same by two headers running together', () => {
    // normalise() strips the separators, so the newline between them is the
    // only thing keeping ['ab','c'] apart from ['a','bc'].
    expect(sourceShapeMaterial(['ab', 'c'])).not.toBe(sourceShapeMaterial(['a', 'bc']));
  });

  it('is sorted by code unit, so every browser and locale agrees', () => {
    // localeCompare would put these in a language-dependent order; the values
    // are [a-z0-9] only after normalise, so a plain sort is deterministic.
    expect(sourceShapeMaterial(['Zielort', 'Abholort'])).toBe('abholort\nzielort');
    expect(sourceShapeMaterial(['Abholort', 'Zielort'])).toBe('abholort\nzielort');
  });

  it('is a lowercase SHA-256, which is the shape the table CHECKs', async () => {
    expect(await sourceShapeKey(WIDE_HEADERS)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── 2. a remembered mapping is checked against the file, always ──────────────

describe('what step 1 opens with', () => {
  it('is the automatic match unchanged when nothing was remembered', () => {
    const auto = autoMatch({ trip_date: 'Datum der Fahrt', driver_name: 'Fahrername' });
    const out = applyRememberedMapping({ headers: WIDE_HEADERS, autoMatched: auto, stored: null });
    expect(out.colMap).toEqual(auto);
    expect(out.applied).toEqual([]);
    expect(out.missing).toEqual([]);
  });

  it('prefers the remembered column over the automatic match', () => {
    // The automatic match found "Geplante Abholzeit" for the start; the operator
    // had already corrected that to the real ride start.
    const auto = autoMatch({ start_time: 'Geplante Abholzeit' });
    const out = applyRememberedMapping({
      headers: WIDE_HEADERS, autoMatched: auto,
      stored: stored(WIDE_HEADERS, WIDE_FIELD_MAP),
    });
    expect(out.colMap.start_time).toBe('Uhrzeit des Fahrtbeginns');
    expect(out.applied).toContain('start_time');
  });

  it('keeps the automatic match for a field nobody remembered', () => {
    const remembered: FieldMap = { ...WIDE_FIELD_MAP };
    delete remembered.description;
    const auto = autoMatch({ description: 'Fahrzeugtyp' });
    const out = applyRememberedMapping({
      headers: WIDE_HEADERS, autoMatched: auto, stored: stored(WIDE_HEADERS, remembered),
    });
    expect(out.colMap.description).toBe('Fahrzeugtyp');
    expect(out.autoMatched).toContain('description');
    expect(out.applied).not.toContain('description');
  });

  /*
    THE PROPERTY THE FEATURE EXISTS FOR, on the case staging actually holds:
    the mapping was saved from the 18-column file and the 11-column one is
    imported. `Zahlungsart` and `Fahrzeugtyp` are gone, so those two fields come
    back EMPTY and are named. Were they resolved to anything at all — the
    automatic match included — a remembered mapping would silently be pointing
    at a column the operator never chose.
  */
  it('leaves a field empty and reports it when the file has not got the remembered column', () => {
    const auto = autoMatch({
      // What AUTO_MATCH would have offered for both, had it been consulted.
      payment_method: 'Fahrtstatus',
      description: 'Kilometer',
    });
    const out = applyRememberedMapping({
      headers: NARROW_HEADERS, autoMatched: auto,
      stored: stored(WIDE_HEADERS, WIDE_FIELD_MAP),
    });

    expect(out.colMap.payment_method).toBe('');
    expect(out.colMap.description).toBe('');
    expect(out.missing).toEqual([
      { field: 'payment_method', header: 'Zahlungsart' },
      { field: 'description', header: 'Fahrzeugtyp' },
    ]);
    // Everything the subset does carry is still remembered.
    expect(out.colMap.trip_date).toBe('Datum der Fahrt');
    expect(out.colMap.start_time).toBe('Uhrzeit des Fahrtbeginns');
    expect(out.colMap.end_time).toBe('Uhrzeit des Fahrtendes');
    expect(out.colMap.driver_name).toBe('Fahrername');
    expect(out.applied).toEqual([
      'trip_date', 'start_time', 'end_time', 'driver_name',
      'car_identifier', 'price_amount', 'tip_amount', 'route_start', 'route_end',
    ]);
  });

  it('blocks the wizard when a REQUIRED remembered column is gone', () => {
    // A renamed date column: the field is emptied, so REQUIRED_MAPPING_FIELDS
    // is incomplete and `canGoNext` cannot pass until a person chooses.
    const renamed = NARROW_HEADERS.map(h => (h === 'Datum der Fahrt' ? 'Fahrttag' : h));
    const out = applyRememberedMapping({
      headers: renamed,
      // AUTO_MATCH does find `Fahrttag` ('fahrttag' is one of its candidates),
      // so this is the case where the fallback would look harmless: it would
      // have filled the field with a column that happens to be right. It must
      // still come back empty, because nothing has told the operator that the
      // date column they chose last month is gone.
      autoMatched: autoMatch({ trip_date: 'Fahrttag' }),
      stored: stored(NARROW_HEADERS, WIDE_FIELD_MAP),
    });
    expect(out.colMap.trip_date).toBe('');
    expect(out.missing).toEqual(
      expect.arrayContaining([{ field: 'trip_date', header: 'Datum der Fahrt' }]),
    );
    expect(REQUIRED_MAPPING_FIELDS.every(f => out.colMap[f] !== '')).toBe(false);
  });

  it('compares the header exactly, not normalised: a respelled column is a missing one', () => {
    // The shape key tolerates respelling so the memory is found at all; the
    // field-by-field check does not, because `Fahrpreis ` and `Fahrpreis` are
    // two different keys of the parsed row object and only one of them exists.
    const respelled = WIDE_HEADERS.map(h => (h === 'Fahrpreis' ? 'FAHRPREIS' : h));
    const out = applyRememberedMapping({
      headers: respelled, autoMatched: autoMatch(),
      stored: stored(WIDE_HEADERS, WIDE_FIELD_MAP),
    });
    expect(out.colMap.price_amount).toBe('');
    expect(out.missing).toEqual(
      expect.arrayContaining([{ field: 'price_amount', header: 'Fahrpreis' }]),
    );
  });
});

// ── 3. what comes back out of the database is data, never a contract ─────────

describe('a stored row is parsed down to what is usable', () => {
  it('drops a key ColMap has not got', () => {
    expect(parseFieldMap({ trip_date: 'A', kilometer: 'B' })).toEqual({ trip_date: 'A' });
  });

  it('drops a value that is not a usable column name', () => {
    expect(parseFieldMap({
      trip_date: 'A', start_time: 42, end_time: null, driver_name: '   ',
      car_identifier: 'x'.repeat(MAX_SOURCE_HEADER_LENGTH + 1),
    })).toEqual({ trip_date: 'A' });
  });

  it('answers an empty map for anything that is not an object', () => {
    for (const value of [null, undefined, 'x', 7, ['trip_date'], true]) {
      expect(parseFieldMap(value)).toEqual({});
    }
  });

  it('keeps a header exactly as stored, spaces included', () => {
    // ` Fahrpreis` is a real header when the sheet has one; trimming it here
    // would make the row lookup miss the column it names.
    expect(parseFieldMap({ price_amount: ' Fahrpreis' })).toEqual({ price_amount: ' Fahrpreis' });
  });

  it('keeps only the strings of source_headers', () => {
    expect(parseSourceHeaders(['A', 3, null, 'B'])).toEqual(['A', 'B']);
    expect(parseSourceHeaders('A')).toEqual([]);
  });
});

// ── 4. the browser refuses what the database would ───────────────────────────

describe('what may be stored', () => {
  it('accepts the mapping the wizard confirms', () => {
    expect(isStorableMapping(WIDE_HEADERS, WIDE_FIELD_MAP)).toBe(true);
  });

  it('refuses a value that is not one of the headers, as the guard does', () => {
    expect(isStorableMapping(NARROW_HEADERS, WIDE_FIELD_MAP)).toBe(false);
  });

  it('refuses a mapping missing one of the four required fields', () => {
    for (const field of REQUIRED_MAPPING_FIELDS) {
      const short: FieldMap = { ...WIDE_FIELD_MAP };
      delete short[field];
      expect(isStorableMapping(WIDE_HEADERS, short), field).toBe(false);
    }
  });

  it('refuses headers that are blank, too long, too many or repeated', () => {
    const base: FieldMap = {
      trip_date: 'a', start_time: 'b', end_time: 'c', driver_name: 'd',
    };
    expect(isStorableMapping([], base)).toBe(false);
    expect(isStorableMapping(['a', 'b', 'c', 'd', '  '], base)).toBe(false);
    expect(isStorableMapping(['a', 'b', 'c', 'd', 'a'], base)).toBe(false);
    expect(isStorableMapping(
      ['a', 'b', 'c', 'd', 'x'.repeat(MAX_SOURCE_HEADER_LENGTH + 1)], base,
    )).toBe(false);
    const tooMany = Array.from({ length: MAX_SOURCE_HEADERS + 1 }, (_, i) => `h${i}`);
    expect(isStorableMapping([...tooMany, 'a', 'b', 'c', 'd'], base)).toBe(false);
  });

  it('refuses a joined header list that the CHECK on the table would refuse', () => {
    const fat = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(MAX_SOURCE_HEADER_LENGTH, 'x'));
    expect(isStorableMapping(
      [...fat, 'a', 'b', 'c', 'd'],
      { trip_date: 'a', start_time: 'b', end_time: 'c', driver_name: 'd' },
    )).toBe(false);
  });
});

describe('fieldMapOf', () => {
  it('carries the mapped fields and drops the unmapped ones', () => {
    const colMap = autoMatch({
      trip_date: 'Datum der Fahrt', start_time: 'Uhrzeit des Fahrtbeginns',
      end_time: 'Uhrzeit des Fahrtendes', driver_name: 'Fahrername',
    });
    expect(fieldMapOf(colMap)).toEqual({
      trip_date: 'Datum der Fahrt', start_time: 'Uhrzeit des Fahrtbeginns',
      end_time: 'Uhrzeit des Fahrtendes', driver_name: 'Fahrername',
    });
  });
});

// ── 5. the eleven fields are the eleven the database admits ──────────────────

/*
  PostgreSQL constant-folds `ARRAY['a','b']::text[]` into the array literal
  `'{a,b}'::text[]`, so the migration's text is matched as it is WRITTEN (the
  file, not the catalogue) — the self-check in the migration is what reads the
  folded form out of `pg_get_constraintdef`.
*/
const KNOWN_KEYS = /CONSTRAINT import_column_mappings_field_map_known_keys[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/;
const REQUIRED_KEYS = /CONSTRAINT import_column_mappings_field_map_required_keys[\s\S]*?ARRAY\[([\s\S]*?)\]/;

function listInMigration(pattern: RegExp): string[] {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'))
    .filter(sql => pattern.test(sql));
  if (defining.length === 0) throw new Error(`no migration defines ${pattern}`);
  const body = defining[defining.length - 1].match(pattern);
  return [...body![1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
}

describe('the fields the database admits are the fields this build sends', () => {
  it('the known-key CHECK names exactly MAPPING_FIELDS, in the same order', () => {
    expect(listInMigration(KNOWN_KEYS)).toEqual([...MAPPING_FIELDS]);
  });

  it('the required-key CHECK names exactly REQUIRED_MAPPING_FIELDS', () => {
    expect(listInMigration(REQUIRED_KEYS)).toEqual([...REQUIRED_MAPPING_FIELDS]);
  });

  it('every required field is one of the eleven', () => {
    for (const field of REQUIRED_MAPPING_FIELDS) {
      expect(MAPPING_FIELDS).toContain(field);
    }
  });

  it('MAPPING_FIELDS is exactly the keys of ColMap', () => {
    // emptyColMap() is typed `ColMap`, so a twelfth field added to the
    // interface appears here and fails until it is listed.
    expect([...MAPPING_FIELDS].sort()).toEqual(Object.keys(emptyColMap()).sort());
  });
});
