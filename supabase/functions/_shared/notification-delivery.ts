/**
 * The Deno half of the notification job: load the candidates, decide with
 * notification-core.ts, claim, send, settle.
 *
 * The decision itself is not here — it is in notification-core.ts, which
 * imports nothing from Deno, npm: or jsr: and is unit-tested in Node. This file
 * is the I/O around it, the way activation-code-delivery.ts is the I/O around
 * activation-code-mail.ts.
 *
 * ─── The order of the three steps is the dedupe rule ─────────────────────────
 *
 *   1. claim   INSERT … ON CONFLICT DO NOTHING. NULL means somebody already
 *              holds this occurrence — the previous run, or a second run
 *              started while this one was walking its plan.
 *   2. send
 *   3. settle  record the outcome on the row claimed in step 1.
 *
 * The claim comes **before** the send on purpose. If the worker dies in
 * between, the notification is lost and never repeated. The other order would
 * make a crash between send and record mail the same customer again the next
 * night, and a nightly duplicate is the worse failure — it is the failure that
 * makes people switch a feature off for good. A lost one is visible in
 * `notification_deliveries` as `mail_sent IS NULL`.
 *
 * ─── Who receives it ─────────────────────────────────────────────────────────
 *
 * `selectNotificationRecipients` in notification-mail.ts, which is
 * `selectActivationCodeRecipients`' company branch: the company's active admin
 * profiles that are not platform staff, with a confirmed, undeleted, unbanned
 * GoTrue account, and nobody when there are none. A company with no such
 * address is claimed and settled with `mail_sent = false` and zero recipients,
 * so the job does not come back to it every night for an address that does not
 * exist.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendMail } from './mail.ts';
import { loadMailDeliverySettings } from './mail-template.ts';
import { logFailure } from './otp-core.ts';
import type { CompanyAdminCandidate } from './activation-code-mail.ts';
import {
  TUEV_SOON_DAYS,
  selectNotifications,
  type NotificationCompany,
  type PlannedNotification,
} from './notification-core.ts';
import { buildNotificationMail, selectNotificationRecipients } from './notification-mail.ts';

const FN = 'notify-expiries';
const LOG_CONTEXT = { purpose: 'notifications' };

/** How many companies one RPC call brings back. The RPC caps it at 500. */
const PAGE_SIZE = 100;

/** A stop, not a limit: a run that walks past this many pages is a bug, not a big installation. */
const MAX_PAGES = 200;

export type NotificationRunMode = 'dry_run' | 'send';

/** One line of the run's report. Carries no address: the count is the report. */
export interface NotificationRunItem {
  company_id: string;
  notification_type: string;
  target_id: string;
  period_key: string;
  due_day: string;
  days_left: number;
  recipient_count: number;
  outcome: 'planned' | 'sent' | 'no_recipients' | 'already_claimed' | 'send_failed';
}

export interface NotificationRunReport {
  mode: NotificationRunMode;
  companies_scanned: number;
  planned: number;
  sent: number;
  no_recipients: number;
  already_claimed: number;
  send_failed: number;
  /** Companies whose recipients could not be looked up; nothing was claimed for them. */
  lookup_failed: number;
  items: NotificationRunItem[];
}

/**
 * Walk every candidate company and either report or send.
 *
 * A dry run reads the same rows, makes the same decision and builds the same
 * mails — so a failure to render is found by the dry run — and then claims
 * nothing, sends nothing and writes nothing.
 */
export async function runNotificationJob(
  admin: SupabaseClient,
  mode: NotificationRunMode,
  now: Date = new Date(),
): Promise<NotificationRunReport> {
  const report: NotificationRunReport = {
    mode,
    companies_scanned: 0,
    planned: 0,
    sent: 0,
    no_recipients: 0,
    already_claimed: 0,
    send_failed: 0,
    lookup_failed: 0,
    items: [],
  };

  const appUrl = Deno.env.get('APP_URL');
  if (!appUrl) throw new Error('environment variable APP_URL is not set');

  // The From display name of plan 3.10's `mail.sender`. Read once per run: it
  // is the same for every mail, and a failed read keeps SMTP_SENDER_NAME.
  const settings = await loadMailDeliverySettings(
    { rpc: (fn: string, args: Record<string, unknown>) => admin.rpc(fn, args) },
    null,
    (err) => logFailure(FN, 'mail_settings', LOG_CONTEXT, err),
  );

  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const companies = await loadCandidates(admin, after);
    if (companies.length === 0) break;
    report.companies_scanned += companies.length;
    after = companies[companies.length - 1].company_id;

    for (const company of companies) {
      const planned = selectNotifications(company, now);
      if (planned.length === 0) continue;
      report.planned += planned.length;

      // Loaded once per company that has something due, and only then: it costs
      // one getUserById per admin profile. `null` is a failed lookup, which is
      // not the same as "this company has no admins": nothing is claimed, so
      // the next run tries again. An empty array is the real answer and is
      // claimed and settled, so the job does not come back every night for an
      // address that does not exist.
      const recipients = await loadRecipients(admin, company.company_id, now);
      if (recipients === null) {
        report.lookup_failed += 1;
        report.planned -= planned.length;
        continue;
      }

      for (const item of planned) {
        await deliverOne(admin, mode, item, recipients, appUrl, settings.senderName, report);
      }
    }

    if (companies.length < PAGE_SIZE) break;
  }

  return report;
}

