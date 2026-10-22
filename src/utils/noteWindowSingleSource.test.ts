/**
 * One copy of the note window, and the source says so.
 *
 * Four copies of this arithmetic have existed. Two were corrected after the
 * incident `driverNoteValidation.ts` records; the third is the one that
 * survives and that every caller must use; the fourth lived in the transfer
 * check of `MonatsplanungStundennachweisPreview` and advanced a fixed
 * 86_400_000 ms per day, which the DST test beside this one measures.
 *
 * A type cannot express "do not write this again", so it is checked as text: no
 * module that decides a note's window may carry its own day loop. The scan is
 * deliberately narrow — a day-length constant next to a note window — so it
 * fails on a new copy rather than on every piece of date arithmetic in the
 * codebase.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Every module that decides whether a note blocks something. */
const NOTE_WINDOW_CALLERS = [
  'components/MonatsplanungStundennachweisPreview.tsx',
  'utils/monatsplanungPhase3.ts',
  'utils/monthlyPlan/availability.ts',
];

describe('the note window has one implementation', () => {
  it('lives in driverNoteValidation and builds each boundary from its own day', () => {
    const src = read('utils/driverNoteValidation.ts');
    expect(src).toContain('export function noteExclusionIntervals');
    // The rule the docblock states: calendar parts per day, never a fixed step.
    expect(src).toMatch(/new Date\(from\.y, from\.m, from\.d \+ i\)/);
  });

  it.each(NOTE_WINDOW_CALLERS)('%s asks for it instead of stepping a day itself', rel => {
    const src = read(rel);
    expect(src).toContain('noteExclusionIntervals');
  });

  it('no note-window function steps a fixed day length', () => {
    // Scoped to the functions that judge a note, NOT the whole file. The first
    // version of this test scanned whole modules and failed on
    // `MonatsplanungStundennachweisPreview.tsx:1542`, `if (tEMs <= tSMs) tEMs +=
    // 86400000`, which extends a ride that crosses midnight. That line has the
    // same DST flaw, by the same reasoning, but it is ride duration and not a
    // note window: changing it moves payroll minutes and belongs in its own
    // change with its own golden-master read. It is recorded in HANDOFF.md.
    const suspects = [
      ['components/MonatsplanungStundennachweisPreview.tsx', 'isNoteBlockingTransfer'],
      ['utils/monatsplanungPhase3.ts', 'checkStructuredNote'],
      ['utils/monthlyPlan/availability.ts', 'noteWindows'],
    ] as const;
    for (const [rel, fn] of suspects) {
      const src = read(rel);
      const at = src.indexOf(fn);
      if (at === -1) continue;          // renamed; the scan below still guards the module
      const body = src.slice(at, at + 2000);
      expect(body, `${rel} / ${fn}`).not.toMatch(/86[_]?400[_]?000/);
    }
  });

  it('names no second helper that returns note intervals', () => {
    // A copy renamed rather than deleted would pass the scan above.
    for (const rel of NOTE_WINDOW_CALLERS) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/function\s+\w*[Nn]ote\w*(Intervals|Windows)\s*\(/);
    }
  });
});
