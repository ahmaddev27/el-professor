/**
 * Every door to the simulated-ride generator sits behind `simulatedRidesEntryShown`.
 *
 * `navVisibility.test.ts` pins what the rule *answers*. This pins that the
 * product *applies* it, which is the half a predicate test cannot reach: the
 * predicate can be correct and exported and still called by nobody, and that is
 * exactly the state this file was written to fix — the entry in
 * `FahrtenbuchTripsView` shipped to `staging` wrapped in nothing.
 *
 * Why it matters more here than for the other two names: the page behind this
 * door writes **invented rides into `fahrtenbuch_trips`**, the statutory ride
 * log. They are permanently marked SIMULIERT, so this is a marked document and
 * not a laundered one — but a Stundennachweis and the Lohnart premiums read the
 * **times** of a trip, those times are invented, and such a document reaches a
 * Steuerberater. The write's only gate is the `documents` edit right, which
 * every company administrator and supervisor holds, so on production the link is
 * what stands between a customer and that document.
 *
 * The scan reads the source rather than importing it, because a call site is a
 * fact about the code and not a value any module exports — `featureFlagCallSites`
 * and `rolePageKeys`' rule. Its own non-vacuity is asserted first: a scan that
 * silently found nothing would pass every rule below.
 *
 * **What it does not catch**, stated rather than implied: a door assembled so
 * that neither the address nor the label appears as text in the file (a URL
 * built from parts, a label read from a variable). Two detectors are not a
 * proof; they are the two spellings every door in the product uses today.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

/**
 * Comments out, or the doc block above the entry — which names the address it
 * opens — would read as a door and fail the rule it exists to explain.
 *
 * Block comments go whole; for line comments only a line that *starts* with
 * `//` or `*` is dropped, never the tail after a `//` elsewhere, because a `//`
 * inside a string literal would otherwise take the rest of a real line with it.
 * Each comment is replaced by spaces of the same length, so every index this
 * file reports still points at the real line of the real file.
 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => (/^\s*(\/\/|\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

/**
 * The two spellings a door uses: the address the generator is opened at, and
 * the label the entry carries. Either one in a file means that file offers the
 * generator to somebody.
 */
const DOORS = [/art=simuliert/g, /simrides\.entry\./g];

/**
 * The spans of every `simulatedRidesEntryShown(…) && (` guard in a file, as
 * `[openParen, closeParen]` over the comment-stripped source.
 *
 * Parens are counted rather than parsed. A paren inside a string literal would
 * miscount — none of the guarded blocks has one today, and a miscount makes the
 * rules below **fail**, never pass, so the error direction is the safe one.
 */
const guardSpans = (source: string): [number, number][] => {
  const guard = /simulatedRidesEntryShown\s*\(\s*import\.meta\.env\.VITE_DEPLOY_ENV\s*,\s*import\.meta\.env\.DEV\s*\)\s*&&\s*\(/g;
  const spans: [number, number][] = [];
  for (const match of source.matchAll(guard)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          spans.push([open, i]);
          break;
        }
      }
    }
  }
  return spans;
};

interface Door {
  file: string;
  /** 1-based, so a failure names a line a reader can open. */
  line: number;
  text: string;
  guarded: boolean;
}

const doors = (): Door[] => {
  const found: Door[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = path.slice(SRC.length);
    // The rule itself is not a door, and neither are the dictionaries: they
    // define the label's words, they do not offer it to anybody. Both
    // dictionaries must keep the key — German is canonical and English is a
    // `Partial` of it — so excluding them is not excusing a door.
    if (file === 'components/navVisibility.ts' || file === 'i18n/de.ts' || file === 'i18n/en.ts') continue;
    const source = withoutComments(readFileSync(path, 'utf8'));
    const spans = guardSpans(source);
    for (const pattern of DOORS) {
      for (const match of source.matchAll(pattern)) {
        const index = match.index ?? 0;
        found.push({
          file,
          line: source.slice(0, index).split('\n').length,
          text: match[0],
          guarded: spans.some(([open, close]) => index > open && index < close),
        });
      }
    }
  }
  return found;
};

describe('the simulated-ride generator is offered only where it is meant to be seen', () => {
  const found = doors();

  it('the scan finds doors at all, so the rules below are not vacuous', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('the paren matcher finds a real enclosing guard, which isolates its own failure', () => {
    // Stated plainly: this is **implied** by the two rules around it — if the
    // scan finds doors and none of them is unguarded, then at least one is
    // guarded. It is kept because it fails *first* and names the matcher rather
    // than the file, and the matcher is the one part of this scan that counts
    // parens instead of parsing them. Without it, a matcher that silently
    // stopped working would be reported as "FahrtenbuchTripsView ships an
    // unguarded door", which is the wrong thing to go and look at.
    expect(found.filter(door => door.guarded).length).toBeGreaterThan(0);
  });

  it('no door is offered without the environment guard', () => {
    // This is the rule. Remove the wrapper in `FahrtenbuchTripsView` and this
    // line names the file and the line that would ship to production.
    expect(found.filter(door => !door.guarded).map(door => `${door.file}:${door.line} (${door.text})`))
      .toEqual([]);
  });

  it('today that is exactly one door, the entry beside Import in the Fahrtenbuch', () => {
    // Measured. A second door makes this line move in the commit that adds it,
    // so hiding one place cannot quietly become theatre.
    expect([...new Set(found.map(door => door.file))]).toEqual(['components/FahrtenbuchTripsView.tsx']);
  });

  it('the route stays open in every environment, because this hides a link and nothing else', () => {
    // `/monatsplan?art=simuliert` must keep rendering the page everywhere: the
    // generator is reachable by address and fully usable on staging, exactly as
    // the Monatsplan is. A guard added here would be a different change from
    // the one the owner asked for, and a far larger one.
    const entry = readFileSync(`${SRC}pages/MonthlyPlanEntryPage.tsx`, 'utf8');
    expect(entry).toContain('<SimulatedRidesPage />');
    expect(withoutComments(entry)).not.toContain('simulatedRidesEntryShown');
  });
});
