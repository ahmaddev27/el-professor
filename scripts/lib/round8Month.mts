/**
 * The pure half of `scripts/fleetbook-round8-month.mts` (Round 8, W4): a
 * snapshot of everything the `Fahrten simulieren` screen reads for one calendar
 * month, and the run that turns a snapshot into the screen's three workbooks.
 *
 * The run calls exactly what the screen calls — `readCachedPool`,
 * `prepareRouting`, `calendarMonthInput`, `generateFullMonth` and the three
 * builders — so a month built here is the screen's month. The snapshot exists so
 * the run can be repeated without a network: the address pool and the routed
 * matrix are kept the way the browser keeps them (one `Storage`, dumped), and a
 * replay hands the run clients that refuse every call, so an answer that is not
 * in the snapshot stops the run instead of being fetched or guessed.
 *
 * It holds a company's data (driver names, addresses of the pool): a snapshot is
 * written outside the repository, never committed.
 */
import type { DriverPlanningFacts } from '../../src/lib/simulationInputsClient';
import type { CompanySimulationSettings } from '../../src/lib/simulationSettingsClient';
import { prepareRouting, type RoutingFailureReason } from '../../src/lib/simulationRouting';
import type { GeocodeClient } from '../../src/lib/geocodeClient';
import type { StructuredNote } from '../../src/utils/monatsplanungPhase3';
import { readCachedPool, writeCachedPool, buildAddressPool, type AddressPool } from '../../src/utils/simulatedRides/addressPool';
import type { BaseResolution } from '../../src/utils/simulatedRides/baseSelection';
import { parseCalendarForm, type CalendarForm } from '../../src/utils/simulatedRides/calendarForm';
import { calendarMonthInput, type CalendarCar, type CalendarDriver, type CalendarEvents, type CalendarSourcing } from '../../src/utils/simulatedRides/calendarRun';
import { generateFullMonth, type FullMonthFailure, type FullMonthResult, type SettingsSource } from '../../src/utils/simulatedRides/fullMonth';
import { buildMonthClosing } from '../../src/utils/simulatedRides/monthClosing';
import { verifyMonth, type MonthVerification } from '../../src/utils/simulatedRides/monthVerification';
import { buildMonthReport, type MonthReport } from '../../src/utils/simulatedRides/monthWorkbook';
import { shareSettingProblem, type ShareSetting } from '../../src/utils/simulatedRides/monthlyRate';
import { buildOperationalReport } from '../../src/utils/simulatedRides/operationalReport';
import type { TravelRouter } from '../../src/utils/travelRouting/prefetch';

export const SNAPSHOT_VERSION = 1;
/** The only company this script may read. Never a real customer (D9). */
export const DEMO_COMPANY_NAME = 'DEMO Monatsplanung GmbH';

// ── The snapshot ─────────────────────────────────────────────────────────────

/** `CalendarEvents` with its two maps as entry lists, so it survives JSON. */
export type SerializedEvents = Omit<CalendarEvents, 'notes' | 'facts'> & {
  notes: [string, StructuredNote[]][];
  facts: [string, DriverPlanningFacts][];
};

export interface MonthSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** When the inputs were read; a replay judges the caches' age against it. */
  fetchedAt: string;
  company: { id: string; name: string };
  year: number;
  month: number;
  seed: number;
  /** The city the address pool is built for (the company's, as on the screen). */
  city: string;
  form: CalendarForm;
  cars: CalendarCar[];
  carIds: string[];
  drivers: CalendarDriver[];
  /** `resolveBase`'s answer at fetch time: a refusal is kept, and replays as one. */
  base: BaseResolution;
  events: SerializedEvents;
  settingsSource: SettingsSource;
  /** The routing services could not answer and the estimate was asked for (`--allow-estimate`). */
  allowEstimate: boolean;
  /** The browser-style cache: the address pool, the verified addresses and the routed matrix. */
  storage: Record<string, string>;
}

export function serializeEvents(e: CalendarEvents): SerializedEvents {
  return { ...e, notes: [...e.notes.entries()], facts: [...e.facts.entries()] };
}

export function deserializeEvents(e: SerializedEvents): CalendarEvents {
  return { ...e, notes: new Map(e.notes), facts: new Map(e.facts) };
}

