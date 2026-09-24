/**
 * `PAGE_DEFINITIONS` and `public.role_page_keys()` are one list written twice,
 * and they have to move together.
 *
 * The screen builds a role's permission rows from `PAGE_DEFINITIONS` and
 * nothing else — `permissionPayload()` walks exactly those keys — and
 * `company_role_save` replaces a role's rows wholesale: it deletes every
 * `role_permissions` row the role has and inserts what the payload names. So a
 * key stored in the database that this build does not know is **silently
 * dropped the first time anyone edits that role**, and a key this build sends
 * that the database does not know is refused as `unknown_page_key` with a
 * dialog the administrator cannot get past.
 *
 * Neither failure says what happened. The first is the worse of the two: an
 * area a role was permitted simply stops being permitted, with a success toast.
 *
 * This is `planFeatures.test.ts`'s rule for the other list the database and the
 * browser both hold (`plan_features` / `FeatureKey`), applied here. The
 * **newest** migration that defines the function is the live one — a later
 * release adding a screen replaces it — so it is found by name order, the way
 * the migration chain itself resolves, rather than named here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_DEFINITIONS } from '../types/role';
import { ROLE_PAGE_KEYS } from '../lib/companyRoles';

/*
  `role_page_keys()` is LANGUAGE sql, so its body is a bare `SELECT ARRAY[…]`
  and not the `RETURN ARRAY[…]` of a plpgsql function. Matching the definition
  rather than any array literal is what keeps a second array elsewhere in the
  same file from being read as the list.
*/
const KEYS_IN_ARRAY = /FUNCTION public\.role_page_keys\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]/;

const keysInMigration = (): string[] => {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'))
    .filter(sql => KEYS_IN_ARRAY.test(sql));

  if (defining.length === 0) throw new Error('no migration defines public.role_page_keys()');
  const body = defining[defining.length - 1].match(KEYS_IN_ARRAY);
  // The keys carry hyphens (`fixed-costs`, `cash-balance`), which a
  // `[a-z][a-z0-9_]*` pattern would cut in half and turn into two halves that
  // match nothing.
  return [...body![1].matchAll(/'([a-z][a-z0-9_-]*)'/g)].map(match => match[1]);
};

describe('the page keys the database accepts are the page keys this build sends', () => {
  it('role_page_keys() names exactly PAGE_DEFINITIONS', () => {
    expect(keysInMigration()).toEqual(PAGE_DEFINITIONS.map(page => page.key));
  });

  it('and in the same order, so the migration reads as the screen does', () => {
    // Not a correctness requirement — `= ANY(…)` does not care — but the two
    // lists are read side by side by whoever adds a screen, and a reordered
    // copy is a copy nobody can diff.
    expect(keysInMigration().join(',')).toBe(PAGE_DEFINITIONS.map(page => page.key).join(','));
  });

  it('there are sixteen of them, which is what the migration self-checks', () => {
    // Self-check 7 of 20260923120000 fails a release where this is not 16.
    expect(keysInMigration()).toHaveLength(16);
    expect(PAGE_DEFINITIONS).toHaveLength(16);
  });

  it('no key is repeated', () => {
    const keys = keysInMigration();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ROLE_PAGE_KEYS — what permissionPayload() walks — is the same list again', () => {
    // The third copy. `companyRoles.ts` derives it from PAGE_DEFINITIONS, so
    // this holds by construction today; it is asserted because the day it is
    // hand-written instead is the day a saved role starts losing rows.
    expect([...ROLE_PAGE_KEYS]).toEqual(keysInMigration());
  });
});
