/**
 * What a note does to a generated Stundennachweis plan: remove its days, keep a
 * window, or nothing. The rule is asymmetric on purpose and is the one
 * `monthlyPlan/availability.ts` states for the Monatsplanung; these tests pin it
 * from the outside, with the dates written out by hand.
 *
 * Vitest pins TZ=Europe/Berlin, which is what makes the two DST days below
 * 23 and 25 hours long.
 */
import { describe, expect, it } from 'vitest';
import {
  absenceCoverage,
  absenceDays,
  findNoteConflicts,
  planEffectOfNote,
  planNoteDays,
} from './stundennachweisNoteDays';
import { absenceRange, mandatoryAt, noteAt, remarkAt } from '../test-utils/stundennachweisPlanScenarios';

const sorted = (days: ReadonlySet<number>) => [...days].sort((a, b) => a - b);

describe('planEffectOfNote: the stored behaviour decides', () => {
  it('an exclusion removes days, a mandatory note keeps a window, a remark does nothing', () => {
    expect(planEffectOfNote({ note_text: 'x', note_planning_behavior: 'exclude_from_plan' })).toBe('exclude');
    expect(planEffectOfNote({ note_text: 'x', note_planning_behavior: 'must_include_in_plan' })).toBe('window');
    expect(planEffectOfNote({ note_text: 'x', note_planning_behavior: 'neutral' })).toBe('none');
  });

  it('a value this build does not know is never read as an instruction', () => {
    expect(planEffectOfNote({ note_text: 'krank', note_planning_behavior: 'weird' })).toBe('none');
    expect(planEffectOfNote({ note_text: 'krank', note_planning_behavior: '' })).toBe('none');
  });

  it('a note somebody left neutral stays neutral, whatever its text says', () => {
    expect(planEffectOfNote({ note_text: 'Fahrer ist krank', note_planning_behavior: 'neutral' })).toBe('none');
  });

  it('only a note with no stored behaviour is read from its text', () => {
    expect(planEffectOfNote({ note_text: 'Fahrer krank', note_planning_behavior: null })).toBe('exclude');
    expect(planEffectOfNote({ note_text: 'Blitzer am Flughafen' })).toBe('window');
    expect(planEffectOfNote({ note_text: 'Reifen gewechselt', note_planning_behavior: null })).toBe('none');
  });
});

