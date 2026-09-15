/**
 * The browser side of the company-approval edge function, which only platform
 * admins may call.
 *
 * The function never returns the trial code. Its answers say only whether a
 * code was created and whether the approval mail went out, so the dashboard
 * can offer a resend when it did not.
 */
import { supabase } from './supabase';

export type ApprovalMailError = 'no_recipient' | 'send_failed';

export interface ApproveCompanyResult {
  alreadyApproved: boolean;
  codeCreated: boolean;
  mailSent: boolean;
  mailError: ApprovalMailError | null;
}

export interface ResendTrialCodeResult {
  mailSent: boolean;
  mailError: ApprovalMailError | null;
}

/**
 * Throws an Error whose message is the function's German text for the user, or
 * an empty message when there is none, so callers fall back to their own.
 */
async function callCompanyApproval(
  action: 'approve' | 'resend_trial_code',
  companyId: string,
): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/company-approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      Apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, company_id: companyId }),
  });

  const body: unknown = await response.json().catch(() => null);
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok || value.success !== true) {
    throw new Error(typeof value.error === 'string' ? value.error : '');
  }
  return value;
}

function mailErrorOf(value: Record<string, unknown>): ApprovalMailError | null {
  return value.mail_error === 'no_recipient' || value.mail_error === 'send_failed' ? value.mail_error : null;
}

export async function approveCompany(companyId: string): Promise<ApproveCompanyResult> {
  const value = await callCompanyApproval('approve', companyId);
  return {
    alreadyApproved: value.already_approved === true,
    codeCreated: value.code_created === true,
    mailSent: value.mail_sent === true,
    mailError: mailErrorOf(value),
  };
}

export async function resendTrialCode(companyId: string): Promise<ResendTrialCodeResult> {
  const value = await callCompanyApproval('resend_trial_code', companyId);
  return { mailSent: value.mail_sent === true, mailError: mailErrorOf(value) };
}
