/**
 * Deleting a company completely (migration 20261016140000): the preview and the
 * deletion, from the browser.
 *
 * The preview is `platform_company_delete_preview`, an audited read. The deletion
 * is the `platform-staff` function's /delete-company route, not a direct RPC and
 * not a `.from('companies').delete()`: removing a login account needs the service
 * role, and the database's open-context guard needs the caller's own token. Both
 * halves are the function's job; this file only asks and reads the answer.
 *
 * What the preview shows and what the deletion removes come from one database
 * function (`app_private.company_deletion_plan`), so the screen cannot promise
 * something the deletion then does not do.
 */
import { supabase } from './supabase';
import { callPlatformRpc } from './platformRpc';

export interface DeletionAccount {
  userId: string;
  email: string;
  fullName: string | null;
  role: string | null;
  action: 'delete' | 'keep';
  reason: string | null;
}

export interface DeletionPreview {
  company: { id: string; name: string; status: string };
  tables: Record<string, number>;
  rowsTotal: number;
  income: { uber: number; other: number };
  accounts: DeletionAccount[];
  files: number;
  kept: {
    activationCodes: number;
    activationCodesWithAddress: number;
    activationCodeAttempts: number;
    discountCodes: number;
    auditRows: number;
    ocrEvents: number;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseAccount(raw: unknown): DeletionAccount | null {
  const row = record(raw);
  if (typeof row.user_id !== 'string' || (row.action !== 'delete' && row.action !== 'keep')) return null;
  return {
    userId: row.user_id,
    email: typeof row.email === 'string' ? row.email : '',
    fullName: typeof row.full_name === 'string' ? row.full_name : null,
    role: typeof row.role === 'string' ? row.role : null,
    action: row.action,
    reason: typeof row.reason === 'string' ? row.reason : null,
  };
}

/** The `plan` object of the database's answer, or null when it cannot be read. */
export function parseDeletionPreview(plan: unknown): DeletionPreview | null {
  const root = record(plan);
  const company = record(root.company);
  if (typeof company.id !== 'string' || typeof company.name !== 'string' || !Array.isArray(root.accounts)) return null;

  const accounts = root.accounts.map(parseAccount);
  // An entry that cannot be read is not dropped: a list that silently omits an
  // account tells the operator less than it knows.
  if (accounts.some(a => a === null)) return null;

  const tables: Record<string, number> = {};
  for (const [name, count] of Object.entries(record(root.tables))) tables[name] = num(count);
  const income = record(root.income);
  const kept = record(root.kept);
  return {
    company: { id: company.id, name: company.name, status: typeof company.status === 'string' ? company.status : '' },
    tables,
    rowsTotal: num(root.rows_total),
    income: { uber: num(income.uber), other: num(income.other) },
    accounts: accounts as DeletionAccount[],
    files: num(record(root.files).count),
    kept: {
      activationCodes: num(kept.activation_codes),
      activationCodesWithAddress: num(kept.activation_codes_with_address),
      activationCodeAttempts: num(kept.activation_code_attempts),
      discountCodes: num(kept.discount_codes),
      auditRows: num(kept.audit_rows),
      ocrEvents: num(kept.ocr_events),
    },
  };
}

/** Counts the screen names one by one; every other table is summed as "other". */
export const HEADLINE_TABLES = [
  'drivers', 'cars', 'fahrtenbuch_trips', 'income', 'receipts', 'salaries',
  'subscription_invoices', 'partner_connections',
] as const;

/** Rows in tables the screen does not name, so the headline and the total add up. */
export function otherRows(preview: DeletionPreview): number {
  const named = HEADLINE_TABLES.reduce((sum, t) => sum + (preview.tables[t] ?? 0), 0);
  return Math.max(0, preview.rowsTotal - named);
}

/** Throws the German sentence the database wrote when the preview is refused. */
export async function fetchDeletionPreview(companyId: string): Promise<DeletionPreview> {
  const answer = await callPlatformRpc('platform_company_delete_preview', { p_company_id: companyId });
  const preview = parseDeletionPreview(answer.plan);
  if (!preview) throw new Error('Die Vorschau konnte nicht gelesen werden.');
  return preview;
}

export interface DeletionOutcome {
  accountsDeleted: number;
  accountsKept: Array<{ user_id: string; email: string | null; reason: string }>;
  filesRemoved: number;
  rowsTotal: number;
}

/** Raised when the company IS deleted but something around it could not be removed. */
export class IncompleteDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteDeletionError';
  }
}

/**
 * The function answers 200 only when everything went. A refusal throws its German
 * sentence. A clean-up that stopped halfway throws IncompleteDeletionError, so the
 * screen can refresh its list — the company is gone — and still show what remains.
 */
export async function deleteCompanyCompletely(companyId: string, confirmName: string): Promise<DeletionOutcome> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Keine aktive Sitzung.');

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/platform-staff/delete-company`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, confirm_name: confirmName }),
    },
  );

  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  const payload = record(parsed);

  if (response.ok && payload.success === true) {
    return {
      accountsDeleted: num(payload.accounts_deleted),
      accountsKept: Array.isArray(payload.accounts_kept) ? payload.accounts_kept as DeletionOutcome['accountsKept'] : [],
      filesRemoved: num(payload.files_removed),
      rowsTotal: num(payload.rows_total),
    };
  }

  const message = typeof payload.error === 'string'
    ? payload.error
    : 'Die Aktion konnte nicht ausgeführt werden. Bitte versuchen Sie es erneut.';
  if (payload.company_deleted === true) throw new IncompleteDeletionError(message);
  throw new Error(message);
}
