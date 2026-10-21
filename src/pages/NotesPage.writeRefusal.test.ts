import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, buttonsWithIcon, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/**
 * Notizen: an edit or a delete the database refuses must not read as a success.
 *
 * `driver_notes` is gated by the Notizen page right. For a role without it the
 * UPDATE or DELETE meets a USING clause that hides the row, and PostgREST
 * answers 200 with zero rows: the screen used to toast "gespeichert" or
 * "gelöscht" over a note that had not changed.
 */

const world = vi.hoisted(() => ({
  mayEdit: true,
  /** Whether UPDATE and DELETE reach the row (the role holds the right). */
  writeReaches: true,
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const NOTE = {
  id: 'n1', driver_id: 'd1', note_date: '2026-10-13T08:00:00.000Z', note_text: 'Reifenwechsel fällig',
  created_at: '2026-10-13T08:00:00.000Z', note_type: 'general', note_planning_behavior: 'neutral',
  is_full_day: true, start_time: null, end_time: null, start_date: '2026-10-13', end_date: '2026-10-13',
  car_id: null, drivers: { name: 'Anna' }, cars: null,
};

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'update' || call.op === 'delete') {
      return { data: world.writeReaches ? [{ id: 'n1' }] : [], error: null };
    }
    const rows: Record<string, unknown[]> = { driver_notes: [NOTE], drivers: [{ id: 'd1', name: 'Anna' }] };
    return { data: rows[call.table] ?? [], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => world.mayEdit }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../hooks/usePartnerCatchUp', () => ({
  usePartnerCatchUp: () => ({ catchUp: async () => false, fetching: false, available: false }),
}));

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { NotesPage } = await import('./NotesPage');

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(NotesPage)); });
  await settle();
  return tree;
}

const editButtons = (tree: ReactTestRenderer) => buttonsWithIcon(tree, 'credit-card');
const deleteButtons = (tree: ReactTestRenderer) => buttonsWithIcon(tree, 'trash');
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

async function saveEditedNote(tree: ReactTestRenderer): Promise<void> {
  await press(editButtons(tree)[0]);
  const form = tree.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  await settle();
}

beforeEach(() => {
  world.mayEdit = true;
  world.writeReaches = true;
  world.showToast.mockReset();
  world.fake!.calls.length = 0;
});

describe('NotesPage: edit and delete follow the page right', () => {
  it('offers both to a role that may edit', async () => {
    const tree = await mount();
    expect(textOf(tree)).toContain('Reifenwechsel fällig');
    expect(editButtons(tree)).toHaveLength(1);
    expect(deleteButtons(tree)).toHaveLength(1);
  });

  it('offers neither to a role that may not, and still lists the note', async () => {
    world.mayEdit = false;
    const tree = await mount();
    expect(textOf(tree)).toContain('Reifenwechsel fällig');
    expect(editButtons(tree)).toHaveLength(0);
    expect(deleteButtons(tree)).toHaveLength(0);
  });
});

describe('NotesPage: the UPDATE is checked', () => {
  it('toasts success when the note was changed', async () => {
    const tree = await mount();
    await saveEditedNote(tree);
    expect(toasts()).toEqual(['success:notes.updated']);
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.writeReaches = false;
    const tree = await mount();
    await saveEditedNote(tree);
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });
});

describe('NotesPage: the DELETE is checked', () => {
  const deleteTheNote = async (tree: ReactTestRenderer) => {
    await press(deleteButtons(tree)[0]);
    await press(buttonsLabelled(tree, 'common.delete')[0]);
  };

  it('toasts success when the note was deleted', async () => {
    const tree = await mount();
    await deleteTheNote(tree);
    expect(toasts()).toEqual(['success:notes.deleted']);
  });

  it('reports a refusal, and no success, when zero rows come back', async () => {
    world.writeReaches = false;
    const tree = await mount();
    await deleteTheNote(tree);
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });
});
