/**
 * `FLAG_DEFINITIONS` and the `useFlag(...)` calls in the product are one list
 * written twice, and they have to move together — `rolePageKeys.test.ts`'s rule
 * for `PAGE_DEFINITIONS` / `role_page_keys()`, applied to the flags.
 *
 * Both directions are a defect, and neither says anything at runtime:
 *
 *  - **A flag read but not listed** is a switch that does not exist. The
 *    settings tab cannot draw it, so the only way to turn that feature on is to
 *    write the row by hand in SQL — which is the state this registry replaced.
 *  - **A flag listed but read by nothing** is worse, because it is visible: the
 *    operator is shown a switch with a description of what it does, flips it,
 *    and nothing happens anywhere.
 *
 * The scan reads the source rather than importing it, because a call site is a
 * fact about the code and not a value any module exports. Its own non-vacuity is
 * asserted first: a scan that silently found nothing would pass both rules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_FLAG_KEYS } from './featureFlags';

const SRC = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

/**
 * Comments out, or the worked example in `AppConfigContext`'s doc block
 * (`useFlag('new_export')`) reads as a call site and fails the first rule for a
 * flag nothing reads.
 *
 * Block comments go whole; for line comments only a line that *starts* with
 * `//` or `*` is dropped, never the tail after a `//` elsewhere, because a `//`
 * inside a string literal would otherwise take the rest of a real line with it.
 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

const CALL = /\buseFlag\s*\(\s*(?:'([a-z][a-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))\s*\)/g;
/** `export const TRAVEL_ESTIMATOR_FLAG = 'travel_estimator';` */
const constantValue = (name: string, sources: readonly string[]): string | null => {
  for (const source of sources) {
    const match = source.match(new RegExp(`\\b${name}\\s*(?::[^=]+)?=\\s*'([a-z][a-z0-9_]*)'`));
    if (match) return match[1];
  }
  return null;
};

interface CallSite {
  file: string;
  /** The flag's name, or null when the argument could not be resolved to one. */
  flag: string | null;
  /** What was written in the call, for the message when it cannot be resolved. */
  argument: string;
}

const callSites = (): CallSite[] => {
  const files = sourceFiles(SRC);
  const sources = files.map(file => withoutComments(readFileSync(file, 'utf8')));
  const found: CallSite[] = [];

  sources.forEach((source, index) => {
    for (const match of source.matchAll(CALL)) {
      const [, literal, identifier] = match;
      found.push({
        file: files[index].slice(SRC.length),
        flag: literal ?? constantValue(identifier, sources),
        argument: literal ? `'${literal}'` : identifier,
      });
    }
  });

  return found;
};

describe('the flags the product reads are the flags the settings tab lists', () => {
  const sites = callSites();

  it('the scan finds call sites at all, so the rules below are not vacuous', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it('every call site resolves to a flag name', () => {
    // An argument that is neither a literal nor a constant this scan can follow
    // (a variable, a template string) would be skipped, and skipping it is how
    // the two rules below quietly stop covering it.
    expect(sites.filter(site => site.flag === null).map(site => `${site.file}: useFlag(${site.argument})`))
      .toEqual([]);
  });

  it('no flag is read without being listed in FLAG_DEFINITIONS', () => {
    const unlisted = sites
      .filter(site => site.flag !== null && !KNOWN_FLAG_KEYS.includes(site.flag))
      .map(site => `${site.file}: ${site.flag}`);
    expect(unlisted).toEqual([]);
  });

  it('no flag is listed without being read, so no switch in the tab does nothing', () => {
    const read = new Set(sites.map(site => site.flag));
    expect(KNOWN_FLAG_KEYS.filter(key => !read.has(key))).toEqual([]);
  });

  it('today that is exactly one flag, travel_estimator', () => {
    // Measured, and the number the owner was shown. A second real flag makes
    // this line move in the same commit that adds it.
    expect([...new Set(sites.map(site => site.flag))]).toEqual(['travel_estimator']);
  });
});
