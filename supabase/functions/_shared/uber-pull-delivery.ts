/**
 * The Deno half of the scheduled Uber pull: load the schedules, decide with
 * uber-pull-core.ts, claim, ask Reidey, write through the database's system
 * writer, settle.
 *
 * The decision is not here. It is in uber-pull-core.ts, which imports nothing
 * from Deno, npm: or jsr: and is unit-tested in Node, the way
 * abrechnung-delivery.ts is the I/O around abrechnung-schedule-core.ts. The job
 * shares `notify-expiries` with the others because that function already is the
 * one door a cron line holding the service key may use.
 *
 * ─── The order of the steps is the dedupe rule ───────────────────────────────
 *
 *   1. claim    INSERT ... ON CONFLICT DO NOTHING. NULL means somebody holds this
 *               (company, operating day, pass): an earlier run, or one started
 *               meanwhile.
 *   2. act      open the sealed token, ask Reidey once, check, write.
 *   3. settle   the writer settles `imported` in the transaction that wrote the
 *               rows; every other outcome is recorded with uber_pull_settle.
 *
 * Claim BEFORE acting, never retry: a crash between the two loses one pull
 * (visible as a row with no outcome) and never repeats one.
 *
 * ─── The token ───────────────────────────────────────────────────────────────
 *
 * Opened here exactly as uber-earnings-pull opens it: `partner_sealed_token` is
 * service_role's alone, the opened value goes to the one validated destination
 * and nowhere else, and it is never logged, never returned and never part of an
 * error. Failures here log the step and the company, not the thrown value.
 *
 * ─── The dry run ─────────────────────────────────────────────────────────────
 *
 * Reads the schedules, decides what is due and what is already claimed, and
 * checks the connection (is a sealed token stored, how many drivers are linked).
 * It does NOT call Reidey: a ten-minute tick must not spend a call against a
 * company's Uber account to prove it could. It claims nothing and writes
 * nothing, and its report carries no name and no amount.
 *
 * ─── Never a partial day ─────────────────────────────────────────────────────
 *
 * One operating day is one Reidey call and one `income_import_uber_system` call,
 * which is one transaction. Any failure before it writes nothing; a refusal in
 * it rolls the whole day back. The same all-or-nothing the button has.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { logFailure } from './otp-core.ts';
import { PARTNER_ENDPOINT_VAR, partnerEndpoint } from './partner-endpoint.ts';
import { openPartnerToken } from './partner-token-seal.ts';
import { parseEarningsBody, type UberDriverEarnings, type UnmatchedEarner } from './uber-earnings-core.ts';
import {
  buildDayRows,
  driversWithRows,
  outcomeOfRefusal,
  planCompany,
  type UberPass,
  type UberPullCompany,
  type UberPullOutcome,
} from './uber-pull-core.ts';

const FN = 'notify-expiries';
const LOG_CONTEXT = { purpose: 'uber_pull' };
const PARTNER = 'reidey';
const CALL_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
/** A stop, not a limit: a run that walks past this many pages is a bug. */
const MAX_PAGES = 200;

export type UberPullRunMode = 'dry_run' | 'send';

/** One claim's line of the report. No name and no amount appears in it. */
export interface UberPullRunItem {
  company_id: string;
  day: string;
  pass: UberPass;
  /** An outcome, `would_pull` (dry run), `already_claimed` or `claim_failed`. */
  result: string;
  rows?: number;
  deleted?: number;
  drivers?: number;
  /** Dry run only: a sealed token is stored for the company. */
  connected?: boolean;
  /** Dry run only: confirmed driver links. */
  linked_drivers?: number;
}

export interface UberPullRunReport {
  mode: UberPullRunMode;
  companies_scanned: number;
  companies_due: number;
  claimed: number;
  imported: number;
  /** Of `imported`, the rechecks: a day pulled again with replace semantics. */
  replaced: number;
  already_claimed: number;
  failed: number;
  items: UberPullRunItem[];
}

interface Context {
  admin: SupabaseClient;
  mode: UberPullRunMode;
  endpointOrigin: string;
  sealKey: string;
  report: UberPullRunReport;
}

export async function runUberPullJob(
  admin: SupabaseClient,
  mode: UberPullRunMode,
  now: Date = new Date(),
): Promise<UberPullRunReport> {
  const report: UberPullRunReport = {
    mode, companies_scanned: 0, companies_due: 0, claimed: 0, imported: 0,
    replaced: 0, already_claimed: 0, failed: 0, items: [],
  };

  const endpoint = partnerEndpoint(Deno.env.get(PARTNER_ENDPOINT_VAR));
  const ctx: Context = {
    admin, mode, report,
    endpointOrigin: endpoint.ok ? endpoint.origin : '',
    sealKey: Deno.env.get('PARTNER_SEAL_KEY') ?? '',
  };

  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const companies = await loadCandidates(admin, after);
    if (companies.length === 0) break;
    report.companies_scanned += companies.length;
    after = companies[companies.length - 1].company_id;

    for (const company of companies) {
      const plan = planCompany(company, now);
      if (!plan) continue;
      report.companies_due += 1;
      // One company's failure is not the run's: the others still get their pull.
      try {
        await runCompany(ctx, plan.companyId, plan.tasks);
      } catch (err) {
        report.failed += 1;
        logFailure(FN, 'company', { ...LOG_CONTEXT, company_id: plan.companyId }, err);
      }
    }
    if (companies.length < PAGE_SIZE) break;
  }
  return report;
}

