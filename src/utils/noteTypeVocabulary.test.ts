/**
 * The ten note types and the effect each one carries are one list written in
 * several places, and they have to move together.
 *
 * The planner reads `note_planning_behavior` and nothing else, so a `sick` note
 * stored as `neutral` does not exclude the driver. Until 22.10.2026 nothing
 * tied the two columns: the vocabulary lived in `noteRules.ts`, in the Notizen
 * screen, and in `app_private.note_behavior_for`, and each could drift from the
 * others without a test noticing. The database now refuses a disagreeing pair
 * (`driver_notes_note_type_known` and `driver_notes_behavior_follows_type`),
 * and those two CHECKs are literals, not calls to the function, because a CHECK
 * runs as the writing role and that role cannot execute anything in
 * `app_private` (measured, and recorded in the migration's header). Literals
 * are a copy, so this file is what keeps the copy honest.
 *
 * It reads, by name order the way the migration chain resolves, the NEWEST
 * migration that defines each rule: a later release that restates one replaces
 * it, so it is found rather than named here. It does not run any SQL; the
 * migration's self-check and `tests/rls/note-type-constraint.sql` do that. What
 * it pins is the text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTE_TYPE_LABELS } from './driverNoteValidation';
import {
  FREE_BEHAVIOR_NOTE_TYPES,
  NOTE_PLANNING_BEHAVIORS,
  NOTE_TYPES,
  NOTE_TYPE_BEHAVIOR,
  noteBehaviorFor,
  notePairAllowed,
} from './noteRules';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(root + path, 'utf8').split('\r').join('');

const migrations = (): { name: string; sql: string }[] => {
  const dir = root + 'supabase/migrations/';
  return readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(name => ({ name, sql: readFileSync(dir + name, 'utf8').split('\r').join('') }));
};

/** The newest migration whose text matches, with the match. */
const newestDefining = (pattern: RegExp): { name: string; match: RegExpMatchArray } => {
  const hits = migrations()
    .map(({ name, sql }) => ({ name, match: sql.match(pattern) }))
    .filter((hit): hit is { name: string; match: RegExpMatchArray } => hit.match !== null);
  if (hits.length === 0) throw new Error(`no migration defines ${pattern}`);
  return hits[hits.length - 1];
};

/** `WHEN 'x' THEN 'y'` pairs, in order. */
const whenThenStrings = (body: string): [string, string][] =>
  [...body.matchAll(/WHEN\s+'(\w+)'\s+THEN\s+'(\w+)'/g)].map(m => [m[1], m[2]]);

