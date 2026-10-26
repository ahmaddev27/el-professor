import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { settle, textOf } from '../test-utils/tree';
import { PAGE_DEFINITIONS, type RolePermission } from '../types/role';
import { COMPANY_ADMIN_PAGES, ROLE_EDIT_ENFORCED_PAGES, UNENFORCED_PAGES } from '../lib/rolePermissionEnforcement';

/**
 * What an administrator actually sees in the Rollen dialog, asserted on the
 * rendered tree rather than described.
 *
 * The owner's instruction was that the dead controls stay visible and be
 * **visibly stopped** — so "22 of the 32 boxes are disabled, still show the
 * stored value, and each unsettable group says why in text" is the requirement,
 * and a requirement about what is on screen belongs in a render test. The
 * `batch4` design harness would have been the other way to see it, and it does
 * not boot on this base: `c775901` gave `usePlan()` a `companyModules` field
 * (fixed in this branch's fake) and something else in the fakes still throws
 * `subscription.unsubscribe is not a function`, which leaves every screen blank.
 *
 * Two assertions here are the ones that would catch a silent regression:
 *
 *  - **the stored value is shown, not redrawn as unchecked.** A disabled box
 *    that renders `false` regardless looks identical to a role that was never
 *    granted anything, and the next person would "fix" the payload to match it.
 *  - **the disabled boxes still travel into `onSave`.** That is the whole
 *    payload question: `company_role_save` replaces a role's rows wholesale, so
 *    a value the dialog stops carrying is a row the RPC deletes.
 *
 * `t` returns the key, so every assertion names a translation key and the file
 * says nothing about German or English wording.
 */

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, {
  window: eventTarget(),
  // The dialog's scroll lock writes `document.body.style.overflow`.
  document: { ...eventTarget(), body: { style: {} }, visibilityState: 'visible' },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  }),
}));
vi.mock('./ui', async importOriginal => {
  const original = await importOriginal<typeof import('./ui')>();
  return {
    ...original,
    // Radix's dialog needs a real DOM; its children are what this file is about.
    Dialog: (p: { children: unknown }) => p.children,
    DialogContent: (p: { children: unknown }) => p.children,
    DialogTitle: (p: { children: unknown }) => p.children,
    DialogDescription: (p: { children: unknown }) => createElement('p', { 'data-subtitle': true }, p.children as never),
  };
});

const { default: RoleModal } = await import('./RoleModal');

const ALL_KEYS = PAGE_DEFINITIONS.map(page => page.key);

const permission = (page_key: string, can_view: boolean, can_edit: boolean): RolePermission => ({
  id: `p-${page_key}`,
  role_id: 'r-dispo',
  page_key,
  can_view,
  can_edit,
  created_at: '2026-10-25T00:00:00Z',
});

/**
 * The harness's own `Disponent` fixture: edit on two gated pages, view-only on
 * `documents` (a row that must survive a save) and nothing stored at all for
 * the remaining eleven areas.
 */
const DISPONENT: RolePermission[] = [
  permission('overview', true, false),
  permission('drivers', true, true),
  permission('cars', true, true),
  permission('werkstatt', true, false),
  permission('documents', true, false),
];

const ROLE = {
  id: 'r-dispo',
  name: 'Disponent',
  description: 'Fahrer, Fahrzeuge und Monatsplanung',
  is_system: false,
  created_by: 'u1',
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
};

interface Box {
  page: string;
  column: 'view' | 'edit';
  checked: boolean;
  disabled: boolean;
  describedby?: string;
  node: ReactTestInstance;
}

/** Every checkbox in the dialog, keyed by the area and column its label names. */
function boxes(tree: ReactTestRenderer): Box[] {
  return tree.root
    .findAll(node => node.type === 'input' && node.props.type === 'checkbox')
    .map(node => {
      const label = String(node.props['aria-label'] ?? '');
      const [labelKey, columnKey] = label.split(': ');
      const page = PAGE_DEFINITIONS.find(definition => definition.label === labelKey);
      if (!page) throw new Error(`checkbox label names no known area: ${label}`);
      return {
        page: page.key,
        column: columnKey === 'users.roles.col.view' ? 'view' as const : 'edit' as const,
        checked: Boolean(node.props.checked),
        disabled: Boolean(node.props.disabled),
        describedby: node.props['aria-describedby'] as string | undefined,
        node,
      };
    });
}

const box = (all: Box[], page: string, column: 'view' | 'edit'): Box => {
  const found = all.find(candidate => candidate.page === page && candidate.column === column);
  if (!found) throw new Error(`no ${column} box for ${page}`);
  return found;
};

async function open(permissions: RolePermission[] = DISPONENT, onSave = vi.fn(async () => {})) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(RoleModal, {
      isOpen: true,
      onClose: () => {},
      onSave,
      role: ROLE,
      existingPermissions: permissions,
      templates: [],
    }));
  });
  await settle();
  return { tree, onSave };
}

