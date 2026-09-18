/**
 * Which company a screen queries, and whether it may write there (plan 3.4b).
 *
 * ## Why this exists at all
 *
 * Until 20260917140000 a platform account read every company's rows, so the
 * browser could decide on its own which company a screen was "viewing as": it
 * kept the chosen company in React state (`SuperAdminContext.activeCompany`)
 * and most screens ignored it and queried `AuthContext.companyId` instead. For
 * a platform account that column is NULL, so those screens asked for
 * `company_id = null` — empty lists, or in the plan's words "empty or showing
 * the wrong company".
 *
 * Since 20260917140000 the database answers the question itself:
 * `get_active_company_id()` returns the company of the **open context** for a
 * company-less staff account, and NULL when none is open. So the browser no
 * longer chooses; it reads. That is what makes "entering a company" survive a
 * reload — the fact lives in `app_private.platform_company_contexts`, not in a
 * tab's memory — and it is why this module takes the context as its input and
 * never a value the UI picked.
 *
 * ## The two company ids, kept apart on purpose
 *
 * `ownCompanyId` is the account's **membership** (`user_profiles.company_id`).
 * `companyId` is the company whose rows the database will actually answer for.
 * They are the same for every company user and differ only for a company-less
 * platform account inside a context. Collapsing them — making
 * `AuthContext.companyId` resolve to the context — would erase the distinction
 * three other rules depend on: `receiptScope()` tells `own_company` from
 * `other_company` by comparing exactly these two, `ownCompanyDataReadable()`
 * judges the account's own company by the database's answer for it, and
 * AuthContext's own company/approval/subscription queries are about the
 * membership and nothing else.
 *
 * ## The order of the branches mirrors the database
 *
 * `get_active_company_id()` resolves a member first and only then looks at the
 * context, and `platform_context_open` refuses an account that has a company
 * (`account_in_company`). So a staff account that still sits inside a company
 * is judged by its own profile here too: its own company wins, and a context it
 * somehow holds is ineffective. Anything else would show a screen a company the
 * database will not answer for.
 *
 * None of this is a permission. Every statement is checked again in the
 * database; these values only stop a screen claiming what it never read, and
 * stop it offering a write the server is about to refuse.
 */
import type { PlatformCompanyContext } from './platformAccess';

/** How the current screen came by its company. */
export type CompanyScopeKind =
  /** The account's own company — every company user, and staff that has one. */
  | 'own'
  /** A platform read context: the rows are readable, every write is refused. */
  | 'view'
  /** A platform support context: reads and writes, with a reason on record. */
  | 'support'
  /** No company at all: a company-less platform account with nothing open. */
  | 'none';

export interface CompanyScope {
  /** The company every tenant query must name. Null when there is none. */
  companyId: string | null;
  /** The account's membership, which is not always the company on screen. */
  ownCompanyId: string | null;
  kind: CompanyScopeKind;
  /** The company's name when the answer carried one — only a context does. */
  companyName: string | null;
  /**
   * The database will refuse every write to this company's tables.
   *
   * True in a `view` context (`app_private.refuse_read_only_context_write` and
   * `current_role_permits()`, both of which answer "only inside a support
   * session"), and true with no company at all. It is not a permission: a
   * company user's own rights are still its role's, which this module does not
   * read.
   */
  readOnly: boolean;
  /** A platform account looking at a company that is not its own. */
  isPlatformSession: boolean;
}

export interface CompanyScopeInput {
  /** `user_profiles.company_id` — the membership, null for platform staff. */
  ownCompanyId: string | null;
  /**
   * The open context, already judged live by `liveCompanyContext()`. An expired
   * one must never reach here: this module has no clock and would believe it.
   */
  context: PlatformCompanyContext | null;
}

export function companyScope({ ownCompanyId, context }: CompanyScopeInput): CompanyScope {
  if (ownCompanyId !== null) {
    return {
      companyId: ownCompanyId,
      ownCompanyId,
      kind: 'own',
      companyName: null,
      readOnly: false,
      isPlatformSession: false,
    };
  }

  if (context !== null) {
    return {
      companyId: context.companyId,
      ownCompanyId,
      kind: context.mode,
      companyName: context.companyName,
      readOnly: context.mode !== 'support',
      isPlatformSession: true,
    };
  }

  return {
    companyId: null,
    ownCompanyId,
    kind: 'none',
    companyName: null,
    readOnly: true,
    isPlatformSession: false,
  };
}

/**
 * The write questions the screens already ask, answered for this scope.
 *
 * A read context is the one state in which the browser knows a write will be
 * refused before it is attempted, so it stops offering it. Everywhere else the
 * account's own rights decide, exactly as before — this never widens them, and
 * a company user's scope is never read-only, so nothing about the tenant app
 * changes.
 *
 * Deliberately narrow: it covers the screens that ask `canEdit`, `canCreate`
 * and `canDelete`, not every button in the product. What the rest do inside a
 * read context is show their button and be refused by the database, in the
 * German sentence the refusal trigger raises. The boundary is the database
 * either way; this is courtesy, and the bar is what explains it.
 */
export function scopedWriteRights<TEdit extends (...args: never[]) => boolean>(
  scope: CompanyScope,
  rights: { canCreate: boolean; canEdit: TEdit; canDelete: TEdit },
): { canCreate: boolean; canEdit: TEdit; canDelete: TEdit } {
  if (!scope.readOnly) return rights;
  const refuse = (() => false) as unknown as TEdit;
  return { canCreate: false, canEdit: refuse, canDelete: refuse };
}

/**
 * The permission matrix question, answered for this scope.
 *
 * `can(page, 'view')` is untouched — a read context reads. `can(page, 'edit')`
 * is false in one, which is what `current_role_permits(page, true)` answers for
 * a company-less staff account outside a support session, so the button and the
 * policy agree.
 */
export function scopedCan<TPage extends string>(
  scope: CompanyScope,
  can: (page: TPage, action?: 'view' | 'edit') => boolean,
): (page: TPage, action?: 'view' | 'edit') => boolean {
  if (!scope.readOnly) return can;
  return (page, action = 'edit') => action === 'view' && can(page, action);
}
