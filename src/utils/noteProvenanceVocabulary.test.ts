/**
 * The rules about a note's provenance are written twice, once in the database
 * where they are enforced and once here where the screen says so before a save,
 * and the copies have to move together.
 *
 * The database half is a set of CHECK constraints that are literals and not
 * calls (a CHECK runs as the writing role, which cannot execute anything in
 * `app_private`; 20261022143000 measured what happens when one tries), and
 * literals are a copy. This file is what keeps the copy honest: it reads, by
 * name order the way the migration chain resolves, the NEWEST migration that
 * defines each rule, so a later release that restates one is found rather than
 * named here. It runs no SQL; the migration's self-check and
 * `tests/rls/driver-note-provenance.sql` do that. What it pins is the text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_SOURCES,
  EVIDENCE_EXTENSIONS,
  MAX_ACCURACY_M,
  REVIEWED_COLUMNS,
  VERIFICATION_STATUSES,
  evidenceKey,
  historyFields,
  isEvidenceKey,
  provenanceErrorKey,
} from './noteProvenance';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Read once: the lookups below each scan every migration, and 119 files a time
// is minutes on a loaded machine.
let cache: { name: string; sql: string }[] | null = null;
const migrations = (): { name: string; sql: string }[] => {
  if (cache) return cache;
  const dir = root + 'supabase/migrations/';
  cache = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(name => ({ name, sql: readFileSync(dir + name, 'utf8').split('\r').join('') }));
  return cache;
};

/** The newest migration whose text matches, with the match. */
const newestDefining = (pattern: RegExp): { name: string; match: RegExpMatchArray } => {
  const hits = migrations()
    .map(({ name, sql }) => ({ name, match: sql.match(pattern) }))
    .filter((hit): hit is { name: string; match: RegExpMatchArray } => hit.match !== null);
  if (hits.length === 0) throw new Error(`no migration defines ${pattern}`);
  return hits[hits.length - 1];
};

const quoted = (list: string): string[] => [...list.matchAll(/'(\w+)'/g)].map(m => m[1]);

const inList = (constraint: string, column: string): string[] =>
  quoted(newestDefining(new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK \\(${column} IN \\(([^)]*)\\)\\)`)).match[1]);

/** One of the guard's three lists of column names. */
const guardList = (name: string): string[] =>
  quoted(newestDefining(new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`)).match[1]);

describe('the vocabularies', () => {
  it('driver_notes_entry_source_known lists exactly ENTRY_SOURCES', () => {
    expect(inList('driver_notes_entry_source_known', 'entry_source')).toEqual([...ENTRY_SOURCES]);
  });

  it('driver_notes_verification_status_known lists exactly VERIFICATION_STATUSES', () => {
    expect(inList('driver_notes_verification_status_known', 'verification_status')).toEqual([...VERIFICATION_STATUSES]);
  });
});

describe('the document key', () => {
  /** The tail of the shape rule's pattern: everything after the note id. */
  const sqlTail = (): string => {
    const { match } = newestDefining(
      /ADD CONSTRAINT driver_notes_evidence_path_shape[\s\S]*?'\/driver-notes\/'\s*\|\|\s*id::text\s*\|\|\s*'([^']*)'\)\)/,
    );
    return match[1];
  };

  const CO = 'c0000000-0000-4000-8000-00000000000a';
  const NOTE = 'a8100000-0000-4000-8000-000000000001';
  const FILE = 'f8100000-0000-4000-8000-000000000001';

  it('allows exactly the extensions EVIDENCE_EXTENSIONS names', () => {
    const alternation = /\\\.\(([^)]*)\)\$$/.exec(sqlTail());
    expect(alternation).not.toBeNull();
    expect(alternation![1].split('|')).toEqual([...EVIDENCE_EXTENSIONS]);
  });

  it('keeps the key under the folder the browser writes', () => {
    expect(evidenceKey(CO, NOTE, FILE, 'pdf').startsWith(`${CO}/driver-notes/${NOTE}/`)).toBe(true);
  });

  // The pattern, run as JavaScript, against the same keys the browser's copy is
  // asked about. A pattern that only these two simple regular expressions
  // understand the same way is exactly the claim.
  it('is the pattern the browser applies: both give one answer on the same keys', () => {
    const sql = new RegExp(`^${CO}/driver-notes/${NOTE}${sqlTail()}`);
    const key = (tail: string) => `${CO}/driver-notes/${NOTE}/${tail}`;
    const samples = [
      ...EVIDENCE_EXTENSIONS.map(ext => evidenceKey(CO, NOTE, FILE, ext)),
      evidenceKey('c0000000-0000-4000-8000-00000000000b', NOTE, FILE, 'pdf'),
      evidenceKey(CO, 'a8100000-0000-4000-8000-000000000002', FILE, 'pdf'),
      key(`../${FILE}.pdf`), key(`a/${FILE}.pdf`), key('Bussgeld.pdf'), key(`${FILE}.svg`), key(`${FILE}.html`),
      key(FILE), key(`${FILE}.PDF`), key(`${FILE.toUpperCase()}.pdf`), key(`${FILE}.pdf `), key(`${FILE}.pdf\n`),
      `/${key(`${FILE}.pdf`)}`, `https://x.invalid/${key(`${FILE}.pdf`)}`, key(`${FILE}.pdf?token=abc`), '',
    ];
    for (const sample of samples) {
      expect(sql.test(sample), JSON.stringify(sample)).toBe(isEvidenceKey(sample, CO, NOTE));
    }
  });
});

