/**
 * The Deno half of the scheduled Abrechnung job: load the schedules, decide with
 * abrechnung-schedule-core.ts, claim, send, settle.
 *
 * The decision is not here. It is in abrechnung-schedule-core.ts, which imports
 * nothing from Deno, npm: or jsr: and is unit-tested in Node, the way
 * notification-delivery.ts is the I/O around notification-core.ts. The two jobs
 * share one function (`notify-expiries`) because that function already is the
 * one door a cron line holding the service key may use; a second function would
 * cost a line in `PUBLIC_FUNCTIONS`/`FUNCTION_ENV` and one in the compose file.
 *
 * ─── The order of the three steps is the dedupe rule ─────────────────────────
 *
 *   1. claim   INSERT ... ON CONFLICT DO NOTHING. NULL means somebody holds this
 *              occurrence: an earlier run, or a second one started meanwhile.
 *   2. send
 *   3. settle  record the outcome on the row claimed in step 1.
 *
 * Claim BEFORE send, never retry: a crash between the two loses a mail (visible
 * as `mail_sent IS NULL`) and never repeats one, which is the worse failure.
 * The key is the Monday of the week the mail is ABOUT, so a repeated or
 * overlapping run, or a cron line installed twice, finds it already held.
 *
 * ─── Addresses ───────────────────────────────────────────────────────────────
 *
 * A driver's address comes from `public.drivers` inside
 * `abrechnung_week_figures`, scoped to the company; the managers' addresses are
 * `selectNotificationRecipients`' company branch, which is
 * `selectActivationCodeRecipients`' rule. Nothing here reads an address from a
 * request, and the report carries counts, never an address or a name.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendMail } from './mail.ts';
import { loadMailDeliverySettings } from './mail-template.ts';
import { logFailure } from './otp-core.ts';
import { loadRecipients } from './notification-delivery.ts';
import { renderAbrechnungMail, renderAbrechnungSummaryMail, renderReminderMail } from './abrechnung-mail.ts';
import {
  MAX_REMINDERS_PER_RUN,
  planReminders,
  type ReminderCounts,
  type ReminderFacts,
  type ReminderTarget,
} from './abrechnung-reminder-core.ts';
import {
  figuresOfRow,
  planCompany,
  planDriverMails,
  planReminder,
  weekPeriod,
  type DriverMailTarget,
  type ScheduleCompany,
  type ReminderPlan,
  type ScheduledPlan,
  type WeekFigureRow,
} from './abrechnung-schedule-core.ts';

const FN = 'notify-expiries';
const LOG_CONTEXT = { purpose: 'abrechnung_schedule' };

/** Companies per RPC call; the RPC caps it at 500. */
const PAGE_SIZE = 100;
/** A stop, not a limit: a run that walks past this many pages is a bug. */
const MAX_PAGES = 200;
/** Driver mails in flight at once: SMTP is 10 s a mail, and a fleet is dozens. */
const SEND_CONCURRENCY = 5;

export type AbrechnungRunMode = 'dry_run' | 'send';

/** One company's line of the report. No name and no address appears in it. */
export interface AbrechnungRunItem {
  company_id: string;
  week_monday: string;
  driver_rows: number;
  driver_mails: { planned: number; sent: number; failed: number; already_claimed: number;
                  no_address: number; ambiguous: number };
  manager_summary: 'off' | 'planned' | 'sent' | 'send_failed' | 'already_claimed'
    | 'no_recipients' | 'no_rows' | 'lookup_failed';
}

/** One company's line of the reminder report. Counts only: no name and no address. */
export interface ReminderRunItem extends ReminderCounts {
  company_id: string;
  week_monday: string;
  sent: number;
  failed: number;
}

export interface AbrechnungRunReport {
  mode: AbrechnungRunMode;
  companies_scanned: number;
  companies_due: number;
  /** Companies whose week's figures could not be read; nothing was claimed for them. */
  figures_failed: number;
  driver_mails_sent: number;
  driver_mails_failed: number;
  manager_summaries_sent: number;
  manager_summaries_failed: number;
  items: AbrechnungRunItem[];
  /** Companies with a reminder due now. */
  reminders_due: number;
  reminder_mails_sent: number;
  reminder_mails_failed: number;
  reminder_items: ReminderRunItem[];
}

