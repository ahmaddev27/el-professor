/**
 * Fahrtenanalyse's two loads must not cancel each other.
 *
 * `TripAnalysisPage` runs two independent loads: the company's own rows
 * (imports, drivers, settings) and the chosen month's rows (trips,
 * Stundennachweise, budgets). Each numbers its request so that only the newest
 * may install an answer, and each clears its own `loading…` flag in a `finally`
 * guarded by `request === <ref>.current`.
 *
 * Both took their number from **one** `requestRef`. React runs effects in
 * declaration order, so whenever the two ran in the same commit the second one
 * took the next number and the first was left stale against the shared counter:
 *
 *   company effect:  request = ++requestRef.current   ->  1
 *   month effect:    request = ++requestRef.current   ->  2
 *   company resolves: 1 === 2 is false  ->  finally skips setLoadingCompany(false)
 *
 * `loadingCompany` then stayed `true` for the life of the page. Two things put
 * both effects in one commit: pressing **retry** (`reloadKey`, a dependency of
 * both), and a change of company while an `importId` was still set. The retry is
 * the bad one, because it also clears `loadFailed` — and `loadFailed` is the
 * branch that *carries the retry button*. So the screen fell from the failure
 * message through to `loading` and stayed on the skeleton with nothing left to
 * press. Only a page reload got out of it.
 *
 * The rule: **one counter per load.** Not one per page.
 *
 * **This is a source test because the page cannot be rendered here**:
 * `vitest.config.ts` sets `environment: 'node'` and the project has no jsdom and
 * no testing-library, so there is no way to mount the component, fail a load and
 * press retry. What can be checked without a renderer is that each numbered load
 * owns its counter, and that is what this file checks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE = fileURLToPath(new URL('../pages/TripAnalysisPage.tsx', import.meta.url));
const source = readFileSync(PAGE, 'utf8');

/** Every `const request = ++<name>.current;` in the file, in order. */
const NUMBERED_LOAD = /const request = \+\+(\w+)\.current;/g;

function countersTaken(): string[] {
  return [...source.matchAll(NUMBERED_LOAD)].map(match => match[1]);
}

describe('TripAnalysisPage — one stale-request counter per load, not one per page', () => {
  it('numbers more than one load, so this rule is doing work', () => {
    // If the page is ever reduced to a single load the rule is vacuous and this
    // file should be deleted rather than left passing for the wrong reason.
    expect(countersTaken().length).toBeGreaterThanOrEqual(2);
  });

  it('gives every numbered load a counter of its own', () => {
    const taken = countersTaken();
    const distinct = new Set(taken);

    // THE ASSERTION THAT FAILED BEFORE: two loads, one counter — `taken` was
    // ['requestRef', 'requestRef'], so 1 distinct against 2 sites.
    expect(
      distinct.size,
      `two loads share a counter: ${taken.join(', ')} — the losing one never clears its loading flag`,
    ).toBe(taken.length);
  });

  it('declares each counter as its own ref, starting at zero', () => {
    for (const counter of countersTaken()) {
      expect(source, `${counter} is not declared as a useRef(0)`).toContain(`const ${counter} = useRef(0)`);
    }
  });

  it('guards each load against its own counter and no other', () => {
    // Four mentions per counter, and they are the whole discipline: one to take
    // the number, two to refuse a stale answer (the success path and the catch),
    // and one in the `finally` that clears the loading flag. A count other than
    // four means a guard was dropped or points at the wrong counter — which is
    // exactly how the defect behaved, and a stale `finally` is the one that
    // leaves the skeleton up.
    for (const counter of countersTaken()) {
      const mentions = source.split(`${counter}.current`).length - 1;
      expect(mentions, `${counter}.current is referenced ${mentions} times, expected 4`).toBe(4);
    }
  });

  it('no longer carries a single shared counter', () => {
    // NEGATIVE CONTROL. `requestRef` was the shared one. It may appear in prose
    // explaining what went wrong, but never again as a declaration.
    expect(source).not.toContain('const requestRef = useRef(0)');
    expect(source).not.toMatch(/const request = \+\+requestRef\.current;/);
  });

  it('still clears its loading flag from a finally, for both loads', () => {
    // The flags themselves: if a future change drops the `finally` guard instead
    // of fixing the counter, the skeleton comes back a different way.
    expect(source).toContain('setLoadingCompany(false)');
    expect(source).toContain('setLoadingMonth(false)');
    const finallyGuards = source.match(/if \(request === \w+\.current\) setLoading\w+\(false\);/g) ?? [];
    expect(finallyGuards.length).toBe(countersTaken().length);
  });
});