describe('absenceDays: the days an exclusion covers', () => {
  it('covers every day of a range, ends included', () => {
    const days = absenceDays([absenceRange('a', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 })], 2026, 3);
    expect(sorted(days)).toEqual([10, 11, 12]);
  });

  it('a one-day note covers that day', () => {
    const days = absenceDays([absenceRange('a', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 })], 2026, 3);
    expect(sorted(days)).toEqual([11]);
  });

  it('a range that begins in the previous month still empties the first days of this one', () => {
    const note = absenceRange('a', { y: 2026, m: 2, d: 27 }, { y: 2026, m: 3, d: 3 });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([1, 2, 3]);
    expect(sorted(absenceDays([note], 2026, 2))).toEqual([27, 28]);
  });

  it('a range that ends in the next month empties the last days of this one', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 30 }, { y: 2026, m: 4, d: 2 });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([30, 31]);
  });

  it('a range wholly in another month covers nothing', () => {
    const note = absenceRange('a', { y: 2026, m: 4, d: 10 }, { y: 2026, m: 4, d: 12 });
    expect(absenceDays([note], 2026, 3).size).toBe(0);
  });

  it('unions several notes', () => {
    const notes = [
      absenceRange('a', { y: 2026, m: 3, d: 2 }, { y: 2026, m: 3, d: 3 }),
      absenceRange('b', { y: 2026, m: 3, d: 3 }, { y: 2026, m: 3, d: 5 }),
    ];
    expect(sorted(absenceDays(notes, 2026, 3))).toEqual([2, 3, 4, 5]);
  });

  // Berlin springs forward on 29.03.2026 (a 23-hour day) and falls back on
  // 25.10.2026 (a 25-hour day). A day loop that adds 86 400 000 ms drifts by an
  // hour across either and lands on the wrong day; the day boundaries here are
  // calendar parts, so each range covers exactly the days it names.
  it('is exact across the 23-hour day', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 28 }, { y: 2026, m: 3, d: 30 });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([28, 29, 30]);
  });

  it('is exact across the 25-hour day', () => {
    const note = absenceRange('a', { y: 2026, m: 10, d: 24 }, { y: 2026, m: 10, d: 26 });
    expect(sorted(absenceDays([note], 2026, 10))).toEqual([24, 25, 26]);
  });

  it('does not spill onto the day after the 25-hour day', () => {
    const note = absenceRange('a', { y: 2026, m: 10, d: 24 }, { y: 2026, m: 10, d: 25 });
    expect(sorted(absenceDays([note], 2026, 10))).toEqual([24, 25]);
  });

  it('does not stop an hour early on the 25-hour day', () => {
    const note = absenceRange('a', { y: 2026, m: 10, d: 25 }, { y: 2026, m: 10, d: 25 });
    expect(sorted(absenceDays([note], 2026, 10))).toEqual([25]);
  });

  // DECISION, pinned: the plan allocates whole days, so a note that covers part
  // of a day blocks the day. It can only claim fewer hours than were possible.
  it('a timed note blocks its whole day', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 }, {
      note_text: 'Termin', start_time: '08:00', end_time: '12:00',
    });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([11]);
  });

  it('a timed note that crosses midnight blocks both days', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 }, {
      note_text: 'Nachtschicht frei', start_time: '22:00', end_time: '06:00',
    });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([11, 12]);
  });

  it('a note with a time on one side only is a whole-day note', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 }, { start_time: '08:00' });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([11]);
  });

  it('a note with no readable date covers nothing', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 11 }, {
      start_date: null, end_date: null, note_date: '',
    });
    expect(absenceDays([note], 2026, 3).size).toBe(0);
  });

  it('a range that ends before it begins covers nothing', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 12 }, { y: 2026, m: 3, d: 10 });
    expect(absenceDays([note], 2026, 3).size).toBe(0);
  });

  it('mandatory notes, remarks and unknown values cover nothing', () => {
    const notes = [
      mandatoryAt('m', { y: 2026, m: 3, d: 11, hh: 14, mm: 0 }),
      remarkAt('r', { y: 2026, m: 3, d: 12 }),
      absenceRange('w', { y: 2026, m: 3, d: 13 }, { y: 2026, m: 3, d: 13 }, { note_planning_behavior: 'weird' }),
    ];
    expect(absenceDays(notes, 2026, 3).size).toBe(0);
  });

  it('reads a note with no stored behaviour from its text', () => {
    const note = absenceRange('a', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 11 }, {
      note_planning_behavior: null, note_text: 'Fahrer krank gemeldet',
    });
    expect(sorted(absenceDays([note], 2026, 3))).toEqual([10, 11]);
  });

  it('keeps the note beside the days it covers', () => {
    const a = absenceRange('a', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 11 });
    const b = absenceRange('b', { y: 2026, m: 4, d: 1 }, { y: 2026, m: 4, d: 2 });
    const coverage = absenceCoverage([a, b], 2026, 3);
    expect(coverage.map(c => c.note.id)).toEqual(['a']);
    expect(sorted(coverage[0].days)).toEqual([10, 11]);
  });
});