export async function runAbrechnungJob(
  admin: SupabaseClient,
  mode: AbrechnungRunMode,
  now: Date = new Date(),
): Promise<AbrechnungRunReport> {
  const report: AbrechnungRunReport = {
    mode, companies_scanned: 0, companies_due: 0, figures_failed: 0,
    driver_mails_sent: 0, driver_mails_failed: 0,
    manager_summaries_sent: 0, manager_summaries_failed: 0, items: [],
    reminders_due: 0, reminder_mails_sent: 0, reminder_mails_failed: 0, reminder_items: [],
  };

  const appUrl = Deno.env.get('APP_URL');
  if (!appUrl) throw new Error('environment variable APP_URL is not set');

  const settings = await loadMailDeliverySettings(
    { rpc: (fn: string, args: Record<string, unknown>) => admin.rpc(fn, args) },
    null,
    (err) => logFailure(FN, 'mail_settings', LOG_CONTEXT, err),
  );
  const ctx: Context = {
    admin, mode, now, appUrl, fromName: settings.senderName, report,
    remindersLeft: MAX_REMINDERS_PER_RUN,
  };

  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const companies = await loadCandidates(admin, after);
    if (companies.length === 0) break;
    report.companies_scanned += companies.length;
    after = companies[companies.length - 1].company_id;

    for (const company of companies) {
      await runReminderFor(ctx, company);
      const plan = planCompany(company, now);
      if (plan && (plan.driverMail || plan.managerSummary)) {
        report.companies_due += 1;
        // One company's failure is not the run's: the others still get their mail.
        try {
          await runCompany(ctx, plan);
        } catch (err) {
          report.figures_failed += 1;
          logFailure(FN, 'company', { ...LOG_CONTEXT, company_id: plan.companyId }, err);
        }
      }
    }
    if (companies.length < PAGE_SIZE) break;
  }
  return report;
}

interface Context {
  admin: SupabaseClient;
  mode: AbrechnungRunMode;
  now: Date;
  appUrl: string;
  fromName: string | null | undefined;
  report: AbrechnungRunReport;
  /** Reminder mails this run may still take, across all companies. */
  remindersLeft: number;
}

/** One company's reminder pass; its failure is not the run's. */
async function runReminderFor(ctx: Context, company: ScheduleCompany): Promise<void> {
  const plan = planReminder(company, ctx.now);
  if (!plan) return;
  ctx.report.reminders_due += 1;
  try {
    await runReminders(ctx, plan);
  } catch (err) {
    ctx.report.figures_failed += 1;
    logFailure(FN, 'reminder', { ...LOG_CONTEXT, company_id: plan.companyId }, err);
  }
}

async function runReminders(ctx: Context, plan: ReminderPlan): Promise<void> {
  const facts = await loadReminderFacts(ctx.admin, plan);
  if (facts === null) {
    ctx.report.figures_failed += 1;
    return;
  }
  const decided = planReminders(facts, plan.coveredDriverIds, ctx.remindersLeft);
  ctx.remindersLeft -= decided.sendable.length;

  const period = weekPeriod(plan.weekMonday);
  const item: ReminderRunItem = {
    company_id: plan.companyId, week_monday: plan.weekMonday, sent: 0, failed: 0, ...decided.counts,
  };
  ctx.report.reminder_items.push(item);

  // Rendered for every target in both modes, as the driver mails are, so a
  // mail that cannot be built is a dry-run failure and never a half delivery.
  const mails = decided.sendable.map((target) => ({
    target,
    mail: renderReminderMail({
      driverName: target.driverName,
      companyName: plan.companyName,
      periodLabel: period.label,
      periodRange: period.range,
      sendTime: plan.sendTime,
      appUrl: ctx.appUrl,
    }),
  }));
  if (ctx.mode === 'dry_run') return;

  for (let i = 0; i < mails.length; i += SEND_CONCURRENCY) {
    await Promise.all(mails.slice(i, i + SEND_CONCURRENCY).map(async ({ target, mail }) => {
      const outcome = await deliverReminder(ctx, plan, target, mail);
      if (outcome === 'sent') { item.sent += 1; ctx.report.reminder_mails_sent += 1; }
      else if (outcome === 'failed') { item.failed += 1; ctx.report.reminder_mails_failed += 1; }
      else item.already_covered += 1;
    }));
  }
}

