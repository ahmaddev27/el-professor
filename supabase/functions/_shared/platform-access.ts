/**
 * Platform authorization and audit for the edge functions (plan 3.1).
 *
 * A function never decides platform rights itself and never reads
 * `user_profiles.is_super_admin`, which only routes the browser. It asks the
 * database, with the caller's own JWT:
 *
 * - `platform_can(capability)` answers from `app_private.platform_staff` and the
 *   capability matrix in `app_private.platform_capability_matrix()`.
 * - `platform_can_manage_account(user_id)` answers whether the caller may act on
 *   that account: an account with a staff row needs `staff.manage`, any other
 *   one `company_users.manage`.
 * - `platform_audit_record(...)` writes the audit row, and takes the actor, the
 *   actor's role and the session from that same token, so a function cannot
 *   attribute an action to anyone else.
 *
 * All three must be called through a client that carries the caller's
 * Authorization header. The service role holds EXECUTE on none of them, and
 * would have no `auth.uid()` to answer for.
 *
 * The audit fails closed. A platform read writes its row before the response
 * is built, and a platform write records an `attempt` row before it changes
 * anything; when either row cannot be written the action does not happen.
 * Only the outcome row of a write, which follows the change, is best-effort.
 *
 * Pure: no Deno, npm: or jsr: imports, so vitest runs it under Node.
 */

/** The capability names of plan 3.A. The database decides who holds which. */
export const PLATFORM_CAPABILITIES = [
  'companies.read',
  'business.read',
  'support.session',
  'company_users.manage',
  'companies.lifecycle',
  'companies.hard_delete',
  'billing.manage',
  'pricing.manage',
  'codes.manage',
  'settings.read',
  'settings.manage',
  'metrics.read',
  'audit.read',
  'staff.manage',
] as const;

export type PlatformCapability = typeof PLATFORM_CAPABILITIES[number];

/** The only categories platform_audit_record accepts; the others belong to the database. */
export type AuditCategory = 'read' | 'write';
export type AuditOutcome = 'attempt' | 'ok' | 'denied' | 'error';

export interface PlatformAuditEntry {
  category: AuditCategory;
  /** Dotted lower-case name, e.g. `manage_users.create`. */
  action: string;
  outcome: AuditOutcome;
  companyId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** An action before its outcome is known. */
export type PlatformAuditSubject = Omit<PlatformAuditEntry, 'outcome'>;

/** What a row names about the target, often learned while the action runs. */
export type PlatformAuditDetails = Pick<PlatformAuditEntry, 'companyId' | 'targetType' | 'targetId' | 'before' | 'after'>;

export interface RpcResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

/** The one method of a supabase-js client this module uses. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

type LogLine = (line: string) => void;
const defaultLog: LogLine = (line) => console.error(line);

/** The check itself failed; the caller answers 500, not 403. */
export class PlatformCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformCheckError';
  }
}

/** A required audit row could not be written; the action must not go on. */
export class PlatformAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformAuditError';
  }
}

function describeRpcError(error: { message?: string; code?: string }): string {
  return [error.code, error.message].filter(Boolean).join(' ');
}

/** Only a literal `true` counts; an RPC error throws, so a failed check never reads as either answer. */
async function askBoolean(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new PlatformCheckError(`${fn} failed: ${describeRpcError(error)}`);
  }
  return data === true;
}

/** Does the caller hold `capability`? */
export function platformCan(client: RpcClient, capability: PlatformCapability): Promise<boolean> {
  return askBoolean(client, 'platform_can', { p_capability: capability });
}

/** A uuid in its canonical text form, either case. */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The company the caller has open in a support session, or null: no context,
 * a view context, one that expired, one bound to another sign-in session, or a
 * caller that is not platform staff (plan 3.13a).
 *
 * `platform_support_company_id()` is 3.4a's one answer to that question, and it
 * reads the session from the token — so it must be asked through a client that
 * carries the caller's Authorization header, never the service role. Only a
 * uuid counts; an RPC error throws, so a failed check never reads as a session.
 */
export async function platformSupportCompanyId(client: RpcClient): Promise<string | null> {
  const { data, error } = await client.rpc('platform_support_company_id');
  if (error) {
    throw new PlatformCheckError(`platform_support_company_id failed: ${describeRpcError(error)}`);
  }
  return typeof data === 'string' && UUID_SHAPE.test(data) ? data : null;
}

/**
 * May the caller, as platform staff, act on this account? Asked before any
 * platform change to an existing account: without it a `company_users.manage`
 * holder (support) could set a platform owner's address and password.
 */
export function platformCanManageAccount(client: RpcClient, userId: string): Promise<boolean> {
  return askBoolean(client, 'platform_can_manage_account', { p_user_id: userId });
}

