/**
 * The fleet import's reading side: what the pull and the two import RPCs
 * answered, turned into something a screen can state without guessing.
 *
 * ## An unreadable answer is a failure, never "0 created"
 *
 * `parseImportResult` returns null for anything that does not carry the
 * counts, and the screen shows its error state for null. A zero the code
 * invented because a field was missing would read as "nothing to import",
 * which is a claim.
 */
import type { TranslationKey } from '../i18n';
import type { BackfillProgress, EarningsOutcome } from './uberBackfill';

export type ImportScope = 'drivers' | 'vehicles';

export type SkipReason =
  | 'name_missing' | 'name_taken' | 'limit_reached'
  | 'plate_missing' | 'plate_duplicate' | 'plate_unavailable';

export interface SkippedRow {
  linkId: string;
  /** The partner's own name for the driver, or their plate. */
  label: string;
  reason: SkipReason | 'unknown';
}

export interface ImportResult {
  created: number;
  linked: number;
  skipped: SkippedRow[];
}

const SKIP_KEYS: Record<SkipReason, TranslationKey> = {
  name_missing: 'import.skip.nameMissing',
  name_taken: 'import.skip.nameTaken',
  limit_reached: 'import.skip.limitReached',
  plate_missing: 'import.skip.plateMissing',
  plate_duplicate: 'import.skip.plateDuplicate',
  plate_unavailable: 'import.skip.plateUnavailable',
};

export function skipReasonKey(reason: SkippedRow['reason'], scope: ImportScope): TranslationKey {
  if (reason !== 'unknown') return SKIP_KEYS[reason];
  return scope === 'drivers' ? 'import.skip.unknownDriver' : 'import.skip.unknownVehicle';
}

/** The pull function's reasons; most send the operator to Einstellungen. */
const PULL_KEYS: Record<string, TranslationKey> = {
  not_connected: 'partner.pull.error.notConnected',
  seal_unreadable: 'partner.pull.error.sealUnreadable',
  token_rejected: 'partner.pull.error.tokenRejected',
  partner_unavailable: 'partner.pull.error.partnerUnavailable',
  not_authorized: 'partner.pull.error.notAuthorized',
  vehicles_unavailable: 'import.error.vehiclesUnavailable',
  seal_key_missing: 'partner.pull.error.notConfigured',
  endpoint_missing: 'partner.pull.error.notConfigured',
  endpoint_unparsable: 'partner.pull.error.notConfigured',
  endpoint_not_https: 'partner.pull.error.notConfigured',
  endpoint_has_credentials: 'partner.pull.error.notConfigured',
  endpoint_private_host: 'partner.pull.error.notConfigured',
  endpoint_unexpected_port: 'partner.pull.error.notConfigured',
  endpoint_has_path: 'partner.pull.error.notConfigured',
};

export function pullReasonKey(reason: string | undefined): TranslationKey {
  return (reason ? PULL_KEYS[reason] : undefined) ?? 'import.error.pullGeneric';
}

/** The import RPCs' stable HINTs. */
export function importErrorKey(hint: unknown): TranslationKey {
  if (hint === 'platform_session_not_allowed') return 'import.error.platformSession';
  if (hint === 'not_authorized') return 'import.error.notAuthorized';
  return 'import.error.importGeneric';
}

const KNOWN_REASONS = new Set<string>(Object.keys(SKIP_KEYS));

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseImportResult(data: unknown, scope: ImportScope): ImportResult | null {
  const row = data as Record<string, unknown> | null;
  if (!row || row.ok !== true) return null;
  const created = count(row.created);
  const linked = count(row.linked);
  if (created === null || linked === null || !Array.isArray(row.skipped)) return null;

  const skipped: SkippedRow[] = row.skipped.map(entry => {
    const item = entry as Record<string, unknown>;
    const reason = typeof item.reason === 'string' && KNOWN_REASONS.has(item.reason)
      ? (item.reason as SkipReason) : 'unknown';
    const label = scope === 'drivers' ? item.name : item.plate;
    return {
      linkId: String(item.link_id ?? ''),
      label: typeof label === 'string' ? label : '',
      reason,
    };
  });
  return { created, linked, skipped };
}