async function deliverReminder(
  ctx: Context,
  plan: ReminderPlan,
  target: ReminderTarget,
  mail: { subject: string; html: string; text: string },
): Promise<'sent' | 'failed' | 'already_covered'> {
  // NULL is the database saying no: somebody holds this reminder, or this
  // week's driver mail is already claimed. Either way nothing is sent.
  const claimId = await claimKind(ctx.admin, plan.companyId, plan.weekMonday, 'driver_reminder', target.driverId);
  if (!claimId) return 'already_covered';
  try {
    await sendMail({ to: target.email, ...mail, fromName: ctx.fromName });
    await settle(ctx.admin, claimId, true, 1);
    return 'sent';
  } catch (err) {
    logFailure(FN, 'send_reminder', LOG_CONTEXT, err);
    await settle(ctx.admin, claimId, false, 0);
    return 'failed';
  }
}

async function loadReminderFacts(admin: SupabaseClient, plan: ReminderPlan): Promise<ReminderFacts[] | null> {
  const { data, error } = await admin.rpc('abrechnung_reminder_facts', {
    p_company_id: plan.companyId,
    p_week_monday: plan.weekMonday,
  });
  if (error) {
    logFailure(FN, 'reminder_facts', { ...LOG_CONTEXT, company_id: plan.companyId },
      new Error(error.code ?? 'unknown'));
    return null;
  }
  return (data ?? []) as ReminderFacts[];
}

async function runCompany(ctx: Context, plan: ScheduledPlan): Promise<void> {
  const rows = await loadFigures(ctx.admin, plan);
  if (rows === null) {
    ctx.report.figures_failed += 1;
    return;
  }
  const period = weekPeriod(plan.weekMonday);
  const item: AbrechnungRunItem = {
    company_id: plan.companyId,
    week_monday: plan.weekMonday,
    driver_rows: rows.length,
    driver_mails: { planned: 0, sent: 0, failed: 0, already_claimed: 0, no_address: 0, ambiguous: 0 },
    manager_summary: 'off',
  };

  if (plan.driverMail) await runDriverMails(ctx, plan, rows, period, item);
  if (plan.managerSummary) await runManagerSummary(ctx, plan, rows, period, item);
  ctx.report.items.push(item);
}

async function runDriverMails(
  ctx: Context,
  plan: ScheduledPlan,
  rows: WeekFigureRow[],
  period: { label: string; range: string },
  item: AbrechnungRunItem,
): Promise<void> {
  const decided = planDriverMails(rows, plan.claimedDriverIds);
  const counts = item.driver_mails;
  counts.already_claimed = decided.alreadyClaimed.length;
  counts.no_address = decided.noAddress.length;
  counts.ambiguous = decided.ambiguous.length;
  counts.planned = decided.sendable.length;

  // Rendered for every target in both modes, so a mail that cannot be built is
  // a dry-run failure and never a half-finished delivery.
  const mails = decided.sendable.map((target) => ({
    target,
    mail: renderAbrechnungMail({
      driverName: target.driverName,
      companyName: plan.companyName,
      periodLabel: period.label,
      periodRange: period.range,
      figures: target.figures,
      appUrl: ctx.appUrl,
      imageAttached: false,
    }),
  }));
  if (ctx.mode === 'dry_run') return;

  for (let i = 0; i < mails.length; i += SEND_CONCURRENCY) {
    await Promise.all(mails.slice(i, i + SEND_CONCURRENCY).map(async ({ target, mail }) => {
      const outcome = await deliverToDriver(ctx, plan, target, mail);
      if (outcome === 'sent') { counts.sent += 1; ctx.report.driver_mails_sent += 1; }
      else if (outcome === 'failed') { counts.failed += 1; ctx.report.driver_mails_failed += 1; }
      else counts.already_claimed += 1;
    }));
  }
}

async function deliverToDriver(
  ctx: Context,
  plan: ScheduledPlan,
  target: DriverMailTarget,
  mail: { subject: string; html: string; text: string },
): Promise<'sent' | 'failed' | 'already_claimed'> {
  const claimId = await claim(ctx.admin, plan, 'driver_abrechnung', target.driverId);
  if (!claimId) return 'already_claimed';
  try {
    await sendMail({ to: target.email, ...mail, fromName: ctx.fromName });
    await settle(ctx.admin, claimId, true, 1);
    return 'sent';
  } catch (err) {
    logFailure(FN, 'send_driver_mail', LOG_CONTEXT, err);
    await settle(ctx.admin, claimId, false, 0);
    return 'failed';
  }
}

