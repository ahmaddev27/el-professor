/**
 * The pure half of the Rollen screen.
 *
 * Two of these are worth more than the rest, because the failure they guard is
 * silent rather than loud:
 *
 *  - `permissionPayload()` is what `company_role_save` stores, and that RPC
 *    **replaces** a role's rows: whatever the payload does not name is deleted.
 *    A payload built from the wrong shape is therefore not an error message,
 *    it is a role that saves with no permissions and a success toast. The
 *    dedicated case below is the one that was live on this branch until the
 *    form and the screen were made to state the same type.
 *  - `roleHolderCounts()` decides whether the delete button is offered at all.
 *    Counting too few offers a delete the foreign key then refuses; counting a
 *    profile that names a role of another company would be worse, so the
 *    by-name fallback is pinned as narrowly as the database resolves it.
 */
import { describe, expect, it } from 'vitest';
import {
  deleteRefusalMessage,
  emptyPermissions,
  enabledAreaCount,
  initialRoleId,
  ownRoles,
  permissionPayload,
  permissionsFromTemplate,
  roleActionVerdict,
  roleHolderCounts,
  roleNameOf,
  saveRefusalMessage,
  templateRoles,
  ROLE_PAGE_KEYS,
  type PermissionMap,
} from './companyRoles';
import type { Role, RolePermission } from '../types/role';

const role = (over: Partial<Role> & { id: string; name: string }): Role => ({
  description: '',
  is_system: false,
  created_by: null,
  created_at: '2026-09-23T00:00:00Z',
  updated_at: '2026-09-23T00:00:00Z',
  ...over,
});

const permission = (page_key: string, can_view: boolean, can_edit: boolean): RolePermission => ({
  id: `p-${page_key}`,
  role_id: 'r1',
  page_key,
  can_view,
  can_edit,
  created_at: '2026-09-23T00:00:00Z',
});

describe('permissionPayload: what company_role_save stores, and only that', () => {
  it('names an area the form permits, and drops one it does not', () => {
    const map: PermissionMap = {
      ...emptyPermissions(),
      overview: { can_view: true, can_edit: false },
      drivers: { can_view: true, can_edit: true },
    };
    expect(permissionPayload(map)).toEqual([
      { page_key: 'overview', can_view: true, can_edit: false },
      { page_key: 'drivers', can_view: true, can_edit: true },
    ]);
  });

  it('edit implies view — the rule the RPC refuses as edit_without_view', () => {
    const map: PermissionMap = { ...emptyPermissions(), income: { can_view: false, can_edit: true } };
    expect(permissionPayload(map)).toEqual([{ page_key: 'income', can_view: true, can_edit: true }]);
  });

  it('names no key outside role_page_keys(), whatever the map holds', () => {
    const map = { ...emptyPermissions(), 'a-screen-of-a-later-release': { can_view: true, can_edit: true } };
    expect(permissionPayload(map).map(entry => entry.page_key))
      .toEqual(expect.not.arrayContaining(['a-screen-of-a-later-release']));
  });

  it('an empty map is an empty payload — which the RPC stores as "permits nothing"', () => {
    expect(permissionPayload(emptyPermissions())).toEqual([]);
  });

  /*
    The defect this file exists for. RoleModal used to hand over
    `Object.entries(map).map(…)` — a *list* of rows. Every `map[page_key]`
    lookup then answers undefined, every entry is dropped, and the role saves
    with nothing: every holder locked out of every page, reported as a success.
    TypeScript refuses it now; this states what the refusal is worth.
  */
  it('a list where a map belongs produces an empty payload — never silently half a role', () => {
    const asList = [
      { page_key: 'overview', can_view: true, can_edit: true },
      { page_key: 'drivers', can_view: true, can_edit: false },
    ] as unknown as PermissionMap;
    expect(permissionPayload(asList)).toEqual([]);
  });
});

