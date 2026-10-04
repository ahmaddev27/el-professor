import { PAGE_DEFINITIONS, type Role, type RolePermission, type RoleWithPermissions } from '../types/role';
import type { TranslationKey, TranslationVars } from '../i18n';

/**
 * The pure half of the Rollen screen (slice B).
 *
 * Everything here is a function of its arguments: copying a template's
 * permissions, turning the form's map into the payload `company_role_save`
 * takes, counting who holds a role, and deciding what the screen may offer for
 * a given role. None of it reaches the network, so it can be tested without a
 * renderer — which matters because the delete refusal and the template copy
 * are the two places a mistake is silent rather than loud.
 *
 * The **database** is the boundary, not this file. A system role is read-only
 * because `roles_update` requires `is_system = false`; a role still held
 * cannot be deleted because `user_profiles_role_id_fkey` says so; a name a
 * system role carries is refused by `enforce_company_role_shape`. What is
 * below only makes those refusals legible before they happen.
 */

/** One area's two boxes, as RoleModal holds them while the form is open. */
export interface PermissionState {
  can_view: boolean;
  can_edit: boolean;
}

export type PermissionMap = Record<string, PermissionState>;

/** One entry of `company_role_save`'s `p_permissions` array. */
export interface PermissionPayloadEntry {
  page_key: string;
  can_view: boolean;
  can_edit: boolean;
}

/** The sixteen keys `app_private.role_page_keys()` names, in the order shown. */
export const ROLE_PAGE_KEYS: readonly string[] = PAGE_DEFINITIONS.map(page => page.key);

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * The roles a new one may be copied from: the system rows, which every company
 * sees (`roles_select` answers `company_id IS NULL` to everyone) and none may
 * write. Sorted by name so the list does not move between loads.
 */
