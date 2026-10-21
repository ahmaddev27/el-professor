import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flatText, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Dokumente: deleting saved Stundennachweise the database refuses must not read
 * as a success.
 *
 * `saved_stundennachweise` is gated by the Dokumente page right, which the
 * seeded `viewer` AND `editor` roles lack (20260923130000). For them the DELETE
 * meets a USING clause that hides the rows, and PostgREST answers 200 with zero
 * rows: the dialog used to close as if the record were gone.
 */

const world = vi.hoisted(() => ({
  mayEdit: true,
  /** Ids the DELETE reports as removed. */
  deleted: ['r1', 'r2'] as string[],
  /** Ids the probe finds still stored. */
  remaining: [] as string[],
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const record = (id: string, name: string) => ({
  id, driver_id: `d-${id}`, driver_name: name, personalnummer: null, month: 9, year: 2026,
  grundlohn_min: 60, nachtarbeit_min: 0, nacht04_min: 0, samstag_min: 0, sonntag_min: 0,
  feiertag_min: 0, weihnachten_min: 0, working_days: 1, rows_json: [],
  saved_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', calculated_salary: null,
});

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'delete') return { data: world.deleted.map(id => ({ id })), error: null };
    if (call.filters.some(f => f.startsWith('order:')) && call.table === 'saved_stundennachweise') {
      return { data: [record('r1', 'Anna'), record('r2', 'Berta')], error: null };
    }
    // The probe: select('id') with the same filter as the write.
    return { data: world.remaining.map(id => ({ id })), error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => world.mayEdit }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../components/TrinkgeldQuittungModal', () => ({ default: () => null }));
vi.mock('../components/MietwagenauftragModal', () => ({ default: () => null }));
vi.mock('../utils/stundennachweisPdfExport', () => ({ exportStundennachweisAsPdf: vi.fn(), toPdfDayRow: vi.fn() }));
vi.mock('../components/ui', async importOriginal => {
  const original = await importOriginal<typeof import('../components/ui')>();
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...original,
    Tooltip: ({ children }: { children: unknown }) => children,
    // Radix portals cannot be rendered by react-test-renderer: an open dialog
    // draws its children inline, a closed one nothing.
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement('div', null, children) : null,
    DialogContent: pass, DialogHeader: pass, DialogFooter: pass, DialogTitle: pass, DialogDescription: pass,
  };
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: DocumentsPage } = await import('./DocumentsPage');

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(MemoryRouter, null, createElement(DocumentsPage))); });
  await settle();
  return tree;
}

const buttons = (tree: ReactTestRenderer, match: (text: string, props: Record<string, unknown>) => boolean) =>
  tree.root.findAll(n => n.type === 'button' && match(flatText(n), n.props));
const rowDeleteButtons = (tree: ReactTestRenderer) =>
  buttons(tree, (_text, p) => String(p['aria-label'] ?? '').startsWith('doc.deleteRecordAria'));
const groupDeleteButtons = (tree: ReactTestRenderer) => buttons(tree, text => text.startsWith('doc.deleteAll'));
const hasDialogBody = (tree: ReactTestRenderer) => textOf(tree).includes('doc.confirmDelete');

beforeEach(() => {
  world.mayEdit = true;
  world.deleted = ['r1', 'r2'];
  world.remaining = [];
  world.fake!.calls.length = 0;
});

describe('DocumentsPage: delete buttons follow the page right', () => {
  it('offers both the row and the month delete to a role that may edit', async () => {
    const tree = await mount();
    expect(textOf(tree)).toContain('Anna');
    expect(rowDeleteButtons(tree)).toHaveLength(2);
    expect(groupDeleteButtons(tree)).toHaveLength(1);
  });

  it('offers neither to a role that may not (editor and viewer), and still lists the records', async () => {
    world.mayEdit = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('Anna');
    expect(rowDeleteButtons(tree)).toHaveLength(0);
    expect(groupDeleteButtons(tree)).toHaveLength(0);
  });
});

describe('DocumentsPage: deleting one record is checked', () => {
  const confirmRowDelete = async (tree: ReactTestRenderer) => {
    await press(rowDeleteButtons(tree)[0]);
    await press(buttons(tree, text => text === 'common.delete')[0]);
  };

  it('closes the dialog when the record was deleted', async () => {
    world.deleted = ['r1'];
    const tree = await mount();
    await confirmRowDelete(tree);
    expect(hasDialogBody(tree)).toBe(false);
  });

  it('keeps the dialog open and says the right is missing when zero rows come back', async () => {
    world.deleted = [];
    world.remaining = ['r1'];
    const tree = await mount();
    await confirmRowDelete(tree);
    expect(hasDialogBody(tree)).toBe(true);
    expect(textOf(tree)).toContain('common.writeRefused');
  });
});

describe('DocumentsPage: deleting a month is checked', () => {
  const confirmGroupDelete = async (tree: ReactTestRenderer) => {
    await press(groupDeleteButtons(tree)[0]);
    const confirm = groupDeleteButtons(tree);
    await press(confirm[confirm.length - 1]);
  };

  it('closes the dialog when every record of the month was deleted', async () => {
    const tree = await mount();
    await confirmGroupDelete(tree);
    expect(hasDialogBody(tree)).toBe(false);
  });

  it('refuses when zero rows come back', async () => {
    world.deleted = [];
    world.remaining = ['r1', 'r2'];
    const tree = await mount();
    await confirmGroupDelete(tree);
    expect(hasDialogBody(tree)).toBe(true);
    expect(textOf(tree)).toContain('common.writeRefused');
  });

  it('refuses when only part of the month went and the rest is still stored', async () => {
    world.deleted = ['r1'];
    world.remaining = ['r2'];
    const tree = await mount();
    await confirmGroupDelete(tree);
    expect(textOf(tree)).toContain('common.writeRefused');
  });
});
