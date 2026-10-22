/**
 * Nothing a note records about its provenance reaches the planner.
 *
 * `note_planning_behavior` is read by fifteen files and a `must_include_in_plan`
 * note pins a driver to the block containing the event, so a column added to the
 * table must not be able to move a plan or a Stundennachweis by accident. The
 * database half of that is a catalogue fact (no policy reads a provenance
 * column, asserted by the migration's self-check). This is the browser half:
 *
 *  - every read of `driver_notes` that feeds an engine names its columns, and
 *    none of them is a provenance column;
 *  - the only read that takes `*` is the Notizen screen's own, which feeds none;
 *  - the engines never mention a provenance column, and never import the module
 *    that knows about one.
 *
 * What the planner DOES read, so the claim can be checked rather than believed,
 * is the note's window (start_date, end_date, the times, is_full_day), with the
 * date part of `note_date` when `start_date` is empty, the car for a mandatory
 * pin in the monthly plan, and, in the Stundennachweis page alone, `note_date`
 * with its time of day. None of that is new, and `occurred_at` is none of it. If
 * the planner should use `occurred_at` instead, that is a decision about a
 * statutory document and a slice of its own (HANDOFF.md, "Driver note
 * provenance"), and this file is the one to change in the same commit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Columns added by 20261022150000. `latitude` and `longitude` are named apart: trips have them too. */
const PROVENANCE_COLUMNS = [
  'occurred_at', 'reported_at', 'received_at', 'entry_source', 'evidence_path', 'verification_status',
  'reviewed_by', 'reviewed_at', 'rejected_reason', 'location_accuracy_m', 'change_log',
] as const;
const POSITION_COLUMNS = ['latitude', 'longitude'] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const rel = (file: string): string => relative(SRC, file).split('\\').join('/');

/** The chain from `.from('driver_notes')` up to the statement's end, reads only. */
function readChains(text: string): string[] {
  const out: string[] = [];
  const marker = ".from('driver_notes')";
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const end = text.indexOf(';', at);
    const chain = text.slice(at, end === -1 ? text.length : end);
    if (chain.includes('.select(')) out.push(chain);
  }
  return out;
}

/** The column list a chain selects: its first string argument. */
function selected(chain: string): string {
  const match = /\.select\(\s*(['"`])([\s\S]*?)\1/.exec(chain);
  return match ? match[2] : '';
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = sourceFiles(SRC);
const word = (name: string) => new RegExp(`\\b${name}\\b`);

describe('every read of driver_notes names its columns, and none is a provenance column', () => {
  const reads = files.flatMap(file =>
    readChains(readFileSync(file, 'utf8')).map(chain => ({ file: rel(file), columns: selected(chain) })));

  it('finds the reads at all, so a passing run is not a vacuous one', () => {
    expect(reads.length).toBeGreaterThanOrEqual(7);
  });

  it('takes * in exactly one place, the Notizen screen, which feeds no engine', () => {
    const star = reads.filter(read => read.columns.split(',').some(part => part.trim().startsWith('*')));
    expect(star.map(read => read.file)).toEqual(['pages/NotesPage.tsx']);
  });

  it('selects no provenance column anywhere else', () => {
    const offenders: string[] = [];
    for (const read of reads) {
      if (read.file === 'pages/NotesPage.tsx') continue;
      for (const column of [...PROVENANCE_COLUMNS, ...POSITION_COLUMNS]) {
        if (word(column).test(read.columns)) offenders.push(`${read.file}: ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the engines do not know about provenance', () => {
  /** Everything that turns a note into a window, a pin or a sheet row. */
  const engines = files.filter(file => {
    const name = rel(file);
    return /^utils\/(monatsplanung[A-Za-z0-9]*|driverNoteValidation|noteBehavior|shiftBlockEngine|historicalWorkingHoursCleanEngine)\.ts$/.test(name)
      || /^utils\/monthlyPlan\//.test(name);
  });

  it('finds the engines, so a rename is followed rather than skipped', () => {
    const names = engines.map(rel);
    for (const expected of [
      'utils/monatsplanungPhase3.ts', 'utils/driverNoteValidation.ts', 'utils/noteBehavior.ts',
      'utils/monthlyPlan/availability.ts',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('mentions no provenance column', () => {
    const offenders: string[] = [];
    for (const file of engines) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const column of PROVENANCE_COLUMNS) {
        if (word(column).test(text)) offenders.push(`${rel(file)}: ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports neither the provenance module nor its writes', () => {
    const offenders = engines
      .filter(file => /noteProvenance|driverNoteProvenance/.test(stripComments(readFileSync(file, 'utf8'))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('keeps StructuredNote, the planner\'s view of a note, free of every provenance field', () => {
    const phase3 = readFileSync(join(SRC, 'utils/monatsplanungPhase3.ts'), 'utf8');
    const body = /export interface StructuredNote \{([\s\S]*?)\n\}/.exec(phase3);
    expect(body).not.toBeNull();
    for (const column of [...PROVENANCE_COLUMNS, ...POSITION_COLUMNS]) {
      expect(body![1], column).not.toMatch(word(column));
    }
  });
});