async function runManagerSummary(
  ctx: Context,
  plan: ScheduledPlan,
  rows: WeekFigureRow[],
  period: { label: string; range: string },
  item: AbrechnungRunItem,
): Promise<void> {
  // A week with no bookings at all has nothing to summarise. Nothing is claimed,
  // so a booking entered later inside the grace window still gets its summary.
  if (rows.length === 0) {
    item.manager_summary = 'no_rows';
    return;
  }
  const recipients = await loadRecipients(ctx.admin, plan.companyId, ctx.now, 'manager_summary');
  if (recipients === null) {
    item.manager_summary = 'lookup_failed';
    return;
  }

  const mail = renderAbrechnungSummaryMail({
    companyName: plan.companyName,
    periodLabel: period.label,
    periodRange: period.range,
    rows: rows.map((row) => ({ driverName: row.driver_name, figures: figuresOfRow(row) })),
    appUrl: ctx.appUrl,
  });
  if (ctx.mode === 'dry_run') {
    item.manager_summary = 'planned';
    return;
  }

  const claimId = await claim(ctx.admin, plan, 'manager_summary', plan.companyId);
  if (!claimId) {
    item.manager_summary = 'already_claimed';
    return;
  }
  if (recipients.length === 0) {
    // Claimed and settled as unsent, so the job does not come back every few
    // minutes for an administrator address that does not exist.
    await settle(ctx.admin, claimId, false, 0);
    item.manager_summary = 'no_recipients';
    return;
  }

  const sends = await Promise.allSettled(
    recipients.map((to) => sendMail({ to, ...mail, fromName: ctx.fromName })),
  );
  const failures = sends.filter((s) => s.status === 'rejected');
  for (const f of failures) logFailure(FN, 'send_manager_summary', LOG_CONTEXT, (f as PromiseRejectedResult).reason);
  await settle(ctx.admin, claimId, failures.length === 0, recipients.length - failures.length);
  if (failures.length === 0) {
    item.manager_summary = 'sent';
    ctx.report.manager_summaries_sent += 1;
  } else {
    item.manager_summary = 'send_failed';
    ctx.report.manager_summaries_failed += 1;
  }
}

async function loadCandidates(admin: SupabaseClient, after: string | null): Promise<ScheduleCompany[]> {
  const { data, error } = await admin.rpc('abrechnung_schedule_candidates', {
    p_limit: PAGE_SIZE,
    p_after: after,
  });
  if (error) throw new Error(`abrechnung_schedule_candidates failed (${error.code ?? 'unknown'})`);
  return (data ?? []) as ScheduleCompany[];
}

/** The week's rows, or `null` when they could not be read (which is not "no rows"). */
async function loadFigures(admin: SupabaseClient, plan: ScheduledPlan): Promise<WeekFigureRow[] | null> {
  const { data, error } = await admin.rpc('abrechnung_week_figures', {
    p_company_id: plan.companyId,
    p_week_monday: plan.weekMonday,
  });
  if (error) {
    logFailure(FN, 'week_figures', { ...LOG_CONTEXT, company_id: plan.companyId },
      new Error(error.code ?? 'unknown'));
    return null;
  }
  return (data ?? []) as WeekFigureRow[];
}

async function claim(
  admin: SupabaseClient,
  plan: ScheduledPlan,
  kind: 'driver_abrechnung' | 'manager_summary',
  targetId: string,
): Promise<string | null> {
  return claimKind(admin, plan.companyId, plan.weekMonday, kind, targetId);
}

async function claimKind(
  admin: SupabaseClient,
  companyId: string,
  weekMonday: string,
  kind: 'driver_abrechnung' | 'manager_summary' | 'driver_reminder',
  targetId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc('abrechnung_delivery_claim', {
    p_company_id: companyId,
    p_kind: kind,
    p_target_id: targetId,
    p_period_key: weekMonday,
  });
  if (error) throw new Error(`abrechnung_delivery_claim failed (${error.code ?? 'unknown'})`);
  return typeof data === 'string' ? data : null;
}

async function settle(
  admin: SupabaseClient,
  id: string,
  mailSent: boolean,
  recipientCount: number,
): Promise<void> {
  const { error } = await admin.rpc('abrechnung_delivery_settle', {
    p_id: id,
    p_mail_sent: mailSent,
    p_recipient_count: recipientCount,
  });
  // A failed settle leaves `mail_sent IS NULL` on a claimed row. The mail is not
  // re-sent, which is the point of claiming first, so this is logged only.
  if (error) logFailure(FN, 'settle', LOG_CONTEXT, new Error(error.code ?? 'unknown'));
}
