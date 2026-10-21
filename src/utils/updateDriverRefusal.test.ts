/**
 * Deactivating replaced deleting a driver (owner, 21.10.2026), so two things
 * have to stay true and neither is visible from a type: the status write must
 * read back what it touched, and no delete path may come back as a
 * convenience. `assertRowsUpdated` and its own test were this file's first
 * shape; they went when the branch merged, because `src/lib/writeOutcome.ts`
 * already answered the same question for four other screens and three copies
 * of one helper is how they drift apart. What that helper does on zero rows is
 * tested in `writeOutcome.test.ts`; what is tested here is that `updateDriver`
 * asks it, and that the delete is gone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('deactivating a driver', () => {
  const hook = read('../hooks/useDatabase.ts');
  const updateDriver = hook.slice(hook.indexOf('const updateDriver = async'), hook.indexOf('// Receipt operations'));

  it('writes status through updateDriver and reads the rows back', () => {
    expect(updateDriver).toContain('updateData.status = status');
    expect(updateDriver).toMatch(/updateChecked\(\s*supabase,\s*'drivers',\s*updateData/);
  });

  it('separates a refusal from a row someone else already removed', () => {
    // Reporting "no permission" for a driver a colleague deleted in another tab
    // is the same lie in the other direction.
    expect(updateDriver).toMatch(/outcome === 'refused'[\s\S]{0,80}fahrer\.updateRefused/);
    expect(updateDriver).toMatch(/outcome === 'gone'[\s\S]{0,80}common\.writeAlreadyGone/);
  });

  it('has no delete path left: not in the hook, the page or the screen', () => {
    expect(hook).not.toMatch(/deleteDriver|\.from\('drivers'\)\s*\.delete\(/);
    const driversApi = hook.slice(hook.indexOf('drivers: {'), hook.indexOf('receipts: {'));
    expect(driversApi).toContain('update: updateDriver');
    expect(driversApi).not.toContain('delete');
    const page = read('../pages/FahrerPage.tsx');
    const screen = read('../components/DriversManagement.tsx');
    for (const src of [page, screen]) {
      expect(src).not.toMatch(/onDeleteDriver|handleDeleteDriver|canDelete|Trash2|driverActions\.delete/);
    }
  });
});
