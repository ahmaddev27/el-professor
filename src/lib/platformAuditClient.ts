/**
 * The audit log, called (plan 3.6c).
 *
 * One `supabase.rpc` — a POST, because `platform_audit_list` records its own
 * read — handed to the pure parser in `platformAuditLog.ts`.
 */
import { supabase } from './supabase';
import { auditRpcArgs, parseAuditAnswer, type AuditQuery, type AuditResult } from './platformAuditLog';

export async function fetchAuditPage(query: AuditQuery): Promise<AuditResult> {
  const { data, error } = await supabase.rpc('platform_audit_list', auditRpcArgs(query));
  if (error) throw new Error(error.message);
  return parseAuditAnswer(data);
}
