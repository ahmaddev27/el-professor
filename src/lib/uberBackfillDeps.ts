/**
 * The Supabase side of the earnings backfill: the same two calls the Umsätze
 * dialog makes (`uber-earnings-pull`, `income_import_uber`), with the same
 * reasons turned into the same sentences. Nothing here decides anything; the
 * decisions are in uberBackfill.ts and the rules in the database.
 */
import { supabase } from './supabase';
import type { TranslationKey } from '../i18n';
import { normalizePartnerReason } from '../utils/uberPeriods';
import { readPullAnswer, readImportAnswer } from '../utils/uberEarningsImport';
import type { UnlinkedDriver } from '../utils/uberEarningsImport';
import type { BackfillDeps, BackfillState, PullResult, ResolveResult, WriteResult } from './uberBackfill';

const PULL_REASON_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  not_connected: 'inc.uber.err.notConnected',
  seal_unreadable: 'inc.uber.err.notConnected',
  token_rejected: 'inc.uber.err.tokenRejected',
  partner_unavailable: 'inc.uber.err.partnerUnavailable',
  partner_malformed: 'inc.uber.err.partnerMalformed',
  invalid_range: 'inc.uber.err.invalidRange',
  range_too_long: 'inc.uber.err.rangeTooLong',
};

const PARTNER_REASON_KEYS: Record<string, TranslationKey> = {
  no_proxy: 'inc.uber.err.partner.no_proxy',
  uber_session_rejected: 'inc.uber.err.partner.uber_session_rejected',
  too_many_pages: 'inc.uber.err.partner.too_many_pages',
  unreadable_amount: 'inc.uber.err.partner.unreadable_amount',
  range_too_long: 'inc.uber.err.partner.range_too_long',
};

const IMPORT_HINT_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  platform_session_not_allowed: 'inc.uber.err.platformSession',
  driver_not_linked: 'inc.uber.err.driverNotLinked',
  already_imported: 'inc.uber.err.alreadyImported',
  invalid_request: 'inc.uber.err.invalidRows',
  invalid_period: 'inc.uber.err.invalidRows',
};

/** supabase-js hides the body of a non-2xx answer behind `error.context`. */
type Failure = { ok?: boolean; reason?: string; partner_reason?: string };

async function bodyOf(error: unknown): Promise<Failure | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    return (await context.json()) as Failure;
  } catch {
    return null;
  }
}

function refusal(body: Failure | null): PullResult {
  if (body?.reason === 'partner_refused') {
    const partner = normalizePartnerReason(body.partner_reason ?? '');
    const named = PARTNER_REASON_KEYS[partner];
    return named ? { ok: false, reason: named } : { ok: false, reason: 'inc.uber.err.generic', detail: partner };
  }
  return { ok: false, reason: (body?.reason && PULL_REASON_KEYS[body.reason]) || 'inc.uber.err.generic' };
}

async function pull(from: string, to: string, granularity: 'week' | 'day'): Promise<PullResult> {
  try {
    const body = granularity === 'day' ? { from, to, granularity } : { from, to };
    const { data, error } = await supabase.functions.invoke('uber-earnings-pull', { body });
    const failure = error ? await bodyOf(error) : (data as Failure | null);
    if (error || (failure && failure.ok === false)) return refusal(failure);
    const read = readPullAnswer(data);
    return read ? { ok: true, ...read } : { ok: false, reason: 'inc.uber.err.partnerMalformed' };
  } catch {
    return { ok: false, reason: 'inc.uber.err.generic' };
  }
}

async function write(rows: unknown[]): Promise<WriteResult> {
  try {
    const { data, error } = await supabase.rpc('income_import_uber', { p_rows: rows, p_replace: false });
    if (error) {
      const hint = (error as { hint?: string }).hint ?? '';
      return { ok: false, reason: IMPORT_HINT_KEYS[hint] ?? 'inc.uber.err.generic' };
    }
    return { ok: true, inserted: readImportAnswer(data, rows.length).inserted };
  } catch {
    return { ok: false, reason: 'inc.uber.err.generic' };
  }
}

/** The names in one array of `{ name }` objects, or null if it is anything else. */
function namesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    const name = (item as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  return names;
}

/** Anything but the exact shape is a failure: "nothing created" is a claim. */
function readResolveAnswer(data: unknown): ResolveResult {
  const a = (data ?? {}) as { ok?: unknown; created?: unknown; linked?: unknown; skipped?: unknown };
  const created = namesOf(a.created);
  const linked = namesOf(a.linked);
  const skipped = namesOf(a.skipped);
  if (a.ok !== true || !created || !linked || !skipped) return { ok: false, reason: 'inc.uber.err.generic' };
  return { ok: true, created, linked, skipped };
}

async function resolve(earners: UnlinkedDriver[]): Promise<ResolveResult> {
  try {
    const p_earners = earners.map(e => ({ external_driver_id: e.externalDriverId, name: e.name }));
    const { data, error } = await supabase.rpc('partner_earners_resolve', { p_partner: 'reidey', p_earners });
    if (error) {
      const hint = (error as { hint?: string }).hint ?? '';
      return { ok: false, reason: IMPORT_HINT_KEYS[hint] ?? 'inc.uber.err.generic' };
    }
    return readResolveAnswer(data);
  } catch {
    return { ok: false, reason: 'inc.uber.err.generic' };
  }
}

async function readState(): Promise<BackfillState | null> {
  try {
    const newest = await supabase.from('income').select('source_period_end')
      .eq('source', 'uber').not('source_period_end', 'is', null)
      .order('source_period_end', { ascending: false }).limit(1);
    const manual = await supabase.from('income').select('id', { count: 'exact', head: true }).is('source', null);
    if (newest.error || manual.error || manual.count === null) return null;
    const latest = (newest.data?.[0] as { source_period_end?: string } | undefined)?.source_period_end;
    return { latestEnd: latest ?? null, manualRows: manual.count };
  } catch {
    return null;
  }
}

export function supabaseBackfillDeps(shouldStop: () => boolean): BackfillDeps {
  return {
    now: () => new Date(),
    readState,
    pull,
    write,
    resolve,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    shouldStop,
  };
}