/**
 * Does this account have a platform_staff row, a disabled one included? Asked
 * with the service-role client for a company admin's target: such an account
 * belongs to the platform, and a company admin must not change it even when
 * its profile sits in the admin's company. `account_is_platform_staff` is
 * executable by the service role alone.
 */
export function accountIsPlatformStaff(client: RpcClient, userId: string): Promise<boolean> {
  return askBoolean(client, 'account_is_platform_staff', { p_user_id: userId });
}

/** The RPC arguments for one entry; absent optional fields are sent as null. */
export function auditRpcArgs(entry: PlatformAuditEntry): Record<string, unknown> {
  return {
    p_category: entry.category,
    p_action: entry.action,
    p_outcome: entry.outcome,
    p_company_id: entry.companyId ?? null,
    p_target_type: entry.targetType ?? null,
    p_target_id: entry.targetId ?? null,
    p_before: entry.before ?? null,
    p_after: entry.after ?? null,
  };
}

/**
 * Writes an audit row the action cannot go on without, and returns its id.
 * Throws PlatformAuditError when the call fails or writes no row: for a caller
 * already authorized as platform staff, no row means the database no longer
 * sees a staff role, which is no reason to proceed either.
 *
 * The error names the action only, never the entry's values.
 */
export async function requirePlatformAudit(client: RpcClient, entry: PlatformAuditEntry): Promise<unknown> {
  let result: RpcResult;
  try {
    result = await client.rpc('platform_audit_record', auditRpcArgs(entry));
  } catch (err) {
    throw new PlatformAuditError(
      `platform_audit_record failed for ${entry.action} (${entry.outcome}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.error) {
    throw new PlatformAuditError(
      `platform_audit_record failed for ${entry.action} (${entry.outcome}): ${describeRpcError(result.error)}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new PlatformAuditError(`platform_audit_record wrote no row for ${entry.action} (${entry.outcome})`);
  }
  return result.data;
}

/**
 * Records one platform action and reports whether a row was written. The
 * database writes one only for an account with an active staff role, so calling
 * this for a refused company admin is harmless and records nothing.
 *
 * Never throws. Use it only where losing the row cannot let an unrecorded
 * action through: a refusal, or the outcome of a write whose attempt row
 * already exists. The failure goes to the log, naming the action only.
 */
export async function recordPlatformAudit(
  client: RpcClient,
  entry: PlatformAuditEntry,
  log: LogLine = defaultLog,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc('platform_audit_record', auditRpcArgs(entry));
    if (error) {
      log(JSON.stringify({ level: 'error', fn: 'platform-audit', action: entry.action, outcome: entry.outcome,
        detail: describeRpcError(error) }));
      return false;
    }
    return data !== null && data !== undefined;
  } catch (err) {
    log(JSON.stringify({ level: 'error', fn: 'platform-audit', action: entry.action, outcome: entry.outcome,
      detail: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}

export interface AuditedWriteOptions {
  /** Read when the outcome row is written, so it can name what the write learned (a new id). */
  details?: () => PlatformAuditDetails;
  log?: LogLine;
}

/**
 * Runs a platform write between an `attempt` row and its outcome row. When the
 * attempt row cannot be written, `mutate` never runs and PlatformAuditError is
 * thrown. The outcome row (`ok`, or `error` with the original error rethrown)
 * is best-effort: the change has happened or failed by then.
 */
export async function auditedPlatformWrite<T>(
  client: RpcClient,
  subject: PlatformAuditSubject,
  mutate: () => Promise<T>,
  options: AuditedWriteOptions = {},
): Promise<T> {
  await requirePlatformAudit(client, { ...subject, outcome: 'attempt' });

  let result: T;
  try {
    result = await mutate();
  } catch (err) {
    await recordPlatformAudit(client, { ...subject, ...options.details?.(), outcome: 'error' }, options.log);
    throw err;
  }
  await recordPlatformAudit(client, { ...subject, ...options.details?.(), outcome: 'ok' }, options.log);
  return result;
}

export interface AuditedReadOptions<T> {
  /** What the `ok` row says about what was read, e.g. a count. Never the data itself. */
  details?: (value: T) => PlatformAuditDetails;
  log?: LogLine;
}

/**
 * Loads what a platform read returns, then writes its `ok` row, and only then
 * hands the value back for the response. When that row cannot be written the
 * value is dropped and PlatformAuditError is thrown, so nothing leaves
 * unrecorded. A failed load gets a best-effort `error` row and is rethrown.
 */
export async function auditedPlatformRead<T>(
  client: RpcClient,
  subject: PlatformAuditSubject,
  load: () => Promise<T>,
  options: AuditedReadOptions<T> = {},
): Promise<T> {
  let value: T;
  try {
    value = await load();
  } catch (err) {
    await recordPlatformAudit(client, { ...subject, outcome: 'error' }, options.log);
    throw err;
  }
  await requirePlatformAudit(client, { ...subject, ...options.details?.(value), outcome: 'ok' });
  return value;
}
