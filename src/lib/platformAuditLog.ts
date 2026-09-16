/**
 * The audit log, as the Protokoll screen reads it (plan 3.6b/3.G).
 *
 * `platform_audit_list` answers newest first and pages by a **keyset cursor**
 * on `(occurred_at, id)`, not by an offset: the log only grows, so an offset
 * would shift under the reader and show the same row twice or skip one. The
 * answer carries `next_cursor` when more rows follow, and nothing when the last
 * page has been reached.
 *
 * Scope is the database's decision, not the screen's: `audit.read` reads the
 * whole log, and every other active staff role reads only the rows it is the
 * actor of. The answer says which it was, so the screen can say so too.
 *
 * Like the directories, a refusal is a return value (`not_authorized`) and the
 * function is VOLATILE — it records its own read — so supabase-js calls it with
 * POST.
 *
 * No I/O here: the call itself is `platformAuditClient.ts`.
 */
import { platformReadRefusalKey, type PlatformReadRefusal } from './platformReadModels';
import type { TranslationKey } from '../i18n';

export const AUDIT_PAGE_SIZE = 100;

/** The categories `app_private.platform_audit_log` accepts. */
export const AUDIT_CATEGORIES = ['read', 'write', 'support', 'auth', 'settings', 'staff', 'legacy'] as const;
export type AuditCategory = typeof AUDIT_CATEGORIES[number];

export const AUDIT_OUTCOMES = ['attempt', 'ok', 'denied', 'error'] as const;
export type AuditOutcome = typeof AUDIT_OUTCOMES[number];

export interface AuditRow {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  session_id: string | null;
  company_id: string | null;
  company_name: string | null;
  category: string;
  action: string;
  outcome: string;
  target_type: string | null;
  target_id: string | null;
  before_value: unknown;
  after_value: unknown;
}

/** The last row of a page, as the next call's starting point. */
export interface AuditCursor {
  before_occurred_at: string;
  before_id: number;
}

export interface AuditPage {
  ok: true;
  /** 'all' for audit.read, 'own' for every other active staff role. */
  scope: string;
  items: AuditRow[];
  /** null when this was the last page. */
  nextCursor: AuditCursor | null;
}

export type AuditResult = AuditPage | PlatformReadRefusal;

export function auditRefusalKey(reason: string): TranslationKey {
  return platformReadRefusalKey(reason);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parseRow(raw: Record<string, unknown>): AuditRow {
  return {
    id: typeof raw.id === 'number' ? raw.id : Number(raw.id ?? 0),
    occurred_at: typeof raw.occurred_at === 'string' ? raw.occurred_at : '',
    actor_user_id: nullableStr(raw.actor_user_id),
    actor_email: nullableStr(raw.actor_email),
    actor_role: nullableStr(raw.actor_role),
    session_id: nullableStr(raw.session_id),
    company_id: nullableStr(raw.company_id),
    company_name: nullableStr(raw.company_name),
    category: typeof raw.category === 'string' ? raw.category : '',
    action: typeof raw.action === 'string' ? raw.action : '',
    outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
    target_type: nullableStr(raw.target_type),
    target_id: nullableStr(raw.target_id),
    before_value: raw.before_value ?? null,
    after_value: raw.after_value ?? null,
  };
}

/**
 * Reads a cursor out of an answer. Both halves must be there and usable: the
 * database refuses a call that carries one without the other with 22023, so a
 * half cursor is treated as "no more pages" rather than sent back.
 */
export function parseAuditCursor(value: unknown): AuditCursor | null {
  if (!isRecord(value)) return null;
  const at = value.before_occurred_at;
  const id = value.before_id;
  if (typeof at !== 'string' || at.length === 0) return null;
  const numeric = typeof id === 'number' ? id : Number(id);
  if (!Number.isFinite(numeric)) return null;
  return { before_occurred_at: at, before_id: Math.trunc(numeric) };
}

export function parseAuditAnswer(data: unknown): AuditResult {
  if (!isRecord(data)) return { ok: false, reason: 'malformed' };
  if (data.ok !== true) {
    return { ok: false, reason: typeof data.reason === 'string' ? data.reason : 'malformed' };
  }
  if (!Array.isArray(data.items)) return { ok: false, reason: 'malformed' };

  return {
    ok: true,
    scope: typeof data.scope === 'string' ? data.scope : 'own',
    items: data.items.filter(isRecord).map(parseRow),
    nextCursor: parseAuditCursor(data.next_cursor),
  };
}

/**
 * The rows shown after a page arrives: the ones already on screen, then the new
 * ones, with any id seen twice dropped.
 *
 * A keyset cursor cannot normally repeat a row, but a "load more" pressed twice
 * would send the same cursor twice, and appending blindly would render two rows
 * with the same React key. Order is preserved — the log is read newest first.
 */
export function appendAuditRows(existing: readonly AuditRow[], incoming: readonly AuditRow[]): AuditRow[] {
  const seen = new Set(existing.map(row => row.id));
  const added = incoming.filter(row => !seen.has(row.id));
  return added.length === 0 ? [...existing] : [...existing, ...added];
}

export interface AuditQuery {
  companyId?: string | null;
  category?: string | null;
  actionPrefix?: string | null;
  outcome?: string | null;
  actorUserId?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: AuditCursor | null;
  limit?: number;
}

/**
 * The arguments of one call. Written out so the mapping from a screen's filter
 * state to the function's parameters is testable: an empty filter must become
 * NULL and not an empty string, which `platform_read_token` would refuse.
 */
export function auditRpcArgs(query: AuditQuery): Record<string, unknown> {
  const blankToNull = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  };

  return {
    p_actor_user_id: blankToNull(query.actorUserId),
    p_company_id: blankToNull(query.companyId),
    p_category: blankToNull(query.category),
    p_action_prefix: blankToNull(query.actionPrefix),
    p_outcome: blankToNull(query.outcome),
    p_from: blankToNull(query.from),
    p_to: blankToNull(query.to),
    // Both halves or neither: the database raises on one without the other.
    p_before_occurred_at: query.cursor?.before_occurred_at ?? null,
    p_before_id: query.cursor?.before_id ?? null,
    p_limit: query.limit ?? AUDIT_PAGE_SIZE,
  };
}

/**
 * A day picked in a filter, as the timestamp the database compares against.
 * `p_from` is inclusive and `p_to` exclusive, so "to 30.09." means the whole of
 * the 30th: the next local midnight, not that day's own.
 */
export function dayBoundary(isoDate: string, edge: 'from' | 'to'): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(start.getTime())) return null;
  if (edge === 'to') start.setDate(start.getDate() + 1);
  return start.toISOString();
}