describe('permissionsFromTemplate: a full map over all sixteen areas', () => {
  it('fills every known key, not only the rows the template stores', () => {
    const map = permissionsFromTemplate([permission('overview', true, true)]);
    expect(Object.keys(map).sort()).toEqual([...ROLE_PAGE_KEYS].sort());
    expect(map.overview).toEqual({ can_view: true, can_edit: true });
    expect(map.settings).toEqual({ can_view: false, can_edit: false });
  });

  it('drops a key this build does not know rather than carrying it to the RPC', () => {
    // company_role_save refuses an unknown page_key, so an older browser
    // copying a template a newer migration widened would fail on save.
    const map = permissionsFromTemplate([permission('a-screen-of-a-later-release', true, true)]);
    expect(map['a-screen-of-a-later-release']).toBeUndefined();
  });

  it('corrects a stored can_edit without can_view on the way in', () => {
    expect(permissionsFromTemplate([permission('income', false, true)]).income)
      .toEqual({ can_view: true, can_edit: true });
  });

  it('no permissions at all is every area off', () => {
    expect(permissionsFromTemplate(undefined)).toEqual(emptyPermissions());
    expect(enabledAreaCount(permissionsFromTemplate(undefined))).toBe(0);
  });
});

describe('roleHolderCounts: who would lose their permissions', () => {
  const roles = [
    role({ id: 'sys-viewer', name: 'viewer', is_system: true }),
    role({ id: 'own-dispo', name: 'Disponent' }),
  ];

  it('counts by role_id first', () => {
    expect(roleHolderCounts(roles, [{ role_id: 'own-dispo', role: 'viewer' }]))
      .toEqual({ 'sys-viewer': 0, 'own-dispo': 1 });
  });

  it('falls back to the legacy text role, case- and whitespace-insensitively', () => {
    expect(roleHolderCounts(roles, [{ role_id: null, role: '  disponent ' }])['own-dispo']).toBe(1);
  });

  it('does not count a profile whose role_id names a role this screen cannot see', () => {
    // Another company's role, or one a concurrent write created. Counting it
    // against one of ours would refuse a delete for the wrong reason.
    expect(roleHolderCounts(roles, [{ role_id: 'somewhere-else', role: 'Disponent' }]))
      .toEqual({ 'sys-viewer': 0, 'own-dispo': 0 });
  });

  it('a role nobody holds counts zero rather than going missing', () => {
    expect(roleHolderCounts(roles, [])).toEqual({ 'sys-viewer': 0, 'own-dispo': 0 });
  });
});

describe('roleActionVerdict: what the screen offers', () => {
  const own = { is_system: false };
  const system = { is_system: true };

  it('a read-only support context refuses every action, system role or not', () => {
    // refuse_read_only_context_write refuses every write to roles and
    // role_permissions in a view context; the button says so first.
    expect(roleActionVerdict(own, 'edit', { readOnly: true, holders: 0 }))
      .toEqual({ allowed: false, reason: { kind: 'read_only' } });
    expect(roleActionVerdict(own, 'delete', { readOnly: true, holders: 0 }).allowed).toBe(false);
  });

  it('a system role is neither edited nor deleted', () => {
    expect(roleActionVerdict(system, 'edit', { readOnly: false, holders: 0 }))
      .toEqual({ allowed: false, reason: { kind: 'system_role' } });
    expect(roleActionVerdict(system, 'delete', { readOnly: false, holders: 3 }).reason)
      .toEqual({ kind: 'system_role' });
  });

  it('a role still held may be edited but not deleted, and the count is the message', () => {
    expect(roleActionVerdict(own, 'edit', { readOnly: false, holders: 2 }).allowed).toBe(true);
    expect(roleActionVerdict(own, 'delete', { readOnly: false, holders: 2 }))
      .toEqual({ allowed: false, reason: { kind: 'assigned', count: 2 } });
  });

  it('a role nobody holds is deletable', () => {
    expect(roleActionVerdict(own, 'delete', { readOnly: false, holders: 0 })).toEqual({ allowed: true });
  });
});

