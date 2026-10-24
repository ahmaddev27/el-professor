/*
  The per-company memory of a Fahrtenbuch import's column mapping.

  The wizard's step 1 has a <select> per system field over the uploaded file's
  headers, pre-filled by `AUTO_MATCH` and overridable by the operator. Until
  20261023210000 that choice lived in React state and `reset()` cleared it, so a
  company whose export names its columns differently redid the same eleven
  overrides every month.

  This module is the pure half: what identifies a file's *shape*, what a stored
  mapping may hold, and what happens when a stored mapping no longer fits the
  file in front of the operator. It reads no database and renders nothing; the
  table and its rules are `public.import_column_mappings`, the read and the
  write are `useFahrtenbuch`, and the notices are the wizard's.

  THE SHAPE KEY IS ORDER- AND SPELLING-INSENSITIVE, AND THAT IS DELIBERATE.
  `normalise()` (the importer's own: lowercase, [a-z0-9] only) is applied to
  every header, the results are sorted and joined, and the key is the SHA-256 of
  that. So a reordered sheet, a changed case, a stray space or a hyphen that
  became an en dash all keep the same memory, while a file that GAINED or LOST a
  column is a different shape with a memory of its own. Measured on staging on
  23.10.2026: one company has eight imports of one 18-column shape, and one has
  two shapes — an 11-column file whose headers are a strict subset of its
  18-column one, every shared name identical. Keying on the company alone would
  have let those two overwrite each other's mapping every time.

  A STORED MAPPING IS A PROPOSAL AND IS CHECKED AGAINST THE FILE, ALWAYS.
  `applyRememberedMapping` never puts a header into the mapping that the file
  does not actually have: such a field comes back empty and is listed in
  `missing`, for the wizard to name. Falling back to the automatic match for it
  would be the one thing this feature must not do — quietly mapping a different
  column than the operator chose — and for the four required fields the wizard's
  own `canGoNext` then blocks until a person chooses.
*/
import { normalise, sha256HexOfText, type ColMap } from './fahrtenbuchImportParser';

/**
 * The system fields a mapping may name, in the order the wizard draws them.
 *
 * Typed as `keyof ColMap` and spelled out rather than taken from an object's
 * keys at runtime, so a twelfth field added to `ColMap` fails to compile here
 * until it is listed — and the `import_column_mappings_field_map_known_keys`
 * CHECK in 20261023210000 is the database's copy of the same list, which
 * `importColumnMapping.test.ts` compares against (rolePageKeys.test.ts's rule:
 * the newest migration that defines the list is the one that is read).
 */
export const MAPPING_FIELDS: readonly (keyof ColMap)[] = [
  'trip_date', 'start_time', 'end_time', 'driver_name',
  'car_identifier', 'price_amount', 'tip_amount',
  'payment_method', 'route_start', 'route_end', 'description',
];

/**
 * The four a stored mapping must name. The same list as `REQUIRED_COLS` in the
 * wizard; the database refuses a row that omits one of them (`?&`), so a
 * mapping that could never carry an import cannot be stored.
 */
export const REQUIRED_MAPPING_FIELDS: readonly (keyof ColMap)[] = [
  'trip_date', 'start_time', 'end_time', 'driver_name',
];

/** A column name is text from a customer's file. The database bounds it too. */
export const MAX_SOURCE_HEADER_LENGTH = 200;
/** And how many of them one sheet may carry. */
export const MAX_SOURCE_HEADERS = 200;
/** The joined length the table's CHECK bounds, so the browser refuses it first. */
export const MAX_SOURCE_HEADERS_JOINED = 8000;

/** `{ system field: the header of the uploaded file that carries it }`. */
export type FieldMap = Partial<Record<keyof ColMap, string>>;

/** One row of `public.import_column_mappings`, as the browser reads it. */
export interface StoredColumnMapping {
  id: string;
  source_shape_key: string;
  source_headers: string[];
  field_map: FieldMap;
  updated_at: string;
}

const EMPTY_COL_MAP: ColMap = {
  trip_date: '', start_time: '', end_time: '', driver_name: '',
  car_identifier: '', price_amount: '', tip_amount: '',
  payment_method: '', route_start: '', route_end: '', description: '',
};

/** A fresh, fully empty mapping. Callers mutate their own copy. */
export function emptyColMap(): ColMap {
  return { ...EMPTY_COL_MAP };
}

const FIELD_SET = new Set<string>(MAPPING_FIELDS);

function isMappingField(key: string): key is keyof ColMap {
  return FIELD_SET.has(key);
}

/**
 * What the shape key is the hash of.
 *
 * Separate from `sourceShapeKey` so the test can read it without hashing, and
 * so the one place the rule lives is visible. `normalise` cannot produce a
 * newline, so the separator survives and two headers cannot run together into
 * a third spelling.
 */
