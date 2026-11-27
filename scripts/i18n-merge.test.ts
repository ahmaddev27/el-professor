import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The merge script against a scratch tree, never the real dictionaries. */
const SCRIPT = path.resolve(__dirname, 'i18n-merge.mjs');
let root = '';
let input = '';

const AR_HEADER = "import type { PartialDictionary } from './index';\n/** header */\nexport const ar: PartialDictionary = {};\n";
const DE = "export const de = {\n  'a.one': 'Eins {n}',\n  'a.two': 'Zwei',\n  'a.three': 'Drei',\n} as const;\n";
const EN = "export const en = {\n  'a.one': 'One {n}',\n};\n";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'i18n-merge-'));
  input = path.join(root, 'in');
  mkdirSync(path.join(root, 'src/i18n'), { recursive: true });
  mkdirSync(input);
  writeFileSync(path.join(root, 'src/i18n/de.ts'), DE);
  writeFileSync(path.join(root, 'src/i18n/en.ts'), EN);
  writeFileSync(path.join(root, 'src/i18n/ar.ts'), AR_HEADER);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (...args: string[]) => {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, I18N_MERGE_ROOT: root }, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, out: err.stdout, err: err.stderr };
  }
};
const put = (name: string, value: unknown) => writeFileSync(path.join(input, name), JSON.stringify(value));
const ar = () => readFileSync(path.join(root, 'src/i18n/ar.ts'), 'utf8');

describe('--ar-import', () => {
  it('writes a good map in de.ts order', () => {
    put('a.json', { 'a.three': 'ثلاثة', 'a.one': 'واحد {n}' });
    expect(run('--ar-import', input).code).toBe(0);
    const text = ar();
    expect(text.indexOf("'a.one'")).toBeLessThan(text.indexOf("'a.three'"));
    expect(text).toContain("'a.one': 'واحد {n}'");
  });

  it.each([
    ['an unknown key', { 'x.nope': 'س' }, 'unknown key'],
    ['a placeholder mismatch', { 'a.one': 'واحد' }, 'placeholders differ'],
    ['an empty string', { 'a.two': '  ' }, 'empty'],
    ['an Arabic-Indic digit', { 'a.two': 'اثنان ٢' }, 'Arabic-Indic'],
  ])('refuses %s and writes nothing', (_name, map, message) => {
    put('a.json', { 'a.three': 'ثلاثة' });
    put('b.json', map);
    const result = run('--ar-import', input);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(ar()).toBe(AR_HEADER);
  });

  it('lists every refusal, not only the first', () => {
    put('a.json', { 'x.nope': 'س', 'a.two': '' });
    const result = run('--ar-import', input);
    expect(result.err).toContain('2 problem(s)');
  });

  it('dry run writes nothing', () => {
    put('a.json', { 'a.two': 'اثنان' });
    expect(run('--ar-import', input, '--dry').code).toBe(0);
    expect(ar()).toBe(AR_HEADER);
  });
});

describe('the entry format', () => {
  it('an ar-only entry updates only the Arabic', () => {
    put('a.json', { 'a.two': { ar: 'اثنان' } });
    expect(run(input).code).toBe(0);
    expect(ar()).toContain("'a.two': 'اثنان'");
    expect(readFileSync(path.join(root, 'src/i18n/de.ts'), 'utf8')).toBe(DE);
    expect(readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8')).toBe(EN);
  });

  it('an ar-only entry for an unknown key is refused', () => {
    put('a.json', { 'a.nine': { ar: 'تسعة' } });
    expect(run(input).code).toBe(1);
  });

  it('a new key with de, en and ar lands in all three', () => {
    put('a.json', { 'a.new': { de: 'Neu {n}', en: 'New {n}', ar: 'جديد {n}' } });
    expect(run(input).code).toBe(0);
    expect(readFileSync(path.join(root, 'src/i18n/de.ts'), 'utf8')).toContain("'a.new'");
    expect(ar()).toContain("'a.new': 'جديد {n}'");
  });

  it('de/en-only input leaves ar.ts alone', () => {
    put('a.json', { 'a.new': { de: 'Neu', en: 'New' } });
    expect(run(input).code).toBe(0);
    expect(ar()).toBe(AR_HEADER);
  });

  it('refuses an ar value whose placeholders differ from de', () => {
    put('a.json', { 'a.new': { de: 'Neu {n}', en: 'New {n}', ar: 'جديد' } });
    expect(run(input).code).toBe(1);
  });
});
