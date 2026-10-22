import { describe, expect, it } from 'vitest';
import {
  FREE_BEHAVIOR_NOTE_TYPES,
  INCIDENT_NOTE_TYPES,
  NOTE_PLANNING_BEHAVIORS,
  NOTE_TYPES,
  NOTE_TYPE_BEHAVIOR,
  isNoteType,
  noteBehaviorFor,
  noteBehaviorIsFree,
  notePairAllowed,
  noteVehicleMissing,
  noteVehicleRequired,
} from './noteRules';

describe('note types', () => {
  it('are the driver apps ten, in any order', () => {
    expect([...NOTE_TYPES].sort()).toEqual(
      ['accident', 'blitzer', 'breakdown', 'general', 'kontrolle', 'off', 'other', 'sick', 'vacation', 'wait'],
    );
  });

  it('name exactly five incident types, all of them real types', () => {
    expect([...INCIDENT_NOTE_TYPES].sort()).toEqual(['accident', 'blitzer', 'breakdown', 'kontrolle', 'wait']);
    for (const type of INCIDENT_NOTE_TYPES) expect(NOTE_TYPES).toContain(type);
  });
});

describe('noteVehicleRequired', () => {
  it.each(['blitzer', 'accident', 'kontrolle', 'breakdown', 'wait'])('%s needs a vehicle', (type) => {
    expect(noteVehicleRequired(type)).toBe(true);
  });
  it.each(['general', 'sick', 'vacation', 'off', 'other'])('%s does not', (type) => {
    expect(noteVehicleRequired(type)).toBe(false);
  });
  it('does not wave an unknown type through as an incident', () => {
    expect(noteVehicleRequired('nonsense')).toBe(false);
  });
});

describe('noteVehicleMissing', () => {
  it('is true for an incident with no car, blank included', () => {
    expect(noteVehicleMissing('accident', '')).toBe(true);
    expect(noteVehicleMissing('accident', '  ')).toBe(true);
  });
  it('is false once a car is named, or for a type that needs none', () => {
    expect(noteVehicleMissing('accident', 'car-1')).toBe(false);
    expect(noteVehicleMissing('sick', '')).toBe(false);
  });
  it('lets an old note without a car be edited, but never a new one', () => {
    expect(noteVehicleMissing('wait', '', true)).toBe(false);
    expect(noteVehicleMissing('wait', '', false)).toBe(true);
  });
});

describe('the Notizen screen', () => {
  it('offers exactly these types', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/NotesPage.tsx', 'utf8');
    const list = source.slice(source.indexOf('const NOTE_TYPES = ['), source.indexOf('const PLANNING_BEHAVIOR_LABELS'));
    const offered = [...list.matchAll(/value: '(\w+)'/g)].map((m) => m[1]);
    expect([...offered].sort()).toEqual([...NOTE_TYPES].sort());
  });

  it('holds no effect table of its own: noteRules.ts is the one', async () => {
    // The list used to carry a `behavior` per type, a second copy of the
    // pairing that nothing kept equal to the first.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/NotesPage.tsx', 'utf8');
    const list = source.slice(source.indexOf('const NOTE_TYPES = ['), source.indexOf('const PLANNING_BEHAVIOR_LABELS'));
    expect(list).not.toMatch(/behavior\s*:/);
    expect(source).toMatch(/noteBehaviorFor\(value\)/);
  });
});

describe('the effect a type carries', () => {
  it.each([
    ['general', 'neutral'], ['other', 'neutral'],
    ['sick', 'exclude_from_plan'], ['vacation', 'exclude_from_plan'], ['off', 'exclude_from_plan'],
    ['blitzer', 'must_include_in_plan'], ['accident', 'must_include_in_plan'],
    ['kontrolle', 'must_include_in_plan'], ['breakdown', 'must_include_in_plan'],
    ['wait', 'must_include_in_plan'],
  ])('%s starts as %s', (type, effect) => {
    expect(noteBehaviorFor(type)).toBe(effect);
  });

  it('is undefined for a type that is not one of the ten, and for a near miss', () => {
    for (const stranger of ['krank', '', 'SICK', ' sick', 'sick ', 'nonsense']) {
      expect(noteBehaviorFor(stranger)).toBeNull();
      expect(isNoteType(stranger)).toBe(false);
    }
  });

  it('is named for every type, with one of the three effects', () => {
    expect(Object.keys(NOTE_TYPE_BEHAVIOR).sort()).toEqual([...NOTE_TYPES].sort());
    for (const effect of Object.values(NOTE_TYPE_BEHAVIOR)) expect(NOTE_PLANNING_BEHAVIORS).toContain(effect);
  });

  it('is must_include_in_plan for exactly the incident types, which are the ones that need a vehicle', () => {
    const requiring = NOTE_TYPES.filter((type) => NOTE_TYPE_BEHAVIOR[type] === 'must_include_in_plan');
    expect([...requiring].sort()).toEqual([...INCIDENT_NOTE_TYPES].sort());
  });
});

describe('which types leave the effect to the operator', () => {
  it('are general and other, and no others', () => {
    expect([...FREE_BEHAVIOR_NOTE_TYPES].sort()).toEqual(['general', 'other']);
    for (const type of NOTE_TYPES) {
      expect(noteBehaviorIsFree(type)).toBe(type === 'general' || type === 'other');
    }
  });

  it('is false for a stranger, so an unknown type is never treated as the operator\'s', () => {
    expect(noteBehaviorIsFree('krank')).toBe(false);
  });
});

describe('notePairAllowed: the browser\'s copy of the two CHECKs', () => {
  it('admits a type with its own effect, for all ten', () => {
    for (const type of NOTE_TYPES) expect(notePairAllowed(type, NOTE_TYPE_BEHAVIOR[type])).toBe(true);
  });

  it('admits any of the three effects on general and other', () => {
    for (const type of FREE_BEHAVIOR_NOTE_TYPES) {
      for (const effect of NOTE_PLANNING_BEHAVIORS) expect(notePairAllowed(type, effect)).toBe(true);
    }
  });

  it('refuses a different effect on each of the other eight: sick + neutral is the hole', () => {
    const fixed = NOTE_TYPES.filter((type) => !noteBehaviorIsFree(type));
    expect(fixed).toHaveLength(8);
    for (const type of fixed) {
      for (const effect of NOTE_PLANNING_BEHAVIORS) {
        expect(notePairAllowed(type, effect)).toBe(effect === NOTE_TYPE_BEHAVIOR[type]);
      }
    }
    expect(notePairAllowed('sick', 'neutral')).toBe(false);
    expect(notePairAllowed('vacation', 'neutral')).toBe(false);
  });

  it('refuses an effect outside the three, on a free type too, and a type outside the ten', () => {
    expect(notePairAllowed('general', 'always')).toBe(false);
    expect(notePairAllowed('krank', 'neutral')).toBe(false);
    expect(notePairAllowed('SICK', 'exclude_from_plan')).toBe(false);
    expect(notePairAllowed('', 'neutral')).toBe(false);
  });
});
