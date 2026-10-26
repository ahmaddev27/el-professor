import { PAGE_DEFINITIONS } from '../types/role';
import type { TranslationKey } from '../i18n';

/**
 * Which of the Rollen screen's thirty-two checkboxes enforce anything.
 *
 * The screen shows sixteen areas × two boxes, `Ansehen` and `Bearbeiten`.
 * **Twenty-two of those thirty-two store a value nothing ever reads**, and
 * until this module they were drawn, ticked and saved exactly like the ten that
 * work — so unticking `Ansehen` on Gehälter for `viewer` produced a success
 * toast while that viewer went on reading every salary row.
 *
 * ## Measured on production's catalogue, 25.10.2026, read-only
 *
 * ```sql
 * -- every current_role_permits occurrence in a policy expression, by second argument
 * --   need_edit = true   177
 * --   need_edit = false    0
 * -- and over every function body in public + app_private: 23 occurrences, all true
 * ```
 *
 * So `can_view` is dead **end to end**: the second argument of
 * `current_role_permits(page, need_edit)` is `true` at all 200 call sites, which
 * is the `can_edit` column; the function has no default for it, so nothing can
 * reach the `ELSE rp.can_view` branch of its body. CLAUDE.md states the design
 * it follows from — *"SELECT is never gated by a role"* — and there is no
 * `can(page, 'view')` call site in `src/` either: `AuthContext.can()` defaults
 * its action to `'edit'`, the sidebar gates on `usePlan().can(feature)` (the
 * **plan**, not the role), and the one `can(page, 'view')` in the tree is an
 * assertion in `companyScope.test.ts`.
 *
 * `Bearbeiten` is dead on six of the sixteen, for two different reasons:
 *
 *  - `overview`, `statistics`, `accounting` — **no** policy and no function
 *    names them at all (measured: 0 mentions beside `current_role_permits`).
 *  - `users`, `roles`, `settings` — their tables are gated by
 *    `is_company_admin()`, which reads `user_profiles.role = 'admin'` and never
 *    looks at `role_permissions`; `CompanyAdminRoute` in App.tsx hides the three
 *    routes from a non-`admin` on the same test. The seeded `supervisor` holds
 *    `can_edit` on all three — three rights nothing honours.
 *
 * ## What this module is, and is not
 *
 * It is the **presentation** of that measurement, and nothing else. No policy,
 * no migration and no `role_permissions` row moves because of it: a disabled box
 * still carries its stored value into `permissionPayload()`, which is why
 * `company_role_save`'s wholesale delete-and-reinsert does not strip a role's
 * `can_view` rows on the next save. That is the load-bearing part — see the
 * header of `rolePermissionEnforcement.test.ts`.
 *
 * It deliberately does **not** change the key list. `PAGE_DEFINITIONS` is pinned
 * against `public.role_page_keys()` by `rolePageKeys.test.ts`, so the sixteen
 * keys and their order stay exactly as they are; what changes is how they are
 * grouped on screen.
 */

/** Why a page's two boxes are, or are not, settable. */
export type PageEnforcement =
  /** `current_role_permits('<page>', true)` gates this page's writes. `Bearbeiten` is real. */
  | 'role_edit'
  /** `is_company_admin()` gates it. A role cannot grant it, whatever the box says. */
  | 'company_admin'
  /** Nothing in the database names this page. Neither box does anything. */
  | 'unenforced';

/**
 * The ten pages whose `Bearbeiten` box is enforced.
 *
 * Held here as a list rather than derived at runtime, because the authority is
 * the database's catalogue and the browser cannot read it. It does not drift
 * unnoticed: `rolePermissionEnforcement.test.ts` rebuilds the same set by
 * scanning `supabase/migrations/` and fails when the two differ in either
 * direction — the rule `rolePageKeys.test.ts` already applies to the key list.
 */
export const ROLE_EDIT_ENFORCED_PAGES = [
  'cars',
  'cash-balance',
  'documents',
  'drivers',
  'fixed-costs',
  'income',
  'notes',
  'receipts',
  'salaries',
  'werkstatt',
] as const;

/** Gated by `is_company_admin()`, which never reads `role_permissions`. */
export const COMPANY_ADMIN_PAGES = ['roles', 'settings', 'users'] as const;