// ── One button, every leg (14.10.2026) ──────────────────────────────────────
//
// The legs run in this order and each is independent: a leg that fails is
// recorded and the next one still runs. What a leg does (the pull, then the
// import RPC, and how each answer is read) is the former card's `run`, moved
// here unchanged so a test can drive it.

export const IMPORT_LEGS: readonly ImportScope[] = ['drivers', 'vehicles'];

export const IMPORT_RPC: Record<ImportScope, string> = {
  drivers: 'partner_drivers_import',
  vehicles: 'partner_vehicles_import',
};

export type LegOutcome =
  | { scope: ImportScope; status: 'done'; seen: number; result: ImportResult }
  | { scope: ImportScope; status: 'failed'; reason: TranslationKey }
  /** The partner does not offer this yet. Not a failure of the data or the click. */
  | { scope: ImportScope; status: 'unavailable'; reason: TranslationKey };

export interface ImportDeps {
  pull(scope: ImportScope): Promise<{ data: unknown; error: unknown }>;
  importRpc(rpc: string): Promise<{ data: unknown; error: unknown }>;
}

export async function runImportLeg(scope: ImportScope, deps: ImportDeps): Promise<LegOutcome> {
  try {
    const pulled = await deps.pull(scope);
    if (pulled.error) throw pulled.error;
    const answer = pulled.data as { ok?: boolean; reason?: string; seen?: number } | null;
    if (!answer?.ok) {
      const reason = pullReasonKey(answer?.reason);
      return answer?.reason === 'vehicles_unavailable'
        ? { scope, status: 'unavailable', reason }
        : { scope, status: 'failed', reason };
    }
    const imported = await deps.importRpc(IMPORT_RPC[scope]);
    if (imported.error) {
      return { scope, status: 'failed', reason: importErrorKey((imported.error as { hint?: unknown }).hint) };
    }
    const result = parseImportResult(imported.data, scope);
    return result
      ? { scope, status: 'done', seen: answer.seen ?? 0, result }
      : { scope, status: 'failed', reason: 'import.error.importGeneric' };
  } catch {
    return { scope, status: 'failed', reason: 'import.error.pullGeneric' };
  }
}

export type EarningsLeg = { scope: 'earnings'; earnings: EarningsOutcome };
export type FleetOutcome = LegOutcome | EarningsLeg;

/** Runs the earnings leg; progress goes to `report`. */
export type EarningsRunner = (report: (p: BackfillProgress) => void) => Promise<EarningsOutcome>;

/**
 * Sequential on purpose: one request at a time against the partner and the
 * database. Drivers come first because the earnings are written against the
 * driver links they create; a leg that failed does not stop the next one.
 */
export async function runFleetImport(
  deps: ImportDeps, earnings?: EarningsRunner, report: (p: BackfillProgress) => void = () => {},
): Promise<FleetOutcome[]> {
  const outcomes: FleetOutcome[] = [];
  for (const scope of IMPORT_LEGS) outcomes.push(await runImportLeg(scope, deps));
  if (earnings) outcomes.push({ scope: 'earnings', earnings: await earnings(report) });
  return outcomes;
}

function legSucceeded(o: FleetOutcome): boolean {
  if (o.scope !== 'earnings') return o.status === 'done';
  return o.earnings.status === 'done' || o.earnings.status === 'nothing';
}

/** `success` only when every leg imported; anything else is never reported as one. */
export function overallStatus(outcomes: readonly FleetOutcome[]): 'success' | 'partial' | 'failed' {
  const done = outcomes.filter(legSucceeded).length;
  if (done === outcomes.length && done > 0) return 'success';
  return done > 0 ? 'partial' : 'failed';
}