async function loadCandidates(admin: SupabaseClient, after: string | null): Promise<UberPullCompany[]> {
  const { data, error } = await admin.rpc('uber_pull_candidates', { p_limit: PAGE_SIZE, p_after: after });
  if (error) throw new Error('uber_pull_candidates failed');
  return (data ?? []) as UberPullCompany[];
}

async function runCompany(
  ctx: Context, companyId: string, tasks: ReadonlyArray<{ day: string; pass: UberPass }>,
): Promise<void> {
  if (ctx.mode === 'dry_run') {
    const connection = await readConnection(ctx.admin, companyId);
    for (const task of tasks) {
      ctx.report.items.push({
        company_id: companyId, day: task.day, pass: task.pass, result: 'would_pull',
        connected: connection.connected, linked_drivers: connection.linked,
      });
    }
    return;
  }

  // The token is opened once per company and only after the first claim, so a
  // company whose every task is already held never has its seal touched.
  let token: OpenedToken | null = null;
  for (const task of tasks) {
    const runId = await claim(ctx, companyId, task.day, task.pass);
    if (runId === 'held') {
      ctx.report.already_claimed += 1;
      ctx.report.items.push({ company_id: companyId, day: task.day, pass: task.pass, result: 'already_claimed' });
      continue;
    }
    if (runId === 'failed') {
      ctx.report.failed += 1;
      ctx.report.items.push({ company_id: companyId, day: task.day, pass: task.pass, result: 'claim_failed' });
      continue;
    }
    ctx.report.claimed += 1;
    token ??= await openToken(ctx, companyId);
    const item = await pullOneDay(ctx, companyId, runId, task.day, task.pass, token);
    if (item.result === 'imported') {
      ctx.report.imported += 1;
      if (task.pass === 'recheck') ctx.report.replaced += 1;
    } else {
      ctx.report.failed += SUCCESS_RESULTS.has(item.result) ? 0 : 1;
    }
    ctx.report.items.push(item);
  }
}

const SUCCESS_RESULTS: ReadonlySet<string> = new Set(['imported', 'nothing_to_import']);

async function readConnection(
  admin: SupabaseClient, companyId: string,
): Promise<{ connected: boolean; linked: number }> {
  const sealed = await admin.rpc('partner_sealed_token', { p_company_id: companyId, p_partner: PARTNER });
  const links = await loadLinks(admin, companyId);
  return { connected: !sealed.error && Boolean(sealed.data), linked: links ? links.size : 0 };
}

async function loadLinks(admin: SupabaseClient, companyId: string): Promise<Set<string> | null> {
  const { data, error } = await admin.from('partner_driver_links')
    .select('external_driver_id')
    .eq('company_id', companyId).eq('partner', PARTNER).eq('status', 'linked');
  if (error) return null;
  return new Set((data ?? []).map((r: { external_driver_id: string }) => r.external_driver_id));
}

async function claim(
  ctx: Context, companyId: string, day: string, pass: UberPass,
): Promise<string | 'held' | 'failed'> {
  const { data, error } = await ctx.admin.rpc('uber_pull_claim', {
    p_company_id: companyId, p_day: day, p_pass: pass,
  });
  if (error) {
    logFailure(FN, 'claim', { ...LOG_CONTEXT, company_id: companyId }, error);
    return 'failed';
  }
  return typeof data === 'string' ? data : 'held';
}

type OpenedToken = { value: string | null; problem?: UberPullOutcome };

/** Opens the sealed token. The value never leaves this module's call to fetch. */
async function openToken(ctx: Context, companyId: string): Promise<OpenedToken> {
  if (ctx.endpointOrigin === '' || ctx.sealKey === '') return { value: null, problem: 'failed' };
  const sealed = await ctx.admin.rpc('partner_sealed_token', { p_company_id: companyId, p_partner: PARTNER });
  if (sealed.error) return { value: null, problem: 'failed' };
  if (!sealed.data) return { value: null, problem: 'not_connected' };
  try {
    const opened = await openPartnerToken(ctx.sealKey, sealed.data as string);
    if (opened) return { value: opened };
  } catch {
    return { value: null, problem: 'failed' };
  }
  await ctx.admin.rpc('partner_pull_record', {
    p_company_id: companyId, p_partner: PARTNER, p_error: 'seal_unreadable',
  });
  return { value: null, problem: 'seal_unreadable' };
}

interface Settled { outcome: UberPullOutcome; detail?: string | null; drivers?: number }

