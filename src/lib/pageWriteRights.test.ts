/**
 * The trap: a gate whose first argument is ignored.
 *
 * `AuthContext.canEdit(record, page?)` answers "is this an administrator" when
 * no page is given, whatever the record is. Belege, Fahrer and Umsätze called
 * it that way, so a role holding `can_edit` there never saw an edit or a delete
 * button. The fake below restates AuthContext's two bodies (the component cannot
 * be rendered here: environment is node, no jsdom).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PageKey } from '../contexts/AuthContext';
import { pageWriteRights, type PageRightsSource } from './pageWriteRights';

function source(editable: PageKey[], isAdmin = false): PageRightsSource {
  const can = (page: PageKey, action: 'view' | 'edit' = 'edit') =>
    action === 'view' || editable.includes(page);
  return {
    can,
    canEdit: (_record, page) => (page ? can(page, 'edit') : isAdmin),
    canDelete: (_record, page) => (page ? can(page, 'edit') : isAdmin),
  };
}

describe('pageWriteRights', () => {
  it.each(['receipts', 'drivers', 'income'] as const)('%s: a role with can_edit there sees edit, delete and add', (page) => {
    const r = pageWriteRights(page, source([page]));
    expect(r.canEdit({ id: 1 })).toBe(true);
    expect(r.canDelete({ id: 1 })).toBe(true);
    expect(r.canCreate).toBe(true);
  });

  it.each(['receipts', 'drivers', 'income'] as const)('%s: a role without it sees none, even when it edits another page', (page) => {
    const other: PageKey = page === 'income' ? 'receipts' : 'income';
    const r = pageWriteRights(page, source([other]));
    expect(r.canEdit({ id: 1 })).toBe(false);
    expect(r.canDelete({ id: 1 })).toBe(false);
    expect(r.canCreate).toBe(false);
  });

  it('without the page key the same role is refused (the defect)', () => {
    expect(source(['receipts']).canEdit({ id: 1 })).toBe(false);
  });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the screens bind their page and check their deletes', () => {
  it.each([
    ['../pages/BelegePage.tsx', "pageWriteRights('receipts'"],
    ['../pages/FahrerPage.tsx', "pageWriteRights('drivers'"],
    ['../components/DriversManagement.tsx', "pageWriteRights('drivers'"],
    ['../components/IncomeManagement.tsx', "pageWriteRights('income'"],
  ])('%s asks %s', (file, call) => {
    expect(read(file)).toContain(call);
  });

  it('the three screens no longer take canCreate from the any-page default', () => {
    for (const f of ['../pages/BelegePage.tsx', '../pages/FahrerPage.tsx', '../components/IncomeManagement.tsx', '../components/DriversManagement.tsx']) {
      expect(read(f)).not.toMatch(/\}\s*=\s*useCompanyScope\(\)/);
    }
  });

  it('every delete reads its rows back and checks them (lib/writeOutcome.ts)', () => {
    const hook = read('../hooks/useDatabase.ts');
    for (const table of ['receipts', 'drivers']) {
      expect(hook, table).toContain(`deleteChecked(supabase, '${table}'`);
    }
    expect(read('../components/IncomeManagement.tsx')).toContain("deleteChecked(supabase, 'income'");
  });
});