describe('the refusals say which refusal it was', () => {
  it('a reserved name and a name already taken are different sentences', () => {
    expect(saveRefusalMessage({ ok: false, reason: 'name_reserved' })?.key)
      .toBe('users.roles.error.nameReserved');
    expect(saveRefusalMessage({ ok: false, reason: 'name_taken' })?.key)
      .toBe('users.roles.error.nameTaken');
    expect(saveRefusalMessage({ ok: false, reason: 'name_reserved' })?.key)
      .not.toBe(saveRefusalMessage({ ok: false, reason: 'name_taken' })?.key);
  });

  it('a reason this build does not know still says something', () => {
    expect(saveRefusalMessage({ ok: false, reason: 'a_reason_of_a_later_release' })?.key)
      .toBe('users.roles.error.save');
    expect(deleteRefusalMessage({ ok: false, reason: 'a_reason_of_a_later_release' })?.key)
      .toBe('users.roles.error.delete');
  });

  it('a missing answer is a refusal, not a success', () => {
    // `{ data: null }` from a call that did not raise. Reading it as ok would
    // toast "Rolle erfolgreich gelöscht" over a role that is still there.
    expect(saveRefusalMessage(null)).not.toBeNull();
    expect(deleteRefusalMessage(undefined)).not.toBeNull();
  });

  it('success is no message', () => {
    expect(saveRefusalMessage({ ok: true, role_id: 'r1' })).toBeNull();
    expect(deleteRefusalMessage({ ok: true })).toBeNull();
  });

  it('the delete refusal carries the number of accounts, and never zero', () => {
    expect(deleteRefusalMessage({ ok: false, reason: 'assigned', assigned_count: 4 }))
      .toEqual({ key: 'users.roles.error.stillAssigned', vars: { count: 4 } });
    // The RPC only answers `assigned` when it counted at least one, but a
    // sentence reading "noch 0 Benutzerkonten zugewiesen" would be nonsense.
    expect(deleteRefusalMessage({ ok: false, reason: 'assigned' })?.vars).toEqual({ count: 1 });
  });
});

describe('templateRoles / ownRoles / initialRoleId', () => {
  const roles = [
    role({ id: 'own-b', name: 'Örtlicher Leiter' }),
    role({ id: 'sys-admin', name: 'admin', is_system: true }),
    role({ id: 'own-a', name: 'Disponent' }),
    role({ id: 'sys-viewer', name: 'viewer', is_system: true }),
  ];

  it('splits the list the way the screen draws it, each side sorted', () => {
    expect(templateRoles(roles).map(r => r.id)).toEqual(['sys-admin', 'sys-viewer']);
    expect(ownRoles(roles).map(r => r.id)).toEqual(['own-a', 'own-b']);
  });

  it('a form starts on the role the account holds, by id', () => {
    expect(initialRoleId(roles, { role_id: 'own-a', role: 'admin' })).toBe('own-a');
  });

  it('and by name where the profile carries only the legacy text', () => {
    expect(initialRoleId(roles, { role_id: null, role: 'Disponent' })).toBe('own-a');
  });

  it("a company's own role of that name outranks the system one", () => {
    // current_role_permits() and manage-users.roleIdFor() order it the same way.
    const withOwnAdmin = [...roles, role({ id: 'own-admin', name: 'admin' })];
    expect(initialRoleId(withOwnAdmin, { role: 'admin' })).toBe('own-admin');
  });

  it('falls back to viewer rather than to an empty picker', () => {
    expect(initialRoleId(roles, undefined)).toBe('sys-viewer');
    expect(initialRoleId([], undefined)).toBe('');
  });

  it('roleNameOf answers the text the legacy readers store', () => {
    expect(roleNameOf(roles, 'own-a')).toBe('Disponent');
    expect(roleNameOf(roles, 'no-such-role')).toBeUndefined();
  });
});
