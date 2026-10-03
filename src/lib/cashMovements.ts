import { supabase } from './supabase';
import { formatCentsForNumeric } from '../utils/money';
import { cashEntryRefusal, type CashEntryDirection, type CashEntryRefusal } from '../utils/cashEntry';

export interface RecordCashMovementRequest {
  /** One per attempt, kept until the database answers, so a retry is the same booking. */
  requestId: string;
  direction: CashEntryDirection;
  amountCents: number;
  /** `YYYY-MM-DD` */
  date: string;
  description: string;
}

export type RecordCashMovementResult = { ok: true } | { ok: false; refusal: CashEntryRefusal };

/**
 * Books a manual till entry. The only way a browser writes cash_movements:
 * the table has no write policy, and this SECURITY DEFINER function carries
 * the company, role and platform-session gates.
 */
export async function recordCashMovement(request: RecordCashMovementRequest): Promise<RecordCashMovementResult> {
  const { data, error } = await supabase.rpc('record_cash_movement', {
    p_request_id: request.requestId,
    p_direction: request.direction,
    p_amount: formatCentsForNumeric(request.amountCents),
    p_movement_date: request.date,
    p_description: request.description,
  });
  if (error) return { ok: false, refusal: cashEntryRefusal(error) };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, refusal: 'unexpected' };
  return { ok: true };
}
