import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsWithIcon, press, settle, textOf } from '../test-utils/tree';
import { callsOf, type FakeCall } from '../test-utils/fakeSupabase';
import { NOTE_TYPES } from '../utils/noteRules';

/**
 * Notizen: a note's planning effect follows its type, except for the two types
 * that are the operator's own.
 *
 * The planner reads `note_planning_behavior` and nothing else, so a `sick` note
 * saved as `neutral` did not exclude the driver. The database refuses that
 * pairing now (`driver_notes_behavior_follows_type`); this is the screen's half:
 * the effect field is locked while it already says what the type says, a type
 * change resets it, a note saved before the rule can still be corrected, and a
 * pairing the database would refuse is never sent.
 */

const world = vi.hoisted(() => ({
  notes: [] as Record<string, unknown>[],
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const note = (type: string, behavior: string): Record<string, unknown> => ({
  id: 'n1', driver_id: 'd1', note_date: '2026-10-13T08:00:00.000Z', note_text: 'Hinweis',
  created_at: '2026-10-13T08:00:00.000Z', note_type: type, note_planning_behavior: behavior,
  is_full_day: true, start_time: null, end_time: null, start_date: '2026-10-13', end_date: '2026-10-13',
  car_id: null, drivers: { name: 'Anna' }, cars: null,
});

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'update' || call.op === 'delete') return { data: [{ id: 'n1' }], error: null };
    const rows: Record<string, unknown[]> = { driver_notes: world.notes, drivers: [{ id: 'd1', name: 'Anna' }] };
    return { data: rows[call.table] ?? [], error: null };
  });
  return { supabase: world.fake.client };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => true }) }));
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

const EFFECTS = ['neutral', 'exclude_from_plan', 'must_include_in_plan'];

/** Mounts the page holding one note and opens it for editing. */
async function openForEdit(type: string, behavior: string): Promise<ReactTestRenderer> {
  world.notes = [note(type, behavior)];
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(NotesPage)); });
  await settle();
  await press(buttonsWithIcon(tree, 'credit-card')[0]);
  return tree;
}

const optionValues = (select: ReactTestInstance): string[] =>
  select.findAll(n => n.type === 'option').map(o => String(o.props.value));

const sameList = (a: string[], b: readonly string[]): boolean => a.join() === [...b].join();

function effectSelect(tree: ReactTestRenderer): ReactTestInstance {
  const found = tree.root.findAll(n => n.type === 'select' && sameList(optionValues(n), EFFECTS));
  expect(found).toHaveLength(1);
  return found[0];
}

function typeSelect(tree: ReactTestRenderer): ReactTestInstance {
  const found = tree.root.findAll(n => n.type === 'select' && sameList(optionValues(n), NOTE_TYPES));
  expect(found).toHaveLength(1);
  return found[0];
}

const choose = async (select: ReactTestInstance, value: string): Promise<void> => {
  await act(async () => { select.props.onChange({ target: { value } }); });
  await settle();
};

async function submit(tree: ReactTestRenderer): Promise<void> {
  const form = tree.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  await settle();
}

const updates = () => callsOf(world.fake!.calls, 'driver_notes', 'update');
const sent = () => updates()[0]?.payload as Record<string, unknown> | undefined;
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);

beforeEach(() => {
  world.showToast.mockReset();
  world.fake!.calls.length = 0;
});

describe('the effect field follows the type', () => {
  it.each([
    ['sick', 'exclude_from_plan'],
    ['vacation', 'exclude_from_plan'],
    ['blitzer', 'must_include_in_plan'],
    ['wait', 'must_include_in_plan'],
  ])('is locked, with its reason, for a %s note that already says %s', async (type, effect) => {
    const tree = await openForEdit(type, effect);
    expect(effectSelect(tree).props.disabled).toBe(true);
    expect(effectSelect(tree).props.value).toBe(effect);
    expect(textOf(tree)).toContain('notes.behaviorFixed');
  });

  it.each(['general', 'other'])('stays the operator\'s for a %s note', async (type) => {
    const tree = await openForEdit(type, 'neutral');
    expect(effectSelect(tree).props.disabled).toBe(false);
    expect(textOf(tree)).not.toContain('notes.behaviorFixed');
  });

  it('is reset to the type\'s own when the type changes, and locks', async () => {
    const tree = await openForEdit('general', 'neutral');
    await choose(typeSelect(tree), 'sick');
    expect(effectSelect(tree).props.value).toBe('exclude_from_plan');
    expect(effectSelect(tree).props.disabled).toBe(true);

    await choose(typeSelect(tree), 'other');
    expect(effectSelect(tree).props.value).toBe('neutral');
    expect(effectSelect(tree).props.disabled).toBe(false);
  });
});

describe('saving', () => {
  it('sends the effect the operator chose for a free type', async () => {
    const tree = await openForEdit('general', 'neutral');
    await choose(effectSelect(tree), 'must_include_in_plan');
    await submit(tree);

    expect(toasts()).toEqual(['success:notes.updated']);
    expect(sent()).toMatchObject({ note_type: 'general', note_planning_behavior: 'must_include_in_plan' });
  });

  it('sends the type and its own effect together after a type change', async () => {
    const tree = await openForEdit('general', 'neutral');
    await choose(typeSelect(tree), 'vacation');
    await submit(tree);

    expect(sent()).toMatchObject({ note_type: 'vacation', note_planning_behavior: 'exclude_from_plan' });
  });
});

describe('a note saved before the rule, whose effect disagrees with its type', () => {
  it('opens with the field unlocked, so it can be corrected', async () => {
    const tree = await openForEdit('vacation', 'neutral');
    expect(effectSelect(tree).props.disabled).toBe(false);
    expect(effectSelect(tree).props.value).toBe('neutral');
  });

  it('is not sent as it is: the screen says why and writes nothing', async () => {
    const tree = await openForEdit('vacation', 'neutral');
    await submit(tree);

    expect(toasts()).toEqual(['error:notes.behaviorMismatch']);
    expect(updates()).toHaveLength(0);
  });

  it('is saved once the effect is the type\'s, and the field locks', async () => {
    const tree = await openForEdit('vacation', 'neutral');
    await choose(effectSelect(tree), 'exclude_from_plan');
    expect(effectSelect(tree).props.disabled).toBe(true);

    await submit(tree);
    expect(toasts()).toEqual(['success:notes.updated']);
    expect(sent()).toMatchObject({ note_type: 'vacation', note_planning_behavior: 'exclude_from_plan' });
  });

  it('is also saved by moving it to a type that leaves the effect to the operator', async () => {
    const tree = await openForEdit('vacation', 'neutral');
    await choose(typeSelect(tree), 'general');
    await submit(tree);

    expect(sent()).toMatchObject({ note_type: 'general', note_planning_behavior: 'neutral' });
  });
});