describe('the position', () => {
  const body = (): string => newestDefining(/ADD CONSTRAINT driver_notes_location_range[\s\S]*?;/).match[0];

  it('keeps latitude within 90 and longitude within 180', () => {
    expect(body()).toMatch(/latitude\s+BETWEEN -90\s+AND 90/);
    expect(body()).toMatch(/longitude BETWEEN -180\s+AND 180/);
  });

  it('keeps the accuracy within MAX_ACCURACY_M, and only with a position', () => {
    const accuracy = newestDefining(/ADD CONSTRAINT driver_notes_location_accuracy[\s\S]*?;/).match[0];
    expect(accuracy).toContain(`BETWEEN 0 AND ${MAX_ACCURACY_M}`);
    expect(accuracy).toContain('latitude IS NOT NULL');
  });
});

describe('what a review covers', () => {
  it('REVIEWED_COLUMNS is the guard\'s c_reviewed, column for column', () => {
    expect([...REVIEWED_COLUMNS].sort()).toEqual(guardList('c_reviewed').sort());
  });

  it('does not cover the planning effect or note_date, on purpose', () => {
    // note_date is recomputed to the minute by the Notizen screen on every save; counting it would
    // take a verification back on a save that changed nothing. The effect follows the type.
    for (const list of [guardList('c_reviewed'), guardList('c_kept'), guardList('c_text')]) {
      expect(list).not.toContain('note_date');
    }
    expect(guardList('c_reviewed')).not.toContain('note_planning_behavior');
  });

  it('covers only columns the log also tracks, apart from the free text it names', () => {
    const tracked = new Set([...guardList('c_kept'), ...guardList('c_text')]);
    for (const column of guardList('c_reviewed')) expect(tracked.has(column), column).toBe(true);
  });
});

describe('the log', () => {
  it('names every column it tracks in a way the history can say', () => {
    for (const column of [...guardList('c_kept'), ...guardList('c_text')]) {
      expect(historyFields([column]), column).toHaveLength(1);
    }
  });

  it('keeps free text out of what it remembers', () => {
    expect(guardList('c_text')).toEqual(['note_text', 'rejected_reason']);
    expect(guardList('c_kept')).not.toContain('note_text');
    expect(guardList('c_kept')).not.toContain('rejected_reason');
  });
});

describe('the sentences for a refusal', () => {
  it.each([
    'driver_notes_occurred_not_after_reported',
    'driver_notes_location_pair',
    'driver_notes_location_range',
    'driver_notes_location_accuracy',
    'driver_notes_rejection_has_reason',
    'driver_notes_evidence_path_shape',
  ])('%s exists in the migration and has a sentence', name => {
    expect(() => newestDefining(new RegExp(`ADD CONSTRAINT ${name}\\b`))).not.toThrow();
    expect(provenanceErrorKey({ message: `violates check constraint "${name}"` })).not.toBeNull();
  });
});
