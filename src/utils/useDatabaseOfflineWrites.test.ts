/**
 * `useDatabase` must not report a write it discarded.
 *
 * The hook is the data layer of Belege, Fahrer, Umsätze and the receipt and
 * driver halves of the Overview. CLAUDE.md records its `localStorage` fallback
 * as "a legacy quirk, not a pattern to extend", and the fallback is **read
 * only** — nothing in the file calls `localStorage.setItem`. Six write branches
 * nevertheless resolved: `updateDriver`, `deleteDriver`, `updateReceipt` and
 * `deleteReceipt` with a bare `return`, and `addDriver` and `addReceipt` by
 * handing the caller a fabricated row with a `Date.now()` id. All six call sites
 * then showed their success toast (`fahrer.created`, `belege.updated`, …) and
 * reloaded a list that could not contain the row.
 *
 * The branch is unreachable while the connection check succeeds, so this was
 * latent, not live. It arms itself the moment that check fails.
 *
 * **This is a source test because the hook cannot be rendered here.**
 * `vitest.config.ts` sets `environment: 'node'` and the project has no
 * jsdom and no testing-library, so there is no way to mount a hook and drive
 * `isConnected`. What can be checked without a renderer is the shape of the six
 * branches, and that is what this file checks.
 *
 * **The negative control is the two read branches.** They must keep returning
 * from `localStorage`, because CLAUDE.md documents that fallback and three pages
 * read `isConnected` to explain an empty list rather than claim one. So a change
 * that made *every* `!isConnected` branch throw fails this file just as loudly as
 * one that makes a write resolve again.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../hooks/useDatabase.ts', import.meta.url));

/** The six operations that write. A discarded write must reject. */
const WRITES = [
  'addDriver',
  'updateDriver',
  'addReceipt',
  'updateReceipt',
  'deleteReceipt',
] as const;

/** The two that read. Their `localStorage` fallback is documented and stays. */
const READS = ['getDrivers', 'getReceipts'] as const;

/**
 * The body of the `if (!isConnected) { … }` block inside the named operation.
 *
 * Found by brace counting from the block's own `{`, so a nested object or
 * template literal inside it cannot end the block early.
 */
function offlineBranchOf(source: string, operation: string): string {
  const signature = `const ${operation} = async`;
  const declaration = source.indexOf(signature);
  expect(declaration, `${operation} is not declared in useDatabase.ts`).toBeGreaterThan(-1);

  const guard = source.indexOf('if (!isConnected) {', declaration);
  expect(guard, `${operation} has no !isConnected branch`).toBeGreaterThan(-1);

  // The guard must belong to this operation, not to the next one: no other
  // operation may be declared between the two.
  const between = source.slice(declaration + signature.length, guard);
  expect(between.includes('= async ('), `${operation}'s !isConnected branch was not found inside it`).toBe(false);

  const open = source.indexOf('{', guard);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${operation}'s !isConnected branch does not close`);
}

const source = readFileSync(HOOK, 'utf8');

describe('useDatabase — a write with no connection fails instead of reporting success', () => {
  it.each(WRITES)('%s refuses rather than resolving', operation => {
    const branch = offlineBranchOf(source, operation);

    // It must refuse. `refuseOfflineWrite()` is the one way it does so, so the
    // message stays one sentence in one place and in the UI language.
    expect(branch).toContain('refuseOfflineWrite()');

    // And it must not resolve by any of the three routes it used to take.
    expect(branch).not.toMatch(/\breturn\b/);
    expect(branch).not.toContain('Date.now()');
  });

  it('refuses through one shared helper, which reads the refusal from the dictionary', () => {
    // Not a literal: the sentence reaches the screen through
    // `handleDatabaseError`, which passes an Error's own message straight
    // through, so it has to be translated before it is thrown.
    expect(source).toContain("throw new Error(t('db.offlineWrite'))");
  });

  it('never claims to have written to localStorage, because nothing writes it', () => {
    // The write half of the fallback CLAUDE.md describes was never built: every
    // use of localStorage in the hook is a read. Until that changes, no branch
    // may say otherwise — `addReceipt` logged "Adding receipt to localStorage"
    // and then wrote nothing at all.
    //
    // Matched as a call, with its bracket, so prose about the missing fallback
    // does not read as the fallback existing. The first draft of this assertion
    // had no bracket and matched this file's own commentary.
    expect(source).not.toMatch(/localStorage\.setItem\s*\(/);
    expect(source).not.toContain('Adding receipt to localStorage');
  });
});

describe('useDatabase — the documented read fallback is untouched', () => {
  // NEGATIVE CONTROL. These two assertions fail if the change above is widened
  // to every `!isConnected` branch. The read fallback is what lets Belege,
  // Fahrer and Umsätze show "connection failed" instead of an empty list, and
  // CLAUDE.md records it as deliberate.
  it.each(READS)('%s still reads from localStorage and returns', operation => {
    const branch = offlineBranchOf(source, operation);
    expect(branch).toContain('localStorage.getItem');
    expect(branch).toMatch(/\breturn\b/);
    expect(branch).not.toContain('refuseOfflineWrite');
  });
});
