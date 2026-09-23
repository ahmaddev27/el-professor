/**
 * Every engine message key exists in BOTH dictionaries.
 *
 * The engines under `src/utils/` name a dictionary key beside their German
 * text (see ./engineMessage.ts). Nothing at compile time ties those plain
 * strings to the dictionaries — `TranslationKey` cannot reach them, because the
 * engines must not import the dictionaries — so this test is the tie.
 *
 * It reads the engines' own source, collects every `'engine.…'` literal, and
 * fails when one is missing from `de` or from `en`. A key an engine builds from
 * a code (`engine.noteType.${type}`) cannot be found that way, so each such
 * family is listed below with its members; adding a member without its two
 * dictionary entries fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';
import { isTranslationKey } from './engineMessage';
import { NOTE_TYPE_LABELS } from '../utils/driverNoteValidation';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Every `'engine.…'` literal anywhere in `src/`, with the file that holds it. */
function literalKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/'(engine\.[A-Za-z0-9_.]+)'/g)) {
      const key = match[1];
      found.set(key, [...(found.get(key) ?? []), path]);
    }
  }
  return found;
}

/**
 * Keys an engine builds from a discriminator. The members are the engine's own
 * vocabulary: the note types it labels, the block statuses and warnings the
 * clean engine switches on, the weekdays the legacy note names, the conflict
 * kinds the repair pass reports, the row-quality and budget problems the
 * analysis lists.
 */
const KEY_FAMILIES: Record<string, readonly string[]> = {
  'engine.noteType.': Object.keys(NOTE_TYPE_LABELS),
  'engine.hwh.blockStatus.': ['valid', 'short', 'long', 'invalid'],
  'engine.hwh.blockWarning.': [
    'missing_vehicle', 'missing_time', 'zero_duration', 'negative_duration',
    'original_vehicle_overlap', 'short_block', 'long_block',
  ],
  'engine.phase3.reject.legacyNote.notWeekday.': ['1', '2', '3', '4', '5', '6', '7'],
  'engine.repair.conflictKind.': ['driver', 'vehicle', 'inhaber', 'regularDriver'],
  'engine.analysis.rowQuality.': [
    'missing_driver', 'missing_vehicle', 'missing_start', 'missing_end',
    'end_before_start', 'status_unknown', 'ambiguous_local_time',
  ],
  'engine.budgetProblem.': [
    'salary_min_missing', 'salary_min_invalid', 'salary_min_negative',
    'salary_max_missing', 'salary_max_invalid', 'salary_max_negative',
    'salary_min_above_max', 'hourly_rate_missing', 'hourly_rate_invalid',
    'hourly_rate_not_positive', 'reserve_not_set', 'reserve_invalid',
    'reserve_negative', 'reserve_above_hours_max',
  ],
};

const familyKeys = Object.entries(KEY_FAMILIES).flatMap(([prefix, members]) =>
  members.map(member => `${prefix}${member}`),
);

const deKeys = Object.keys(de).filter(key => key.startsWith('engine.'));
const enKeys = Object.keys(en).filter(key => key.startsWith('engine.'));

/** The `{placeholder}` names a template uses, sorted. */
function slots(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

describe('engine message keys', () => {
  it('finds keys to check (the scan itself works)', () => {
    expect(literalKeys().size).toBeGreaterThan(50);
  });

  it('every key an engine names is in the German dictionary', () => {
    const missing = [...literalKeys().entries()]
      .filter(([key]) => !isTranslationKey(key))
      .map(([key, files]) => `${key} (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('every key an engine names is in the English dictionary', () => {
    const missing = [...literalKeys().keys()].filter(key => !enKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it('every key built from a discriminator is in both dictionaries', () => {
    expect(familyKeys.filter(key => !deKeys.includes(key))).toEqual([]);
    expect(familyKeys.filter(key => !enKeys.includes(key))).toEqual([]);
  });

  it('the two dictionaries carry the same engine keys', () => {
    expect(enKeys.filter(key => !deKeys.includes(key))).toEqual([]);
    expect(deKeys.filter(key => !enKeys.includes(key))).toEqual([]);
  });

  it('a key and its translation take the same placeholders', () => {
    const mismatched = deKeys
      .filter(key => {
        const german = (de as Record<string, string>)[key];
        const english = (en as Record<string, string>)[key];
        return english !== undefined
          && slots(german).join(',') !== slots(english).join(',');
      });
    expect(mismatched).toEqual([]);
  });

  it('no engine key is defined but named by nothing', () => {
    const named = new Set([...literalKeys().keys(), ...familyKeys]);
    expect(deKeys.filter(key => !named.has(key))).toEqual([]);
  });
});