describe('planNoteDays: where windows go and which days stay empty', () => {
  it('groups mandatory notes by day in the order given, and nothing else', () => {
    const first = mandatoryAt('m1', { y: 2026, m: 3, d: 18, hh: 20, mm: 5 });
    const second = mandatoryAt('m2', { y: 2026, m: 3, d: 18, hh: 21, mm: 30 });
    const other = mandatoryAt('m3', { y: 2026, m: 3, d: 12, hh: 14, mm: 20 });
    const plan = planNoteDays(
      [first, remarkAt('r', { y: 2026, m: 3, d: 18, hh: 9 }), second, other], 2026, 3,
    );
    expect(plan.windowNotesByDay[18]).toEqual([first, second]);
    expect(plan.windowNotesByDay[12]).toEqual([other]);
    expect(Object.keys(plan.windowNotesByDay).sort()).toEqual(['12', '18']);
    expect(plan.absence.size).toBe(0);
  });

  it('a mandatory note in another month has no window here', () => {
    const plan = planNoteDays([mandatoryAt('m', { y: 2026, m: 4, d: 2, hh: 10, mm: 0 })], 2026, 3);
    expect(plan.windowNotesByDay).toEqual({});
  });

  it('a mandatory note on an absence day gets no window, and the day stays empty', () => {
    const sick = absenceRange('s', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 });
    const blitzer = mandatoryAt('m', { y: 2026, m: 3, d: 11, hh: 14, mm: 20 });
    const plan = planNoteDays([sick, blitzer], 2026, 3);
    expect(plan.windowNotesByDay).toEqual({});
    expect(sorted(plan.absence)).toEqual([10, 11, 12]);
  });

  it('a remark puts nothing into the plan and empties no day', () => {
    const plan = planNoteDays([remarkAt('r', { y: 2026, m: 3, d: 11, hh: 14, mm: 20 })], 2026, 3);
    expect(plan.windowNotesByDay).toEqual({});
    expect(plan.absence.size).toBe(0);
  });

  it('is what the old pre-fill built, for mandatory notes alone', () => {
    // The loop the generators used to carry, verbatim, over every note given.
    const oldNotesByDay = (notes: ReturnType<typeof mandatoryAt>[], year: number, month: number) => {
      const out: Record<number, typeof notes> = {};
      for (const n of notes) {
        const nd = new Date(n.note_date);
        if (nd.getFullYear() === year && nd.getMonth() === month - 1) {
          const day = nd.getDate();
          if (!out[day]) out[day] = [];
          out[day].push(n);
        }
      }
      return out;
    };
    const notes = [
      mandatoryAt('a', { y: 2026, m: 3, d: 9, hh: 23, mm: 10 }),
      mandatoryAt('b', { y: 2026, m: 3, d: 12, hh: 14, mm: 20 }),
      mandatoryAt('c', { y: 2026, m: 3, d: 12, hh: 18, mm: 0 }),
      mandatoryAt('d', { y: 2026, m: 4, d: 1, hh: 8, mm: 0 }),
      mandatoryAt('e', { y: 2026, m: 3, d: 24, hh: 0, mm: 20 }),
    ];
    expect(planNoteDays(notes, 2026, 3).windowNotesByDay).toEqual(oldNotesByDay(notes, 2026, 3));
  });
});

describe('findNoteConflicts: a contradiction is named, not resolved quietly', () => {
  const sick = absenceRange('sick', { y: 2026, m: 3, d: 10 }, { y: 2026, m: 3, d: 12 });

  it('names a mandatory note that falls inside an absence', () => {
    const blitzer = mandatoryAt('m', { y: 2026, m: 3, d: 11, hh: 14, mm: 20 });
    const conflicts = findNoteConflicts([sick, blitzer], 2026, 3);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].day).toBe(11);
    expect(conflicts[0].mandatory.id).toBe('m');
    expect(conflicts[0].absences.map(n => n.id)).toEqual(['sick']);
  });

  it('is silent when the mandatory note is outside the absence', () => {
    expect(findNoteConflicts([sick, mandatoryAt('m', { y: 2026, m: 3, d: 13, hh: 9, mm: 0 })], 2026, 3)).toEqual([]);
  });

  it('is silent for a remark on an absence day: a remark asks for nothing', () => {
    expect(findNoteConflicts([sick, remarkAt('r', { y: 2026, m: 3, d: 11 })], 2026, 3)).toEqual([]);
  });

  it('lists every absence that covers the day', () => {
    const other = absenceRange('urlaub', { y: 2026, m: 3, d: 11 }, { y: 2026, m: 3, d: 14 }, { note_text: 'Urlaub' });
    const conflicts = findNoteConflicts([sick, other, mandatoryAt('m', { y: 2026, m: 3, d: 11, hh: 8, mm: 0 })], 2026, 3);
    expect(conflicts[0].absences.map(n => n.id)).toEqual(['sick', 'urlaub']);
  });

  it('ignores a note with no date at all', () => {
    const odd = noteAt('odd', { y: 2026, m: 3, d: 11 }, { note_planning_behavior: 'must_include_in_plan', note_date: 'nonsense' });
    expect(findNoteConflicts([sick, odd], 2026, 3)).toEqual([]);
  });
});