export function sourceShapeMaterial(headers: readonly string[]): string {
  return headers
    .map(h => normalise(String(h ?? '')))
    // Plain lexicographic, never localeCompare: the values are [a-z0-9] only
    // after normalise, so the order is the same in every browser and locale.
    .sort()
    .join('\n');
}

/** The fingerprint that identifies one export format of one company. */
export function sourceShapeKey(headers: readonly string[]): Promise<string> {
  return sha256HexOfText(sourceShapeMaterial(headers));
}

/** The mapped fields of a `ColMap`, dropping the ones left unmapped. */
export function fieldMapOf(colMap: ColMap): FieldMap {
  const out: FieldMap = {};
  for (const field of MAPPING_FIELDS) {
    const header = colMap[field];
    if (header !== '') out[field] = header;
  }
  return out;
}

/**
 * A `field_map` read back out of the database, kept only where it is usable.
 *
 * The column is `jsonb` and a row can also arrive through a restored backup, so
 * what comes back is data and never a contract: an unknown key, a value that is
 * not a string, a blank one and an over-long one are all dropped rather than
 * carried into the wizard. This is the browser's copy of the guard trigger's
 * per-value rules, and it exists so a row the guard could not have written
 * still cannot put a header into a <select>.
 */
export function parseFieldMap(value: unknown): FieldMap {
  const out: FieldMap = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isMappingField(key)) continue;
    if (typeof raw !== 'string') continue;
    const header = raw.trim();
    if (header === '' || header.length > MAX_SOURCE_HEADER_LENGTH) continue;
    out[key] = raw;
  }
  return out;
}

/** The same for `source_headers`, which is `text[]` and can hold anything. */
export function parseSourceHeaders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((h): h is string => typeof h === 'string');
}

/**
 * Whether this mapping may be stored at all — the browser's copy of the rules
 * the table and its guard enforce, so the wizard never sends a row that would
 * be refused and never reports a refusal to an operator who did nothing wrong.
 */
export function isStorableMapping(headers: readonly string[], fieldMap: FieldMap): boolean {
  if (headers.length < 1 || headers.length > MAX_SOURCE_HEADERS) return false;
  if (headers.join('\n').length > MAX_SOURCE_HEADERS_JOINED) return false;
  if (new Set(headers).size !== headers.length) return false;
  for (const header of headers) {
    if (header.trim() === '' || header.length > MAX_SOURCE_HEADER_LENGTH) return false;
  }
  const present = new Set(headers);
  for (const field of REQUIRED_MAPPING_FIELDS) {
    if (!fieldMap[field]) return false;
  }
  for (const [field, header] of Object.entries(fieldMap)) {
    if (!isMappingField(field)) return false;
    // The derived property: a stored mapping can never name a header the row
    // itself does not list. The guard raises on it; here it is refused before
    // the request leaves.
    if (typeof header !== 'string' || !present.has(header)) return false;
  }
  return true;
}

/** A column of the stored mapping the uploaded file does not have. */
export interface MissingMappedColumn {
  field: keyof ColMap;
  header: string;
}

export interface RememberedMappingOutcome {
  /** What step 1 opens with. */
  colMap: ColMap;
  /** The fields the stored mapping settled. */
  applied: (keyof ColMap)[];
  /** The fields it named a column for that this file has not got. */
  missing: MissingMappedColumn[];
  /** The fields nobody remembered, left to the automatic match. */
  autoMatched: (keyof ColMap)[];
}

/**
 * What the wizard starts step 1 with, given the automatic match and whatever
 * mapping was remembered for this company.
 *
 * Per field, in this order and no other:
 *
 *   1. the remembered header, when the uploaded file actually has it;
 *   2. nothing — and the field is reported in `missing` — when the remembered
 *      header is not among the file's headers. NOT the automatic match: a
 *      stored mapping that silently resolves to a different column is the one
 *      outcome this feature exists to prevent;
 *   3. the automatic match, for a field nothing was remembered for.
 *
 * With `stored` null this is the automatic match unchanged, which is what every
 * import did before 20261023210000.
 */
export function applyRememberedMapping(args: {
  headers: readonly string[];
  autoMatched: ColMap;
  stored: StoredColumnMapping | null;
}): RememberedMappingOutcome {
  const { headers, autoMatched, stored } = args;
  const present = new Set(headers);
  const colMap = { ...autoMatched };
  const applied: (keyof ColMap)[] = [];
  const missing: MissingMappedColumn[] = [];
  const remembered = stored ? parseFieldMap(stored.field_map) : {};

  for (const field of MAPPING_FIELDS) {
    const header = remembered[field];
    if (header === undefined) continue;
    if (present.has(header)) {
      colMap[field] = header;
      applied.push(field);
    } else {
      colMap[field] = '';
      missing.push({ field, header });
    }
  }

  const settled = new Set<string>([...applied, ...missing.map(m => m.field)]);
  const autoMatchedFields = MAPPING_FIELDS.filter(f => !settled.has(f) && colMap[f] !== '');

  return { colMap, applied, missing, autoMatched: autoMatchedFields };
}
