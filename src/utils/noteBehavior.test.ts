/**
 * What a driver note does to a plan, and that StundennachweisPage asks one
 * function instead of carrying the answer four times.
 *
 * The page used to hold this expression in four places, character for
 * character:
 *
 *   note_planning_behavior ?? (<absence words>.some(...) ? 'exclude_from_plan'
 *                           : <incident words>.some(...) ? 'must_include_in_plan'
 *                           : null)
 *
 * and printed its answer as `Abwesenheit` / `Pflichtnotiz` into the
 * Stundennachweis PDF that goes to the Steuerberater. Moving it was meant to
 * change nothing, so the expected values below are written out here, not read
 * back from the module: a test that took the keyword lists from
 * `noteBehavior.ts` would pass whatever that file held. (The extraction itself
 * was proved against the four original expressions, taken verbatim from the
 * commit before it, over 184,648 inputs with no difference; this file is what
 * keeps that true afterwards.)
 *
 * The cases marked "characterization" record what the code does, not what it
 * should do. They are the golden-master idiom of this repository: a change to
 * one of them is meant to be a decision made in the open.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ABSENCE_KEYWORDS, MUST_INCLUDE_KEYWORDS, resolveNoteBehavior } from './noteBehavior';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// The lists exactly as the page held them.
const ABSENCE = ['krank', 'urlaub', 'frei', 'nicht verfügbar', 'gesperrt', 'ausfall', 'abwesend'];
const MUST_INCLUDE = ['blitzer', 'unfall', 'panne', 'kontrolle', 'wartezeit'];

const note = (note_text: string, note_planning_behavior?: string | null) => ({ note_text, note_planning_behavior });

describe('the stored behaviour decides, and always wins', () => {
  it.each(['neutral', 'exclude_from_plan', 'must_include_in_plan'])(
    'returns %s as stored, whatever the text says',
    stored => {
      for (const text of ['Fahrer krank', 'Blitzer am Flughafen', 'Reifen gewechselt']) {
        expect(resolveNoteBehavior(note(text, stored))).toBe(stored);
      }
    },
  );

  it('a neutral note about a sick driver stays neutral: somebody left it that way', () => {
    expect(resolveNoteBehavior(note('Fahrer ist krank', 'neutral'))).toBe('neutral');
  });

  it('an empty string is a stored value, not an absent one', () => {
    // `||` would turn this into a guess from the text; `??` does not.
    expect(resolveNoteBehavior(note('krank', ''))).toBe('');
  });

  it('passes a value it does not know through untouched', () => {
    expect(resolveNoteBehavior(note('krank', 'weird'))).toBe('weird');
  });

  it('does not read the text at all when a value is stored', () => {
    const noText = { note_planning_behavior: 'neutral', note_text: undefined as unknown as string };
    expect(resolveNoteBehavior(noText)).toBe('neutral');
  });
});

describe('the guess from the text, when nothing is stored', () => {
  const unset: (string | null | undefined)[] = [null, undefined];

  it.each(ABSENCE)('"%s" reads as an absence', keyword => {
    for (const stored of unset) {
      expect(resolveNoteBehavior(note(`Fahrer ${keyword} gemeldet`, stored))).toBe('exclude_from_plan');
    }
  });

  it.each(MUST_INCLUDE)('"%s" reads as a Pflichtnotiz', keyword => {
    for (const stored of unset) {
      expect(resolveNoteBehavior(note(`Meldung: ${keyword} um 14 Uhr`, stored))).toBe('must_include_in_plan');
    }
  });

  it('ignores case', () => {
    expect(resolveNoteBehavior(note('KRANK', null))).toBe('exclude_from_plan');
    expect(resolveNoteBehavior(note('Nicht Verfügbar ab Montag', null))).toBe('exclude_from_plan');
    expect(resolveNoteBehavior(note('BLITZER', null))).toBe('must_include_in_plan');
  });

  it('tests the absence words first, so a note that matches both reads as an absence', () => {
    expect(resolveNoteBehavior(note('Blitzer, danach krank', null))).toBe('exclude_from_plan');
    expect(resolveNoteBehavior(note('krank, davor Blitzer', null))).toBe('exclude_from_plan');
  });

  it('returns null when no word matches, including for empty text', () => {
    for (const text of ['Reifen gewechselt', '', '   ', 'Kunde wartet']) {
      expect(resolveNoteBehavior(note(text, null))).toBeNull();
    }
  });

  it('characterization: matching is by substring, so "frei" also matches "Freitag"', () => {
    // Not a requirement: the cost of the original expression, kept because the
    // label it feeds is printed on a statutory document. Unreachable for a note
    // loaded from the database, whose column is NOT NULL (see noteBehavior.ts).
    expect(resolveNoteBehavior(note('Freitag Termin beim Zoll', null))).toBe('exclude_from_plan');
    expect(resolveNoteBehavior(note('Krankenhaus angefahren', null))).toBe('exclude_from_plan');
    expect(resolveNoteBehavior(note('Pannenhilfe bestellt', null))).toBe('must_include_in_plan');
  });
});

describe('the keyword lists', () => {
  it('are the two lists the page held, in the same order', () => {
    expect([...ABSENCE_KEYWORDS]).toEqual(ABSENCE);
    expect([...MUST_INCLUDE_KEYWORDS]).toEqual(MUST_INCLUDE);
  });

  it('are lower case, because the text is lower-cased before it is searched', () => {
    // An upper-case keyword could never match: it would be dead without a sound.
    for (const keyword of [...ABSENCE_KEYWORDS, ...MUST_INCLUDE_KEYWORDS]) {
      expect(keyword).toBe(keyword.toLowerCase());
    }
  });

  it('share no word, so the order they are tested in never hides one', () => {
    const shared = ABSENCE_KEYWORDS.filter(keyword => MUST_INCLUDE_KEYWORDS.includes(keyword));
    expect(shared).toEqual([]);
  });
});

describe('StundennachweisPage', () => {
  const page = readFileSync(join(SRC, 'pages', 'StundennachweisPage.tsx'), 'utf8');

  it('holds no copy of either keyword list', () => {
    const copies = [...ABSENCE, ...MUST_INCLUDE].filter(keyword => page.includes(`'${keyword}'`));
    expect(copies).toEqual([]);
  });

  it('asks the resolver, where it used to carry the expression', () => {
    expect(page).toContain("import { resolveNoteBehavior } from '../utils/noteBehavior';");
    // Its label, its PDF notes and its notes carousel.
    const calls = page.split('resolveNoteBehavior(').length - 1;
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('selects the behaviour column in both of its driver_notes reads', () => {
    // The guess is only a fallback because the column is always there. A read
    // that dropped it would turn the fallback on, silently relabelling a
    // document, and the planner (which compares the stored value only) would
    // no longer agree with it.
    const lists = [...page.matchAll(/'(id, driver_id, note_date[^']*)'/g)].map(match => match[1]);
    expect(lists.length).toBe(2);
    for (const list of lists) expect(list).toContain('note_planning_behavior');
  });
});

describe('the keyword lists exist in exactly one place', () => {
  // 'blitzer' and 'kontrolle' are also structured note type codes (NotesPage,
  // noteRules), which is a different thing; the other ten are not.
  const distinctive = [...ABSENCE, 'unfall', 'panne', 'wartezeit'];

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap(entry => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });

  it('is noteBehavior.ts and no other file', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const holders = files
      .filter(file => {
        const text = readFileSync(file, 'utf8');
        return distinctive.some(keyword => text.includes(`'${keyword}'`));
      })
      .map(file => relative(SRC, file).split('\\').join('/'));
    expect(holders).toEqual(['utils/noteBehavior.ts']);
  });
});