describe('the Rollen dialog draws all thirty-two boxes and stops twenty-two of them', () => {
  it('every area still has both boxes — nothing is removed from the screen', async () => {
    const { tree } = await open();
    const all = boxes(tree);
    expect(all).toHaveLength(32);
    for (const key of ALL_KEYS) {
      expect(box(all, key, 'view')).toBeTruthy();
      expect(box(all, key, 'edit')).toBeTruthy();
    }
  });

  it('ten boxes are settable and twenty-two are disabled', async () => {
    const { tree } = await open();
    const all = boxes(tree);
    expect(all.filter(candidate => !candidate.disabled)).toHaveLength(10);
    expect(all.filter(candidate => candidate.disabled)).toHaveLength(22);
  });

  it('the settable ten are the Bearbeiten boxes of the role-gated pages, and nothing else', async () => {
    const { tree } = await open();
    const settable = boxes(tree).filter(candidate => !candidate.disabled);
    expect(settable.every(candidate => candidate.column === 'edit')).toBe(true);
    expect(settable.map(candidate => candidate.page).sort()).toEqual([...ROLE_EDIT_ENFORCED_PAGES].sort());
  });

  it('every Ansehen box is disabled, on all sixteen areas', async () => {
    const { tree } = await open();
    for (const key of ALL_KEYS) expect(box(boxes(tree), key, 'view').disabled).toBe(true);
  });

  it('Bearbeiten is disabled on the administrator-only three and the ungated three', async () => {
    const { tree } = await open();
    const all = boxes(tree);
    for (const key of [...COMPANY_ADMIN_PAGES, ...UNENFORCED_PAGES]) {
      expect(box(all, key, 'edit').disabled, `${key} edit should be disabled`).toBe(true);
    }
  });
});

describe('a disabled box shows the stored value, not a blank', () => {
  it('the stored can_view ticks are drawn although they cannot be set', async () => {
    const { tree } = await open();
    const all = boxes(tree);
    // The five areas the fixture stores a row for.
    for (const key of ['overview', 'drivers', 'cars', 'werkstatt', 'documents']) {
      expect(box(all, key, 'view').checked, `${key} view should be ticked`).toBe(true);
    }
    // And the eleven it stores nothing for stay empty, rather than being
    // invented as granted.
    for (const key of ALL_KEYS.filter(k => !['overview', 'drivers', 'cars', 'werkstatt', 'documents'].includes(k))) {
      expect(box(all, key, 'view').checked, `${key} view should be empty`).toBe(false);
    }
  });

  it('a stored can_edit on an administrator-only page is drawn, disabled and ticked', async () => {
    // `supervisor` holds exactly this — a right nothing honours. Hiding it
    // would hide the fact; this is the state the screen now makes legible.
    const { tree } = await open([...DISPONENT, permission('users', true, true)]);
    const users = box(boxes(tree), 'users', 'edit');
    expect(users.checked).toBe(true);
    expect(users.disabled).toBe(true);
  });

  it('a settable box still toggles, and ticking it ticks the disabled Ansehen beside it', async () => {
    // The database's rule, not a glitch: `company_role_save` refuses
    // `edit_without_view`, so the view box has to follow.
    const { tree } = await open();
    const before = boxes(tree);
    expect(box(before, 'salaries', 'edit').checked).toBe(false);
    expect(box(before, 'salaries', 'view').checked).toBe(false);

    await act(async () => { box(before, 'salaries', 'edit').node.props.onChange({}); });
    await settle();

    const after = boxes(tree);
    expect(box(after, 'salaries', 'edit').checked).toBe(true);
    expect(box(after, 'salaries', 'view').checked).toBe(true);
    expect(box(after, 'salaries', 'view').disabled).toBe(true);
  });
});