const typesInTypeConstraint = (): string[] => {
  const { match } = newestDefining(
    /ADD CONSTRAINT driver_notes_note_type_known\s+CHECK \(\s*note_type IN \(([^)]*)\)/,
  );
  return [...match[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
};

/** The pairing CHECK's CASE: a type either leaves the effect free or names it. */
const pairingConstraint = (): { free: string[]; fixed: Record<string, string>; order: string[] } => {
  const { match } = newestDefining(
    /ADD CONSTRAINT driver_notes_behavior_follows_type\s+CHECK \(\s*CASE note_type([\s\S]*?)ELSE true\s+END\s*\)/,
  );
  const free: string[] = [];
  const fixed: Record<string, string> = {};
  const order: string[] = [];
  for (const m of match[1].matchAll(
    /WHEN\s+'(\w+)'\s+THEN\s+(?:true|note_planning_behavior\s*=\s*'(\w+)')/g,
  )) {
    order.push(m[1]);
    if (m[2] === undefined) free.push(m[1]);
    else fixed[m[1]] = m[2];
  }
  return { free, fixed, order };
};

const noteBehaviorForInSql = (): Record<string, string> => {
  const { match } = newestDefining(
    /CREATE OR REPLACE FUNCTION app_private\.note_behavior_for\([\s\S]*?\$\$;/,
  );
  return Object.fromEntries(whenThenStrings(match[0]));
};

describe('the type CHECK names the ten types', () => {
  it('driver_notes_note_type_known lists exactly NOTE_TYPES, in the same order', () => {
    expect(typesInTypeConstraint()).toEqual([...NOTE_TYPES]);
  });
});

describe('the pairing CHECK is the table in noteRules.ts', () => {
  it('names every type once', () => {
    const { order } = pairingConstraint();
    expect([...order].sort()).toEqual([...NOTE_TYPES].sort());
    expect(new Set(order).size).toBe(order.length);
  });

  it('leaves the effect free for exactly the types noteRules.ts says are the operator\'s', () => {
    expect([...pairingConstraint().free].sort()).toEqual([...FREE_BEHAVIOR_NOTE_TYPES].sort());
  });

  it('fixes every other type to the effect noteRules.ts gives it', () => {
    const expected = Object.fromEntries(
      NOTE_TYPES.filter(type => !FREE_BEHAVIOR_NOTE_TYPES.includes(type)).map(type => [type, NOTE_TYPE_BEHAVIOR[type]]),
    );
    expect(pairingConstraint().fixed).toEqual(expected);
  });

  it('there are eight fixed types and two free ones', () => {
    expect(Object.keys(pairingConstraint().fixed)).toHaveLength(8);
    expect(pairingConstraint().free).toHaveLength(2);
  });
});

describe('app_private.note_behavior_for derives the same table', () => {
  it('maps every type to the effect noteRules.ts starts it with', () => {
    expect(noteBehaviorForInSql()).toEqual({ ...NOTE_TYPE_BEHAVIOR });
  });

  it('so the partner path, which derives from it, writes only pairs the CHECK admits', () => {
    for (const [type, effect] of Object.entries(noteBehaviorForInSql())) {
      expect(notePairAllowed(type, effect)).toBe(true);
    }
  });
});

describe('the kit file\'s literal is the same table', () => {
  it('_nt_fixed_effect fixes exactly the eight, to the effects noteRules.ts gives them', () => {
    const body = read('tests/rls/note-type-constraint.sql').match(
      /FUNCTION _nt_fixed_effect\(p_type text\)[\s\S]*?\$\$;/,
    );
    expect(body).not.toBeNull();
    const fixed = Object.fromEntries(whenThenStrings(body![0]));
    const expected = Object.fromEntries(
      NOTE_TYPES.filter(type => !FREE_BEHAVIOR_NOTE_TYPES.includes(type)).map(type => [type, NOTE_TYPE_BEHAVIOR[type]]),
    );
    expect(fixed).toEqual(expected);
  });
});

describe('the other places the ten types are written', () => {
  it('driverNoteValidation labels exactly the ten', () => {
    expect(Object.keys(NOTE_TYPE_LABELS).sort()).toEqual([...NOTE_TYPES].sort());
  });

  it('the three effects are the ones the existing CHECK allows', () => {
    const { name } = newestDefining(/note_planning_behavior IN \('neutral', 'exclude_from_plan', 'must_include_in_plan'\)/);
    expect(name).toBeTruthy();
    expect([...NOTE_PLANNING_BEHAVIORS]).toEqual(['neutral', 'exclude_from_plan', 'must_include_in_plan']);
  });
});

describe('the demo company\'s seed writes only notes the database admits', () => {
  const seed = read('scripts/seed-demo-company.sql');
  const block = seed.slice(
    seed.indexOf('INSERT INTO driver_notes ('),
    seed.indexOf('JOIN drivers d ON d.name = n.driver'),
  );
  const rows = [...block.matchAll(/\('([^']+)',\s+'([^']+)',\s+'(\w+)',\s+'(\w+)',\s+DATE/g)]
    .map(m => ({ text: m[2], type: m[3], effect: m[4] }));

  it('finds its three notes', () => {
    expect(rows).toHaveLength(3);
  });

  it('each type and effect is a pairing the CHECKs admit', () => {
    for (const row of rows) {
      expect(notePairAllowed(row.type, row.effect), `${row.type} + ${row.effect} ("${row.text}")`).toBe(true);
    }
  });

  it('still shows the screen and the planner all three effects, which is what the block says it is for', () => {
    expect(new Set(rows.map(row => row.effect))).toEqual(new Set(NOTE_PLANNING_BEHAVIORS));
  });

  it('and the neutral one is a note the planner is meant to ignore, not a vacation that is not excluded', () => {
    // The seed used to file "Urlaub beantragt, noch offen" as vacation + neutral.
    // `vacation` excludes; a request nobody has approved yet is a general note.
    const neutral = rows.find(row => row.effect === 'neutral');
    expect(neutral).toBeDefined();
    expect(noteBehaviorFor(neutral!.type)).toBe('neutral');
  });
});