export function templateRoles<T extends Role>(roles: readonly T[]): T[] {
  return roles.filter(role => role.is_system).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** The company's own roles, which are the ones it may edit and delete. */
export function ownRoles<T extends Role>(roles: readonly T[]): T[] {
  return roles.filter(role => !role.is_system).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** Every area off — what "Neue Rolle" starts from when no template is chosen. */
export function emptyPermissions(): PermissionMap {
  const map: PermissionMap = {};
  for (const key of ROLE_PAGE_KEYS) map[key] = { can_view: false, can_edit: false };
  return map;
}

/**
 * A template's permissions as a full map over all sixteen areas.
 *
 * Built from every known key rather than from the template's rows, for two
 * reasons. A system role stores no row for an area it does not permit (the
 * `editor` seed writes `false, false` rows, the others simply have none), so
 * reading its rows alone would leave holes the form would draw as unset. And a
 * key the template holds that this build does not know is dropped here rather
 * than sent back to `company_role_save`, which refuses an unknown key — so an
 * older browser cannot copy a template a newer migration widened and then fail
 * to save it.
 *
 * `can_edit` implies `can_view`, the rule the form and the RPC both keep, so a
 * stored row that says otherwise is corrected on the way in rather than copied
 * forward.
 */
export function permissionsFromTemplate(permissions: readonly RolePermission[] | undefined): PermissionMap {
  const map = emptyPermissions();
  for (const permission of permissions ?? []) {
    if (!(permission.page_key in map)) continue;
    const canEdit = Boolean(permission.can_edit);
    map[permission.page_key] = { can_view: canEdit || Boolean(permission.can_view), can_edit: canEdit };
  }
  return map;
}

/** The payload `company_role_save` takes. Areas with neither box set are dropped, as the RPC drops them. */
export function permissionPayload(map: PermissionMap): PermissionPayloadEntry[] {
  return ROLE_PAGE_KEYS
    .map(key => {
      const state = map[key] ?? { can_view: false, can_edit: false };
      const can_edit = Boolean(state.can_edit);
      return { page_key: key, can_view: can_edit || Boolean(state.can_view), can_edit };
    })
    .filter(entry => entry.can_view || entry.can_edit);
}

/** How many areas the form currently permits at all — the dialog's subtitle. */
export function enabledAreaCount(map: PermissionMap): number {
  return Object.values(map).filter(state => state.can_view || state.can_edit).length;
}

// ─── Who holds a role ───────────────────────────────────────────────────────

/** A profile as the roles screen reads it: only the role it names. */
export interface ProfileRoleRow {
  role_id?: string | null;
  role?: string | null;
}

/**
 * How many accounts hold each role.
 *
 * Counted by `role_id` first and by the role's **name** second, because a
 * profile written before assignment moved to ids carries only the text. That
 * is the same order `current_role_permits()` resolves a role in, so the count
 * answers the question the delete refusal is really asking — "would anybody
 * lose their permissions?" — rather than the narrower "does a foreign key
 * point here?". A name is matched only for a role of the caller's own company,
 * since `user_profiles_select` answers that company's rows alone.
 */
export function roleHolderCounts(
  roles: readonly Role[],
  profiles: readonly ProfileRoleRow[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const role of roles) counts[role.id] = 0;

  const byName = new Map<string, string>();
  for (const role of roles) {
    if (!role.is_system) byName.set(role.name.trim().toLowerCase(), role.id);
  }

  for (const profile of profiles) {
    const byId = profile.role_id && profile.role_id in counts ? profile.role_id : null;
    if (byId) {
      counts[byId] += 1;
      continue;
    }
    if (profile.role_id) continue; // Names a role this screen cannot see; not ours to count.
    const named = profile.role ? byName.get(profile.role.trim().toLowerCase()) : undefined;
    if (named) counts[named] += 1;
  }
  return counts;
}

// ─── What the screen may offer ──────────────────────────────────────────────

export type RoleAction = 'edit' | 'delete';

export interface ActionVerdict {
  allowed: boolean;
  /** Why not — the tooltip on the disabled control, and the toast if it is pressed anyway. */
  reason?: RoleRefusal;
}

export type RoleRefusal =
  | { kind: 'system_role' }
  | { kind: 'read_only' }
  | { kind: 'assigned'; count: number };

/**
 * Whether the screen offers an action on a role, and why not.
 *
 * `readOnly` is a view support context, where `refuse_read_only_context_write`
 * refuses every write to `roles` and `role_permissions`. A system role is
 * refused by the policies. A role still held is refused by the foreign key —
 * and that is the one refusal worth naming with a number, because "you cannot
 * delete this" without saying how many accounts would be affected leaves the
 * administrator guessing which ones.
 */
export function roleActionVerdict(
  role: Pick<Role, 'is_system'>,
  action: RoleAction,
  options: { readOnly: boolean; holders: number },
): ActionVerdict {
  if (options.readOnly) return { allowed: false, reason: { kind: 'read_only' } };
  if (role.is_system) return { allowed: false, reason: { kind: 'system_role' } };
  if (action === 'delete' && options.holders > 0) {
    return { allowed: false, reason: { kind: 'assigned', count: options.holders } };
  }
  return { allowed: true };
}

// ─── The RPCs' answers ──────────────────────────────────────────────────────

export interface RoleRpcResult {
  ok: boolean;
  reason?: string;
  role_id?: string;
  assigned_count?: number;
  page_key?: string;
}

export interface RoleMessage {
  key: TranslationKey;
  vars?: TranslationVars;
}

const SAVE_REASONS: Record<string, TranslationKey> = {
  name_required: 'users.roles.nameRequired',
  name_too_long: 'users.roles.error.nameTooLong',
  name_reserved: 'users.roles.error.nameReserved',
  name_taken: 'users.roles.error.nameTaken',
  not_found: 'users.roles.error.notFound',
  system_role: 'users.roles.error.systemRole',
  not_authorized: 'users.roles.error.notAuthorized',
  no_company: 'users.roles.error.notAuthorized',
  edit_without_view: 'users.roles.error.editWithoutView',
  duplicate_page_key: 'users.roles.error.save',
  unknown_page_key: 'users.roles.error.unknownArea',
};

const DELETE_REASONS: Record<string, TranslationKey> = {
  not_found: 'users.roles.error.notFound',
  system_role: 'users.roles.systemCannotDelete',
  not_authorized: 'users.roles.error.notAuthorized',
  no_company: 'users.roles.error.notAuthorized',
};

/** The sentence for a `company_role_save` refusal, or null when it succeeded. */
export function saveRefusalMessage(result: RoleRpcResult | null | undefined): RoleMessage | null {
  if (result?.ok) return null;
  const reason = result?.reason ?? '';
  return { key: SAVE_REASONS[reason] ?? 'users.roles.error.save' };
}

/** The sentence for a `company_role_delete` refusal, or null when it succeeded. */
export function deleteRefusalMessage(result: RoleRpcResult | null | undefined): RoleMessage | null {
  if (result?.ok) return null;
  const reason = result?.reason ?? '';
  if (reason === 'assigned') {
    // The count is the point of the message: an administrator who is told
    // "still assigned" without a number has to open every account to find out.
    return {
      key: 'users.roles.error.stillAssigned',
      vars: { count: Math.max(1, Number(result?.assigned_count ?? 1)) },
    };
  }
  return { key: DELETE_REASONS[reason] ?? 'users.roles.error.delete' };
}

// ─── Assignment ─────────────────────────────────────────────────────────────

/**
 * The role a user form starts on: the one the account holds, by id where it
 * has one and by name where it carries only the legacy text — the same order
 * the database resolves it in. Falls back to `viewer`, then to the first role
 * offered, so the picker is never empty-valued.
 */
export function initialRoleId(
  roles: readonly Role[],
  account: { role_id?: string | null; role?: string | null } | undefined,
): string {
  if (roles.length === 0) return '';
  if (account?.role_id && roles.some(role => role.id === account.role_id)) return account.role_id;
  if (account?.role) {
    const name = account.role.trim().toLowerCase();
    // A company's own role of that name outranks the system one, as
    // current_role_permits() and manage-users.roleIdFor() both order it.
    const own = roles.find(role => !role.is_system && role.name.trim().toLowerCase() === name);
    if (own) return own.id;
    const system = roles.find(role => role.is_system && role.name.trim().toLowerCase() === name);
    if (system) return system.id;
  }
  const viewer = roles.find(role => role.is_system && role.name === 'viewer');
  return (viewer ?? roles[0]).id;
}

/** The stored `user_profiles.role` text that goes with a role id, for the legacy readers. */
export function roleNameOf(roles: readonly Role[], roleId: string): string | undefined {
  return roles.find(role => role.id === roleId)?.name;
}

export type { Role, RolePermission, RoleWithPermissions };
