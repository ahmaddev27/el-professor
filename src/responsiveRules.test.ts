import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The layout rules e2e/responsive-sweep.mjs found broken in a browser. That sweep needs a
 * browser, a build and staging, so it cannot run in the build gate. These read the source
 * and hold the few lines each defect came down to, each of which looks removable.
 */
const source = (path: string): string => readFileSync(join(process.cwd(), 'src', path), 'utf8');

describe('responsive rules', () => {
  it('caps a select at its parent, because it sizes itself to its longest option', () => {
    // One long company name in a filter pushed the panel 241 px past a phone's edge.
    const css = source('index.css');
    expect(css).toMatch(/^select \{ max-width: 100%; \}$/m);
    expect(css).toMatch(/^td select, th select \{ max-width: none; \}$/m);
  });

  it('positions the DataTable frame, so a label in a scrolled-off cell stays clipped', () => {
    // A screen-reader label is absolutely positioned. With nothing positioned inside the frame it
    // escapes the clipping, and the page gained a sideways scroll of up to 499 px on Fahrtenanalyse.
    expect(source('components/ui/DataTable.tsx')).toMatch(/'relative overflow-auto /);
  });

  it('lets a page header put its actions on a second line', () => {
    // In a row that could not wrap, the actions squeezed the title until its word ran over them.
    const header = source('components/ui/PageHeader.tsx');
    expect(header).toContain('flex flex-wrap items-end gap-3');
    expect(header).toContain('min-w-0 flex-[1_1_16rem]');
  });

  it('keeps the Belege toolbar in a row that can wrap', () => {
    // Five fixed grid tracks left the search box 50 px wide at 1280, drawn under the month field.
    const list = source('components/ReceiptList.tsx');
    expect(list).not.toContain('lg:grid-cols-[minmax(0,1fr)_11rem_15rem_auto_auto]');
    expect(list).toContain('sm:min-w-72 sm:flex-1');
  });

  it('lets the companies tables scroll, because their actions are the last column', () => {
    // overflow-hidden cut the edit and open buttons off at every width up to 1024.
    const companies = source('pages/CompaniesPage.tsx');
    const tables = companies.split('<table className="w-full text-sm">');
    expect(tables).toHaveLength(3);
    for (const before of tables.slice(0, 2)) {
      const frame = before.lastIndexOf('rounded-2xl overflow-');
      expect(before.slice(frame, frame + 'rounded-2xl overflow-x-auto'.length)).toBe('rounded-2xl overflow-x-auto');
    }
  });

  it('lets the salary payments table scroll, because its row actions are the last column', () => {
    // overflow hidden cut "view payment" and delete off by up to 298 px on a phone, with no way to reach them.
    const frame = source('components/SalaryDetailsModal.tsx').match(/<div style=\{\{[^}]*\}\}>\s*<table className="w-full">/);
    expect(frame?.[0]).toContain("overflowX: 'auto'");
    expect(frame?.[0]).not.toContain("overflow: 'hidden'");
  });

  it('sizes a figure to its card, not to a fixed 28 px', () => {
    // 1.774,00 € ran 30 px out of a two-column card on a phone.
    const card = source('components/ui/KpiCard.tsx');
    expect(card).toContain('[container-type:inline-size]');
    expect(card).not.toContain('text-[28px]');
  });
});