async function settle(ctx: Context, runId: string, s: Settled): Promise<boolean> {
  const { error } = await ctx.admin.rpc('uber_pull_settle', {
    p_id: runId, p_outcome: s.outcome, p_detail: s.detail ?? null, p_driver_count: s.drivers ?? 0,
  });
  if (error) logFailure(FN, 'settle', LOG_CONTEXT, error);
  return !error;
}

async function pullOneDay(
  ctx: Context, companyId: string, runId: string, day: string, pass: UberPass, token: OpenedToken,
): Promise<UberPullRunItem> {
  const item = (result: string, extra: Partial<UberPullRunItem> = {}): UberPullRunItem =>
    ({ company_id: companyId, day, pass, result, ...extra });
  const stop = async (s: Settled) => {
    await settle(ctx, runId, s);
    return item(s.outcome, { drivers: s.drivers });
  };

  if (token.value === null) return stop({ outcome: token.problem ?? 'failed' });

  const earnings = await fetchDay(ctx, companyId, token.value, day);
  if (!earnings.ok) return stop({ outcome: earnings.outcome, detail: earnings.detail });
  if (earnings.unmatched.length > 0) {
    return stop({ outcome: 'blocked_unmatched', drivers: earnings.unmatched.length });
  }

  const earners = driversWithRows(earnings.drivers, day);
  const links = await loadLinks(ctx.admin, companyId);
  if (links === null) return stop({ outcome: 'failed', detail: 'links_unreadable' });
  const unlinked = earners.filter((d) => !links.has(d.externalDriverId));
  if (unlinked.length > 0) return stop({ outcome: 'blocked_unlinked', drivers: unlinked.length });

  const rows = buildDayRows(day, earnings.drivers);
  if (rows.length === 0) return stop({ outcome: 'nothing_to_import' });

  const written = await ctx.admin.rpc('income_import_uber_system', { p_run_id: runId, p_rows: rows });
  if (written.error) {
    logFailure(FN, 'import', { ...LOG_CONTEXT, company_id: companyId }, written.error);
    return stop({ outcome: 'failed', detail: 'import_error' });
  }
  const answer = written.data as { ok?: boolean; reason?: string; inserted?: number; deleted?: number; drivers?: number };
  if (answer?.ok === true) {
    return item('imported', { rows: answer.inserted ?? 0, deleted: answer.deleted ?? 0, drivers: answer.drivers ?? 0 });
  }
  const reason = typeof answer?.reason === 'string' ? answer.reason : 'unknown';
  return stop({ outcome: outcomeOfRefusal(reason), detail: reason, drivers: earners.length });
}

type Fetched =
  | { ok: true; drivers: UberDriverEarnings[]; unmatched: UnmatchedEarner[] }
  | { ok: false; outcome: UberPullOutcome; detail?: string | null };

/**
 * Reidey's earnings for ONE operating day. The same request, status handling
 * and strict parse as uber-earnings-pull; the difference is that a failure is
 * an outcome to record rather than a response to send.
 */
async function fetchDay(ctx: Context, companyId: string, token: string, day: string): Promise<Fetched> {
  const url = new URL(`${ctx.endpointOrigin}/api/v1/elprofessor/earnings`);
  url.searchParams.set('from', day);
  url.searchParams.set('to', day);

  let answer: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    answer = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    // Not the thrown value: it could name the destination, never the token, but
    // there is nothing in it a person could act on.
    return { ok: false, outcome: 'partner_unavailable' };
  } finally {
    clearTimeout(timer);
  }

  if (answer.status === 401 || answer.status === 403) {
    await ctx.admin.rpc('partner_pull_record', {
      p_company_id: companyId, p_partner: PARTNER, p_error: 'token_rejected',
    });
    return { ok: false, outcome: 'token_rejected' };
  }
  if (!answer.ok) {
    const refusal = await refusalReason(answer);
    if (refusal.reason) return { ok: false, outcome: 'partner_refused', detail: refusal.detail ?? refusal.reason };
    return { ok: false, outcome: 'partner_unavailable' };
  }

  let payload: unknown;
  try {
    payload = await answer.json();
  } catch {
    return { ok: false, outcome: 'partner_malformed', detail: 'malformed' };
  }
  const read = parseEarningsBody(payload, day, day);
  if (!read.ok) return { ok: false, outcome: 'partner_malformed', detail: read.problem };
  return { ok: true, drivers: read.value.drivers, unmatched: read.value.unmatched };
}

/**
 * A partner refusal's stable reason and the sentence beside it, capped and
 * stripped of control characters: it is a sentence from another product and it
 * ends up on a screen. Same rule as uber-earnings-pull.
 */
async function refusalReason(
  answer: Response,
): Promise<{ reason: string | null; detail: string | null }> {
  try {
    const body = (await answer.json()) as { reason?: unknown; message?: unknown };
    const reason = typeof body?.reason === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(body.reason)
      ? body.reason : null;
    const detail = typeof body?.message === 'string'
      // eslint-disable-next-line no-control-regex
      ? body.message.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null
      : null;
    return { reason, detail };
  } catch {
    return { reason: null, detail: null };
  }
}