/** Named by no policy and no function. Both boxes are inert. */
export const UNENFORCED_PAGES = ['accounting', 'overview', 'statistics'] as const;

/**
 * Is the `Ansehen` column enforced anywhere?
 *
 * A constant, because the measurement above is not a per-page fact: every one of
 * the 200 call sites passes `need_edit = true`. It is named rather than inlined
 * so that the day a policy does ask `current_role_permits(page, false)`, the
 * grep for this identifier lands on the one place the screen has to change.
 */
export const VIEW_IS_ENFORCED = false;

const ROLE_EDIT = new Set<string>(ROLE_EDIT_ENFORCED_PAGES);
const COMPANY_ADMIN = new Set<string>(COMPANY_ADMIN_PAGES);

/**
 * What enforces a page's writes.
 *
 * A key this module does not know — which `PAGE_DEFINITIONS` cannot contain
 * while `rolePageKeys.test.ts` passes — answers `unenforced`, the fail-closed
 * side: a box that may do nothing is drawn as doing nothing, rather than
 * promising a right nobody has checked for.
 */
export function enforcementOf(pageKey: string): PageEnforcement {
  if (ROLE_EDIT.has(pageKey)) return 'role_edit';
  if (COMPANY_ADMIN.has(pageKey)) return 'company_admin';
  return 'unenforced';
}

/** May the administrator set this page's `Bearbeiten` box? */
export function editBoxIsSettable(pageKey: string): boolean {
  return enforcementOf(pageKey) === 'role_edit';
}

/**
 * May the administrator set a page's `Ansehen` box? Never, on any page.
 *
 * Takes no argument on purpose: a signature with a `pageKey` would read as if
 * the answer varied by page and invite a per-page exception that the database
 * does not support.
 */
export function viewBoxIsSettable(): boolean {
  return VIEW_IS_ENFORCED;
}

/** One section of the permission table: the areas that share an enforcement. */
export interface PermissionGroup {
  kind: PageEnforcement;
  /** The areas in this section, in `PAGE_DEFINITIONS` order. */
  pages: readonly { key: string; label: TranslationKey; description: TranslationKey }[];
  /** The section heading. */
  headingKey: TranslationKey;
  /**
   * The sentence under the heading saying what this section's `Bearbeiten`
   * column does. Absent for the ten that work, which need no excuse.
   */
  reasonKey?: TranslationKey;
}

/**
 * The sixteen areas grouped by what enforces them, the live group first.
 *
 * Grouping rather than a badge per row, because the reason is a property of the
 * group and repeating it six times is noise — and because the first question an
 * administrator has is "which of these can I actually set", which a section
 * answers and a scattered list does not. The order **inside** each group is
 * `PAGE_DEFINITIONS`', so the screen and the export still read in the same
 * sequence within a section.
 */
export function permissionGroups(): PermissionGroup[] {
  const of = (kind: PageEnforcement) =>
    PAGE_DEFINITIONS.filter(page => enforcementOf(page.key) === kind);

  const groups: PermissionGroup[] = [
    {
      kind: 'role_edit',
      pages: of('role_edit'),
      headingKey: 'users.roles.group.roleControlled',
    },
    {
      kind: 'company_admin',
      pages: of('company_admin'),
      headingKey: 'users.roles.group.adminOnly',
      reasonKey: 'users.roles.group.adminOnly.reason',
    },
    {
      kind: 'unenforced',
      pages: of('unenforced'),
      headingKey: 'users.roles.group.notRoleControlled',
      reasonKey: 'users.roles.group.notRoleControlled.reason',
    },
  ];

  return groups.filter(group => group.pages.length > 0);
}

/**
 * How many areas this role actually grants — the dialog's subtitle.
 *
 * `can_edit` on a page the role gates, and nothing else. The subtitle used to
 * count every area with either box set, which answered "how many boxes are
 * ticked" and read as "how much this role may do": for a role copied from
 * `viewer` (sixteen `can_view` rows, no `can_edit`) it said *16 Bereiche
 * ausgewählt* about a role that grants no right anywhere in the product.
 */
export function grantedAreaCount(map: Readonly<Record<string, { can_edit: boolean }>>): number {
  return ROLE_EDIT_ENFORCED_PAGES.filter(key => map[key]?.can_edit).length;
}