/** A `Storage` held in memory, which can be dumped into a snapshot and filled from one. */
export function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { dump(): Record<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)); },
    dump: () => Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

// ── The settings a run uses ──────────────────────────────────────────────────

export type SettingsRead =
  /** The table answered: the company's row, or none. */
  | { kind: 'table'; settings: CompanySimulationSettings }
  /** The table does not exist on this stack yet (staging before the S8 migration is deployed). */
  | { kind: 'table_missing' };

export type SettingsDecision =
  | { ok: true; simulation: CompanySimulationSettings; source: SettingsSource }
  | { ok: false; reason: string };

/**
 * Which settings a month runs on. The company's stored settings always win, and
 * a typed rate beside them is refused rather than quietly preferred or ignored:
 * the company having no rate IS its setting. Only where the table does not exist
 * yet do the arguments stand in, and the month's sheet 7 then says so.
 */
export function decideSettings(read: SettingsRead, args: { sharePercent: number | null; returnToBase: boolean }): SettingsDecision {
  if (read.kind === 'table') {
    if (args.sharePercent !== null || args.returnToBase) {
      return { ok: false, reason: 'the company_simulation_settings table exists on this stack, so the company\'s stored settings decide; drop --share-percent and --return-to-base' };
    }
    return { ok: true, simulation: read.settings, source: 'company_settings' };
  }
  let shareSetting: ShareSetting | null = null;
  if (args.sharePercent !== null) {
    shareSetting = { mode: 'fixed', percent: args.sharePercent } as ShareSetting;
    const problem = shareSettingProblem(shareSetting);
    if (problem) return { ok: false, reason: `--share-percent ${args.sharePercent}: ${problem} (allowed: 30, 31, 32 or 33)` };
  }
  return { ok: true, simulation: { shareSetting, returnToBase: args.returnToBase, stored: false, updatedAt: null }, source: 'script_arguments' };
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface RunDeps {
  /** Nominatim, for a pool the cache does not hold. */
  fetchFn: (url: string) => Promise<Response>;
  geocoder: GeocodeClient;
  router: TravelRouter;
}

/** Clients for a replay: every call is a refusal, so nothing missing from the snapshot is fetched. */
export const OFFLINE_DEPS: RunDeps = {
  fetchFn: async url => { throw new Error(`replay: the address pool is not in the snapshot (would fetch ${new URL(url).host})`); },
  geocoder: { geocode: async () => { throw new Error('replay: an address check is not in the snapshot'); } },
  router: { route: async () => { throw new Error('replay: a route is not in the snapshot'); } },
};

export type RunStage = 'base' | 'form' | 'pool' | 'routing' | 'generate';

export type RunOutcome =
  | {
      ok: true;
      result: FullMonthResult;
      verification: MonthVerification;
      workbooks: MonthReport[];
      sourcing: { estimate: boolean; routingFailure: RoutingFailureReason | null; poolFromCache: boolean };
      /** The cache after the run, to be kept in the snapshot. */
      storage: Record<string, string>;
    }
  | { ok: false; stage: RunStage; reason: string };

/**
 * One calendar month, the way `generateCalendar` on the screen builds it: base,
 * pool, routing (the estimate only when asked for), the shared input, the
 * generator and the three workbooks.
 */
export async function runMonth(snapshot: MonthSnapshot, deps: RunDeps): Promise<RunOutcome> {
  const now = new Date(snapshot.fetchedAt);
  const storage = memoryStorage(snapshot.storage);

  // No base, no month (D7): CONFIGURATION_REQUIRED, the same refusal as the screen's.
  if (!snapshot.base.ok) return { ok: false, stage: 'base', reason: `CONFIGURATION_REQUIRED: ${snapshot.base.reason}${snapshot.base.detail ? ` (${snapshot.base.detail})` : ''}` };
  const form = parseCalendarForm(snapshot.form);
  if (!form.ok) return { ok: false, stage: 'form', reason: `the calendar form's ${form.field} does not parse` };

  let pool: AddressPool | null = readCachedPool(snapshot.city, storage, now);
  const poolFromCache = pool !== null;
  if (!pool) {
    try {
      pool = await buildAddressPool(snapshot.city.trim(), { fetchFn: deps.fetchFn, now: () => now });
      writeCachedPool(pool, storage);
    } catch (err) {
      return { ok: false, stage: 'pool', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const origin = snapshot.base.base;
  let sourcing: CalendarSourcing;
  let routingFailure: RoutingFailureReason | null = null;
  try {
    const routing = await prepareRouting({ pool: pool.addresses, base: origin, deps: { geocoder: deps.geocoder, router: deps.router, storage, now: () => now, sleep: async () => {} } });
    if (routing.ok) {
      sourcing = { points: routing.points, travel: routing.model, provenance: routing.provenance, estimate: false };
    } else {
      routingFailure = routing.reason;
      if (!snapshot.allowEstimate) return { ok: false, stage: 'routing', reason: `${routing.reason}${routing.detail ? ` (${routing.detail})` : ''}` };
      sourcing = { points: pool.addresses, travel: undefined, provenance: null, estimate: true };
    }
  } catch (err) {
    return { ok: false, stage: 'routing', reason: err instanceof Error ? err.message : String(err) };
  }

  const outcome = generateFullMonth(calendarMonthInput({
    year: snapshot.year, month: snapshot.month, seed: snapshot.seed, tenantId: snapshot.company.id,
    base: { point: origin, source: snapshot.base.source, label: snapshot.base.label },
    cars: snapshot.cars, carIds: snapshot.carIds, drivers: snapshot.drivers,
    events: deserializeEvents(snapshot.events), sourcing, form, settingsSource: snapshot.settingsSource,
  }));
  if (!outcome.ok) return { ok: false, stage: 'generate', reason: failureText(outcome.failure) };

  const verification = verifyMonth(outcome.result);
  return {
    ok: true,
    result: outcome.result,
    verification,
    workbooks: [buildMonthReport, buildOperationalReport, buildMonthClosing].map(build => build(outcome.result, verification)),
    sourcing: { estimate: sourcing.estimate, routingFailure, poolFromCache },
    storage: storage.dump(),
  };
}

function failureText(failure: FullMonthFailure): string {
  return 'problem' in failure ? `${failure.kind}: ${String(failure.problem)}` : failure.kind;
}

// ── Arguments ────────────────────────────────────────────────────────────────

export interface Args {
  mode: 'fetch' | 'replay';
  /** `fetch` only. */
  year: number | null;
  month: number | null;
  /** `replay` only. */
  inputs: string | null;
  seed: number | null;
  sharePercent: number | null;
  returnToBase: boolean;
  allowEstimate: boolean;
  out: string | null;
  /** Post the payloads to the export service; needs a staging session. */
  render: boolean;
}

export function parseArgs(argv: readonly string[]): { ok: true; args: Args } | { ok: false; error: string } {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const fetch = flag('fetch');
  const inputs = value('from-inputs') ?? null;
  if (fetch === (inputs !== null)) return { ok: false, error: 'give exactly one of --fetch --month YYYY-MM or --from-inputs <snapshot.json>' };

  let year: number | null = null;
  let month: number | null = null;
  if (fetch) {
    const m = /^(\d{4})-(\d{2})$/.exec(value('month') ?? '');
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return { ok: false, error: '--fetch needs --month YYYY-MM' };
    year = Number(m[1]);
    month = Number(m[2]);
  }
  const seedText = value('seed');
  const seed = seedText === undefined ? null : Number(seedText);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0)) return { ok: false, error: '--seed must be a whole number of 0 or more' };
  const shareText = value('share-percent');
  const sharePercent = shareText === undefined ? null : Number(shareText);
  if (sharePercent !== null && !Number.isInteger(sharePercent)) return { ok: false, error: '--share-percent must be 30, 31, 32 or 33' };
  if (!fetch && (sharePercent !== null || flag('return-to-base') || flag('allow-estimate'))) {
    return { ok: false, error: '--share-percent, --return-to-base and --allow-estimate are read when the inputs are fetched; a replay runs on the snapshot' };
  }
  return {
    ok: true,
    args: {
      mode: fetch ? 'fetch' : 'replay', year, month, inputs, seed, sharePercent,
      returnToBase: flag('return-to-base'), allowEstimate: flag('allow-estimate'),
      out: value('out') ?? null, render: fetch || flag('render'),
    },
  };
}

/** A fixed seed per month, so the example months repeat without anyone choosing a number. */
export function defaultSeed(year: number, month: number): number {
  return year * 100 + month;
}