async function deliverOne(
  admin: SupabaseClient,
  mode: NotificationRunMode,
  item: PlannedNotification,
  recipients: readonly string[],
  appUrl: string,
  fromName: string | null | undefined,
  report: NotificationRunReport,
): Promise<void> {
  const line = (outcome: NotificationRunItem['outcome'], recipientCount: number) => {
    report.items.push({
      company_id: item.companyId,
      notification_type: item.type,
      target_id: item.targetId,
      period_key: item.periodKey,
      due_day: item.dueDay,
      days_left: item.daysLeft,
      recipient_count: recipientCount,
      outcome,
    });
  };

  // Built before anything is claimed, in both modes, so a mail that cannot be
  // rendered is a dry-run failure and never a half-finished delivery.
  const mail = buildNotificationMail(item, appUrl);

  if (mode === 'dry_run') {
    line('planned', recipients.length);
    return;
  }

  const claimId = await claim(admin, item);
  if (!claimId) {
    report.already_claimed += 1;
    line('already_claimed', recipients.length);
    return;
  }

  if (recipients.length === 0) {
    report.no_recipients += 1;
    await settle(admin, claimId, false, 0);
    line('no_recipients', 0);
    return;
  }

  const sends = await Promise.allSettled(
    recipients.map((to) => sendMail({ to, ...mail, fromName })),
  );
  let failures = 0;
  for (const send of sends) {
    if (send.status === 'rejected') {
      failures += 1;
      logFailure(FN, 'send_mail', { ...LOG_CONTEXT, notification_type: item.type }, send.reason);
    }
  }

  const delivered = recipients.length - failures;
  await settle(admin, claimId, failures === 0, delivered);
  if (failures === 0) {
    report.sent += 1;
    line('sent', delivered);
  } else {
    report.send_failed += 1;
    line('send_failed', delivered);
  }
}

async function loadCandidates(
  admin: SupabaseClient,
  after: string | null,
): Promise<NotificationCompany[]> {
  const { data, error } = await admin.rpc('notification_candidates', {
    p_tuev_soon_days: TUEV_SOON_DAYS,
    p_limit: PAGE_SIZE,
    p_after: after,
  });
  if (error) throw new Error(`notification_candidates failed (${error.code ?? 'unknown'})`);
  return (data ?? []) as NotificationCompany[];
}

async function claim(admin: SupabaseClient, item: PlannedNotification): Promise<string | null> {
  const { data, error } = await admin.rpc('notification_delivery_claim', {
    p_company_id: item.companyId,
    p_notification_type: item.type,
    p_target_id: item.targetId,
    p_period_key: item.periodKey,
  });
  if (error) throw new Error(`notification_delivery_claim failed (${error.code ?? 'unknown'})`);
  return typeof data === 'string' ? data : null;
}

async function settle(
  admin: SupabaseClient,
  id: string,
  mailSent: boolean,
  recipientCount: number,
): Promise<void> {
  const { error } = await admin.rpc('notification_delivery_settle', {
    p_id: id,
    p_mail_sent: mailSent,
    p_recipient_count: recipientCount,
  });
  // A settle that fails leaves `mail_sent IS NULL` on a row that was claimed.
  // The notification is not re-sent, which is the whole point of claiming
  // first, so this is logged and never thrown.
  if (error) logFailure(FN, 'settle', LOG_CONTEXT, new Error(error.code ?? 'unknown'));
}

/**
 * The company's admins who can receive mail, or `null` when the lookup failed.
 *
 * The same two steps as activation-code-delivery.ts: the active admin profiles
 * from PostgREST, then one `getUserById` each, because whether an account is
 * confirmed, banned or deleted is GoTrue's and PostgREST does not serve it. A
 * company has one or two admins.
 *
 * The two empty answers are told apart deliberately. `[]` means the company has
 * no admin who could receive mail — a real answer, so the notification is
 * claimed and settled as unsent and never looked at again. `null` means we do
 * not know, so nothing is claimed and the next run asks again; a transient
 * GoTrue failure must not silently burn a TÜV warning.
 */
export async function loadRecipients(
  admin: SupabaseClient,
  companyId: string,
  now: Date,
): Promise<string[] | null> {
  try {
    const { data, error } = await admin
      .from('user_profiles')
      .select('user_id, role, status, is_super_admin')
      .eq('company_id', companyId)
      .eq('role', 'admin')
      .eq('status', 'active');
    if (error) throw new Error(`admin lookup failed (${error.code ?? 'unknown'})`);

    const candidates = await Promise.all((data ?? []).map(
      async (profile: Record<string, unknown>): Promise<CompanyAdminCandidate | null> => {
        const { data: found, error: userError } =
          await admin.auth.admin.getUserById(profile.user_id as string);
        if (userError || !found.user) return null;
        return {
          email: found.user.email ?? null,
          role: (profile.role as string) ?? null,
          status: (profile.status as string) ?? null,
          isSuperAdmin: (profile.is_super_admin as boolean) ?? null,
          emailConfirmedAt: found.user.email_confirmed_at ?? null,
          bannedUntil: found.user.banned_until ?? null,
          deletedAt: found.user.deleted_at ?? null,
        };
      },
    ));

    return selectNotificationRecipients({
      companyId,
      companyAdmins: candidates.filter((c): c is CompanyAdminCandidate => c !== null),
      now,
    });
  } catch (err) {
    logFailure(FN, 'recipients', { ...LOG_CONTEXT, company_id: companyId }, err);
    return null;
  }
}
