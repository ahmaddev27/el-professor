import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsWithIcon, flatText, press, settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';
import { block, driver, note } from '../test-utils/phase3Fixtures';

/**
 * The Manuell lösen dialog on the real screen: a driver on sick leave is red.
 *
 * monatsplanungPhase3.manualNotes.test.ts proves the engine refuses; this proves
 * the screen asks it, with the notes it holds, and draws the answer as the hard
 * refusal it is. Three things are wired here and nowhere in the engine:
 *
 *  - `classifyDriver` passes `driverNotesMap` to `evaluateManualCandidate`. Without
 *    it the row is green, and nothing downstream looks at the notes until export.
 *  - The refusal is `Notiz-Einschränkung`, which `HARD_BLOCKERS` holds, so the row
 *    is red, no exception checkbox is drawn and Confirm stays off. The engine's
 *    string and the screen's list are two literals in two files; this is the only
 *    test that puts them in one room.
 *  - The candidate list is a memo, and its dependencies are listed by hand under an
 *    eslint-disable. The notes load asynchronously, so a list that does not depend
 *    on them keeps the classification it was first given.
 *
 * The text keys stand in for the German: `t` returns its key here, so the badge a
 * row carries is the dictionary key the screen resolved, not a sentence.
 */

const world = vi.hoisted(() => ({ notes: [] as unknown[] }));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  const fake = createFakeSupabase((call: FakeCall) => ({
    data: call.table === 'driver_notes' ? world.notes : null,
    error: null,
  }));
  return {
    supabase: fake.client,
    AUTH_STORAGE_KEY: 'x',
    isSupabaseConfigured: false,
    authRedirect: { type: '', error: '', errorFamily: '', errorCode: '' },
  };
});
vi.mock('xlsx', () => ({ utils: {}, writeFile: () => {}, read: () => ({}) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (keys: { one: string; other: string }) => keys.other }),
}));
vi.mock('./MonatsplanungStundennachweisPreview', () => ({ default: () => null }));
vi.mock('./FinalizePlanningModal', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: Preview } = await import('./MonatsplanungAssignmentPreview');

// One block on Friday 22.05.2026 and one driver, who has no Dienstzeit and no
// weekday rule: whether he may take the block is the notes' answer alone.
const PROPS = {
  blocks: [block('B1', '2026-05-22', '10:00', '12:00')],
  selectedDrivers: [driver()],
  trips: [],
  importId: 'import-1',
  month: 5,
  year: 2026,
  blockSeparatorMinutes: 60,
  minBlockDurationMinutes: 10,
  maxBlockDurationMinutes: 600,
  sourceFileName: 'fahrtenbuch.xlsx',
  companyId: 'company-1',
};

async function mount(props = PROPS): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(Preview, props)); });
  await settle();
  return tree;
}

async function rerender(tree: ReactTestRenderer, props: typeof PROPS): Promise<void> {
  await act(async () => { tree.update(createElement(Preview, props)); });
  await settle();
}

/** "Plan berechnen", then "Manuell lösen" on the one block it leaves open. */
async function openTheDialog(tree: ReactTestRenderer): Promise<void> {
  await press(buttonsWithIcon(tree, 'lucide-play')[0]);
  await press(buttonsWithIcon(tree, 'lucide-hand')[0]);
}

const driverRow = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.findAll(n => n.type === 'button' && flatText(n).includes('Fahrer Eins'))[0];
const badgeOf = (row: ReactTestInstance): string =>
  String(row.findAll(n => n.type === 'span' && typeof n.props.title === 'string')[0].props.title);
const checkboxes = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
const confirmButton = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.findAll(n => n.type === 'button' && flatText(n) === 'common.confirm')[0];

// The repair pass logs what it did, and Confirm logs the assignment it made; the tests
// read the screen, and read that second log only to tell an assignment from a refusal.
const confirmationLog = vi.fn();
const CONFIRMED = '[Monatsplanung] manual assignment confirmed';

beforeEach(() => {
  world.notes = [note()];
  confirmationLog.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(confirmationLog);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Manuell lösen dialog and a driver on sick leave', () => {
  it('draws him red, offers no exception to tick and leaves Confirm off', async () => {
    const tree = await mount();
    await openTheDialog(tree);

    expect(badgeOf(driverRow(tree))).toBe('mp.reason.noteConstraint');
    await press(driverRow(tree));
    expect(checkboxes(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain('mp.resolver.cannotConfirm');
    expect(confirmButton(tree).props.disabled).toBe(true);
  });

  it('refuses again at Confirm, when the button is pressed although it is off', async () => {
    // A list drawn before the notes arrived, a page edited in the browser: Confirm
    // asks the engine once more, with the notes, before anything is written.
    const tree = await mount();
    await openTheDialog(tree);
    await press(driverRow(tree));
    await press(confirmButton(tree));

    expect(confirmationLog).not.toHaveBeenCalledWith(CONFIRMED, expect.anything());
    expect(textOf(tree)).toContain('mp.unassignedBlocks');
    expect(tree.root.findAll(n => n.type === 'button' && flatText(n).includes('Fahrer Eins'))).toHaveLength(1);
  });

  it('follows the notes the screen holds now, in both directions, and assigns only while none excludes him', async () => {
    const tree = await mount();
    await openTheDialog(tree);
    await press(driverRow(tree));
    expect(badgeOf(driverRow(tree))).toBe('mp.reason.noteConstraint');

    // The notes are read again (here: for another company) and the sick note is gone.
    world.notes = [];
    await rerender(tree, { ...PROPS, companyId: 'company-2' });
    expect(badgeOf(driverRow(tree))).toBe('mp.resolver.possible');
    expect(confirmButton(tree).props.disabled).toBe(false);

    // The dangerous direction: he is selected and Confirm is on when the note arrives.
    world.notes = [note()];
    await rerender(tree, { ...PROPS, companyId: 'company-3' });
    expect(badgeOf(driverRow(tree))).toBe('mp.reason.noteConstraint');
    expect(confirmButton(tree).props.disabled).toBe(true);
    expect(checkboxes(tree)).toHaveLength(0);

    world.notes = [];
    await rerender(tree, { ...PROPS, companyId: 'company-4' });
    await press(confirmButton(tree));
    expect(confirmationLog).toHaveBeenCalledWith(CONFIRMED, expect.objectContaining({ blockId: 'B1' }));
    expect(textOf(tree)).not.toContain('mp.unassignedBlocks');
  });
});
