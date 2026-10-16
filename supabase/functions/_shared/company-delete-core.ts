/**
 * Deleting a company completely: the decisions the platform-staff function's
 * /delete-company route makes outside the database (migration 20261016140000).
 *
 * The database does the part that can be one transaction: `platform_company_delete`
 * removes the company and everything it owns, proves nothing was left, writes its
 * audit row, and hands back the plan it carried out — the login accounts that
 * belonged to the company and the files in its folders. What it cannot do is
 * remove a GoTrue account or a stored file; that needs the service role, and it
 * happens here, after the rows are gone.
 *
 * What this module decides, and why each is separate:
 *
 * - **Which accounts are removed.** Only the ones the database listed for this
 *   company, minus any that hold a platform staff row *now*. The database marks
 *   staff accounts `keep`; the second look is for an account that joined the
 *   platform team between the plan and the removal. A platform account is a
 *   colleague's access, and losing it to a company clean-up is not a mistake the
 *   product recovers from.
 * - **What a kept account needs afterwards.** Its profile row was removed by the
 *   company's cascade (`user_profiles.company_id` cascades, and the profile
 *   guard forbids any JWT to move a profile out of a company), so it is written
 *   back without a company.
 *
 * Pure: no Deno, npm: or jsr: imports, so vitest runs it under Node.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest company name the product stores; a typed confirmation cannot exceed it. */
const MAX_CONFIRM_NAME_LENGTH = 300;

export interface DeleteCompanyRequest {
  companyId: string;
  confirmName: string;
}

export type ParsedRequest =
  | { ok: true; request: DeleteCompanyRequest }
  | { ok: false; message: string };

/**
 * The body of POST /platform-staff/delete-company.
 *
 * The name is carried as typed. The database compares it with the company's
 * name; nothing here trims, folds case or "helps" it match.
 */
export function parseDeleteCompanyRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Ungültige Anfrage.' };
  }
  const { company_id: companyId, confirm_name: confirmName } = body as Record<string, unknown>;
  if (typeof companyId !== 'string' || !UUID_PATTERN.test(companyId)) {
    return { ok: false, message: 'Ungültige Anfrage: company_id fehlt oder ist ungültig.' };
  }
  if (typeof confirmName !== 'string' || confirmName.trim().length === 0
      || confirmName.length > MAX_CONFIRM_NAME_LENGTH) {
    return { ok: false, message: 'Ungültige Anfrage: Der Unternehmensname zur Bestätigung fehlt.' };
  }
  return { ok: true, request: { companyId, confirmName } };
}

// ─── What the database answered ─────────────────────────────────────────────

export interface DeletionAccount {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  status: string | null;
  action: 'delete' | 'keep';
  reason: string | null;
}

export interface DeletionObject {
  bucket: string;
  name: string;
}

export interface DeletionAnswer {
  rowsTotal: number;
  tables: Record<string, number>;
  accounts: DeletionAccount[];
  objects: DeletionObject[];
  fileCount: number;
}

export type ParsedAnswer =
  | { ok: true; answer: DeletionAnswer }
  | { ok: false; reason: string; message: string };

const FALLBACK_MESSAGE = 'Das Unternehmen konnte nicht gelöscht werden.';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseAccount(raw: unknown): DeletionAccount | null {
  const row = asRecord(raw);
  if (!row || typeof row.user_id !== 'string' || !UUID_PATTERN.test(row.user_id)) return null;
  if (row.action !== 'delete' && row.action !== 'keep') return null;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    user_id: row.user_id,
    email: text(row.email),
    full_name: text(row.full_name),
    role: text(row.role),
    status: text(row.status),
    action: row.action,
    reason: text(row.reason),
  };
}

function parseObject(raw: unknown): DeletionObject | null {
  const row = asRecord(raw);
  if (!row || typeof row.bucket !== 'string' || typeof row.name !== 'string') return null;
  return { bucket: row.bucket, name: row.name };
}

/**
 * `platform_company_delete`'s answer, read strictly.
 *
 * A refusal keeps its reason and the German sentence the database wrote. An
 * answer that is neither a recognisable success nor a recognisable refusal is a
 * refusal too — the caller must not go on to remove accounts on the strength of
 * something it could not read — and so is a success whose account list has an
 * entry it cannot read, because dropping that entry would silently leave it out.
 */
export function parseDeletionAnswer(data: unknown): ParsedAnswer {
  const root = asRecord(data);
  if (!root || typeof root.success !== 'boolean') {
    return { ok: false, reason: 'unknown', message: FALLBACK_MESSAGE };
  }
  if (!root.success) {
    return {
      ok: false,
      reason: typeof root.reason === 'string' ? root.reason : 'unknown',
      message: typeof root.error === 'string' ? root.error : FALLBACK_MESSAGE,
    };
  }

  const plan = asRecord(root.plan);
  const rawAccounts = plan?.accounts;
  const rawObjects = root.objects;
  if (!plan || !Array.isArray(rawAccounts) || !Array.isArray(rawObjects)) {
    return { ok: false, reason: 'unreadable', message: FALLBACK_MESSAGE };
  }

  const accounts = rawAccounts.map(parseAccount);
  const objects = rawObjects.map(parseObject);
  if (accounts.some(a => a === null) || objects.some(o => o === null)) {
    return { ok: false, reason: 'unreadable', message: FALLBACK_MESSAGE };
  }

  const tables: Record<string, number> = {};
  for (const [name, count] of Object.entries(asRecord(plan.tables) ?? {})) {
    if (typeof count === 'number') tables[name] = count;
  }
  const files = asRecord(plan.files);
  return {
    ok: true,
    answer: {
      rowsTotal: typeof plan.rows_total === 'number' ? plan.rows_total : 0,
      tables,
      accounts: accounts as DeletionAccount[],
      objects: objects as DeletionObject[],
      fileCount: typeof files?.count === 'number' ? files.count : objects.length,
    },
  };
}