describe('each stopped group says why, in visible text', () => {
  it('the three group headings and the two group reasons are rendered', async () => {
    const { tree } = await open();
    const text = textOf(tree);
    expect(text).toContain('users.roles.group.roleControlled');
    expect(text).toContain('users.roles.group.adminOnly');
    expect(text).toContain('users.roles.group.adminOnly.reason');
    expect(text).toContain('users.roles.group.notRoleControlled');
    expect(text).toContain('users.roles.group.notRoleControlled.reason');
  });

  it('the Ansehen column carries its own sentence, once', async () => {
    const { tree } = await open();
    const notes = tree.root.findAll(node => node.type === 'p' && node.props.id === 'role-modal-view-note');
    expect(notes).toHaveLength(1);
    expect(textOf(tree)).toContain('users.roles.view.notEnforced');
  });

  it('the reasons are visible text and not only a tooltip or a title attribute', async () => {
    // A disabled input is skipped by the tab order, so a `title` or an
    // `aria-describedby` alone would be an explanation nobody is offered.
    const { tree } = await open();
    const reasons = tree.root.findAll(node =>
      typeof node.type === 'string' && String(node.props.id ?? '').startsWith('role-modal-'));
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    const titled = tree.root.findAll(node => node.type === 'input' && node.props.title !== undefined);
    expect(titled).toHaveLength(0);
  });

  it('every disabled box points at the sentence that explains it, and that sentence exists', async () => {
    const { tree } = await open();
    /*
      Both halves matter, and the second was added because a mutation control
      found the first alone insufficient: deleting the reason paragraphs left
      every `aria-describedby` in place, naming an id that resolves to nothing.
      A dangling reference announces nothing at all, so the id has to be
      rendered.
    */
    const renderedIds = new Set(
      tree.root
        .findAll(node => typeof node.type === 'string' && typeof node.props.id === 'string')
        .map(node => node.props.id as string),
    );
    for (const candidate of boxes(tree).filter(entry => entry.disabled)) {
      const where = `${candidate.page}/${candidate.column}`;
      expect(candidate.describedby, where).toBeTruthy();
      expect(renderedIds.has(candidate.describedby!), `${where} -> ${candidate.describedby} is not rendered`).toBe(true);
    }
    const all = boxes(tree);
    expect(box(all, 'salaries', 'view').describedby).toBe('role-modal-view-note');
    expect(box(all, 'users', 'edit').describedby).toBe('role-modal-reason-company_admin');
    expect(box(all, 'statistics', 'edit').describedby).toBe('role-modal-reason-unenforced');
    // A settable box needs no excuse.
    expect(box(all, 'salaries', 'edit').describedby).toBeUndefined();
  });

  it('the administrator-only reason differs from the ungated one', async () => {
    const { tree } = await open();
    const all = boxes(tree);
    expect(box(all, 'users', 'edit').describedby).not.toBe(box(all, 'statistics', 'edit').describedby);
  });
});

describe('the subtitle counts what the role grants, not how many boxes are ticked', () => {
  it('a role with two gated edit rights reads as two', async () => {
    const { tree } = await open();
    expect(textOf(tree)).toContain('users.roles.areasEffective.other');
  });

  it('a role holding only can_view reads as granting nothing', async () => {
    // Sixteen ticked boxes and no effective right — `viewer`'s shape, and the
    // claim the old subtitle made about it ("16 Bereiche ausgewählt").
    const viewOnly = ALL_KEYS.map(key => permission(key, true, false));
    const { tree } = await open(viewOnly);
    expect(textOf(tree)).toContain('users.roles.noEffectivePermissions');
    expect(textOf(tree)).not.toContain('users.roles.areasEffective');
  });

  it('a role holding edit only on pages nothing enforces reads as granting nothing', async () => {
    const dead = [...COMPANY_ADMIN_PAGES, ...UNENFORCED_PAGES].map(key => permission(key, true, true));
    const { tree } = await open(dead);
    expect(textOf(tree)).toContain('users.roles.noEffectivePermissions');
  });
});

describe('the disabled boxes still travel into the save', () => {
  it('onSave receives can_view for every stored row, so the wholesale replace keeps them', async () => {
    /*
      `company_role_save` deletes every `role_permissions` row of the role and
      re-inserts what the payload names. A `can_view` the dialog stopped
      carrying is therefore a row the RPC deletes — and for a role with any edit
      right it is worse than a loss: `can_edit` true beside `can_view` false or
      absent is refused as `edit_without_view`, compared with
      `IS NOT DISTINCT FROM` so the omitted case refuses too, and the save fails
      outright.
    */
    const { tree, onSave } = await open();
    const form = tree.root.findAll(node => node.type === 'form')[0];
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    await settle();

    expect(onSave).toHaveBeenCalledTimes(1);
    const map = (onSave.mock.calls[0] as unknown[])[1] as Record<string, { can_view: boolean; can_edit: boolean }>;
    expect(map.documents).toEqual({ can_view: true, can_edit: false });
    expect(map.overview).toEqual({ can_view: true, can_edit: false });
    expect(map.werkstatt).toEqual({ can_view: true, can_edit: false });
    expect(map.drivers).toEqual({ can_view: true, can_edit: true });
    expect(map.cars).toEqual({ can_view: true, can_edit: true });
  });

  it('no area is ever handed over with can_edit and not can_view', async () => {
    const { tree, onSave } = await open();
    await act(async () => {
      box(boxes(tree), 'salaries', 'edit').node.props.onChange({});
    });
    await settle();
    const form = tree.root.findAll(node => node.type === 'form')[0];
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    await settle();

    const map = (onSave.mock.calls[0] as unknown[])[1] as Record<string, { can_view: boolean; can_edit: boolean }>;
    for (const [key, state] of Object.entries(map)) {
      expect(state.can_edit && !state.can_view, `${key} would be refused as edit_without_view`).toBe(false);
    }
    expect(map.salaries).toEqual({ can_view: true, can_edit: true });
  });

  it('a stored right on an administrator-only page is handed back unchanged', async () => {
    // Opening a role and pressing Save must not quietly drop it.
    const { tree, onSave } = await open([...DISPONENT, permission('settings', true, true)]);
    const form = tree.root.findAll(node => node.type === 'form')[0];
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    await settle();

    const map = (onSave.mock.calls[0] as unknown[])[1] as Record<string, { can_view: boolean; can_edit: boolean }>;
    expect(map.settings).toEqual({ can_view: true, can_edit: true });
  });
});
