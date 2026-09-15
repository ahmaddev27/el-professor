/**
 * Mails an activation code a platform admin has just generated. The Deno half
 * of activation-code-mail.ts: it loads who receives the code and sends it.
 *
 * It never throws. The code row already exists and the platform admin still
 * reads the code from the screen, so a failed lookup or send only turns
 * mail_sent off. No log line carries the code or an address.
 *
 * Who is a company admin that can receive it needs GoTrue's account state
 * (confirmed, banned, deleted), which PostgREST does not serve, so each admin
 * profile is followed by one getUserById. A company has one or two admins.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  buildActivationCodeMail,
  selectActivationCodeRecipients,
  type CompanyAdminCandidate,
} from './activation-code-mail.ts';
import { sendMail } from './mail.ts';
import { logFailure } from './otp-core.ts';

export interface GeneratedActivationCode {
  /** Never log it. */
  code: string;
  companyId: string | null;
  targetEmail: string | null;
  durationType: string;
  customDays: number | null;
  customExpiresAt: string | null;
  expiresAt: Date;
}

export interface ActivationCodeDelivery {
  /** True when every recipient's send went through; false when there was nobody to send to. */
  mailSent: boolean;
  /** The addresses the code was sent, or was to be sent, to. */
  recipientCount: number;
}

const FN = 'generate-activation-code';
const LOG_CONTEXT = { purpose: 'activation_code' };

export async function mailActivationCode(
  admin: SupabaseClient,
  generated: GeneratedActivationCode,
): Promise<ActivationCodeDelivery> {
  let recipients: string[] = [];
  try {
    const hasTarget = Boolean(generated.targetEmail?.trim());
    const [companyName, companyAdmins] = await Promise.all([
      generated.companyId ? loadCompanyName(admin, generated.companyId) : Promise.resolve(null),
      generated.companyId && !hasTarget ? loadCompanyAdmins(admin, generated.companyId) : Promise.resolve([]),
    ]);

    recipients = selectActivationCodeRecipients({
      targetEmail: generated.targetEmail,
      companyId: generated.companyId,
      companyAdmins,
      now: new Date(),
    }).recipients;
    if (recipients.length === 0) return { mailSent: false, recipientCount: 0 };

    const appUrl = Deno.env.get('APP_URL');
    if (!appUrl) throw new Error('environment variable APP_URL is not set');
    const mail = buildActivationCodeMail({
      appUrl,
      code: generated.code,
      durationType: generated.durationType,
      customDays: generated.customDays,
      customExpiresAt: generated.customExpiresAt,
      expiresAt: generated.expiresAt,
      companyName,
    });

    const sends = await Promise.allSettled(recipients.map((to) => sendMail({ to, ...mail })));
    let failures = 0;
    for (const send of sends) {
      if (send.status === 'rejected') {
        failures++;
        logFailure(FN, 'send_mail', LOG_CONTEXT, send.reason);
      }
    }
    return { mailSent: failures === 0, recipientCount: recipients.length };
  } catch (err) {
    logFailure(FN, 'mail_activation_code', LOG_CONTEXT, err);
    return { mailSent: false, recipientCount: recipients.length };
  }
}

async function loadCompanyName(admin: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await admin.from('companies').select('name').eq('id', companyId).maybeSingle();
  if (error) throw new Error(`company lookup failed (${error.code ?? 'unknown'})`);
  return typeof data?.name === 'string' ? data.name : null;
}

async function loadCompanyAdmins(admin: SupabaseClient, companyId: string): Promise<CompanyAdminCandidate[]> {
  const { data, error } = await admin
    .from('user_profiles')
    .select('user_id, role, status, is_super_admin')
    .eq('company_id', companyId)
    .eq('role', 'admin')
    .eq('status', 'active');
  if (error) throw new Error(`admin lookup failed (${error.code ?? 'unknown'})`);

  const candidates = await Promise.all((data ?? []).map(async (profile): Promise<CompanyAdminCandidate | null> => {
    const { data: found, error: userError } = await admin.auth.admin.getUserById(profile.user_id);
    // An account GoTrue cannot return, a deleted one included, receives nothing.
    if (userError || !found.user) return null;
    return {
      email: found.user.email ?? null,
      role: profile.role ?? null,
      status: profile.status ?? null,
      isSuperAdmin: profile.is_super_admin ?? null,
      emailConfirmedAt: found.user.email_confirmed_at ?? null,
      bannedUntil: found.user.banned_until ?? null,
      deletedAt: found.user.deleted_at ?? null,
    };
  }));
  return candidates.filter((candidate): candidate is CompanyAdminCandidate => candidate !== null);
}