/** The HTTP status a refusal maps to: the caller's mistake, or the state of the data. */
export function statusForDeleteReason(reason: string): number {
  switch (reason) {
    case 'denied': return 403;
    case 'not_found': return 404;
    case 'invalid': return 400;
    default: return 409;
  }
}

// ─── Which accounts go ──────────────────────────────────────────────────────

export interface KeptAccount extends DeletionAccount {
  /** Why the account stays: today only `platform_staff`. */
  keptBecause: string;
}

export interface AccountDecision {
  toDelete: DeletionAccount[];
  kept: KeptAccount[];
}

/**
 * Splits the database's account list into the ones to remove and the ones to keep.
 *
 * `isStaffNow` is `account_is_platform_staff` with the service role. It is asked
 * for every account the database marked `delete`, because a staff row may have
 * been added since the plan; a check that cannot be answered (it throws) keeps
 * the account — an account that stays is a defect someone can fix, one that
 * goes is not.
 */
export async function decideAccounts(
  accounts: readonly DeletionAccount[],
  isStaffNow: (userId: string) => Promise<boolean>,
): Promise<AccountDecision> {
  const toDelete: DeletionAccount[] = [];
  const kept: KeptAccount[] = [];
  for (const account of accounts) {
    if (account.action === 'keep') {
      kept.push({ ...account, keptBecause: account.reason ?? 'platform_staff' });
      continue;
    }
    let staff: boolean;
    try {
      staff = await isStaffNow(account.user_id);
    } catch {
      staff = true;
    }
    if (staff) kept.push({ ...account, keptBecause: 'platform_staff' });
    else toDelete.push(account);
  }
  return { toDelete, kept };
}

/**
 * The profile a kept account is given back: no company, the least role, active.
 *
 * Platform rights come from `platform_staff`, never from the profile (the shape
 * the invitation writes); `is_super_admin` is the flag the browser routes on and
 * `platform_staff_sync_profile` keeps in step with the staff row.
 */
export function restoredStaffProfile(account: DeletionAccount): Record<string, unknown> {
  return {
    user_id: account.user_id,
    email: account.email ?? '',
    full_name: account.full_name,
    role: 'viewer',
    role_id: null,
    company_id: null,
    status: 'active',
    is_super_admin: true,
    must_change_password: false,
  };
}

// ─── Removing them ──────────────────────────────────────────────────────────

/** GoTrue answers 404 / `user_not_found` for an account that is already gone. */
export function isAlreadyGone(error: { status?: number; code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.status === 404 || error.code === 'user_not_found' || /user not found/i.test(error.message ?? '');
}

/** Groups object names by bucket in slices the storage API accepts in one call. */
export function batchObjects(objects: readonly DeletionObject[], size = 100): Array<{ bucket: string; names: string[] }> {
  const byBucket = new Map<string, string[]>();
  for (const o of objects) {
    const names = byBucket.get(o.bucket) ?? [];
    names.push(o.name);
    byBucket.set(o.bucket, names);
  }
  const out: Array<{ bucket: string; names: string[] }> = [];
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += size) out.push({ bucket, names: names.slice(i, i + size) });
  }
  return out;
}

export interface CleanupReport {
  accountsDeleted: string[];
  accountsKept: Array<{ user_id: string; email: string | null; reason: string }>;
  accountsFailed: Array<{ user_id: string; email: string | null }>;
  profilesRestored: string[];
  profilesNotRestored: string[];
  filesRemoved: number;
  filesFailed: number;
}

/** The sentence for a deletion whose database part succeeded and whose clean-up did not finish. */
export function incompleteCleanupMessage(report: CleanupReport): string {
  const parts: string[] = ['Das Unternehmen und seine Daten wurden gelöscht, aber nicht alles konnte entfernt werden.'];
  if (report.accountsFailed.length > 0) {
    const list = report.accountsFailed.map(a => a.email ?? a.user_id).join(', ');
    parts.push(`Anmeldekonten, die noch bestehen: ${list}.`);
  }
  if (report.profilesNotRestored.length > 0) {
    parts.push('Das Profil eines Plattform-Kontos konnte nicht wiederhergestellt werden.');
  }
  if (report.filesFailed > 0) {
    parts.push(`${report.filesFailed} Datei(en) konnten nicht entfernt werden.`);
  }
  return parts.join(' ');
}

/** True when the report holds anything the operator has to follow up. */
export function cleanupIsIncomplete(report: CleanupReport): boolean {
  return report.accountsFailed.length > 0
    || report.profilesNotRestored.length > 0
    || report.filesFailed > 0;
}
