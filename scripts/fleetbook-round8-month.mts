/**
 * The Round 8 example months (W4): one calendar month of DEMO Monatsplanung
 * GmbH, built by the `Fahrten simulieren` screen's own code, written as the
 * screen's three workbooks.
 *
 *   npx vite-node scripts/fleetbook-round8-month.mts --fetch --month 2026-09 --out <dir>
 *       [--seed N] [--share-percent 30..33] [--return-to-base] [--allow-estimate]
 *   npx vite-node scripts/fleetbook-round8-month.mts --from-inputs <dir>/round8-2026-09-inputs.json --out <dir>
 *       [--seed N] [--render]
 *
 * --fetch signs in to STAGING as the DEMO login (e2e/.env.local; no other host
 * is accepted, and no company but DEMO Monatsplanung GmbH), reads what the
 * screen reads, builds the address pool and the routed matrix through the same
 * edge functions, and writes:
 *   round8-YYYY-MM-inputs.json   the snapshot: inputs, base, and the route cache
 *   <workbook>.payload.json      the three workbooks as the export service gets them
 *   <workbook>.xlsx              the three workbooks, written by the export service
 *   round8-YYYY-MM-figures.json  the month's figures, for the before/after comparison
 *                                (`scripts/fleetbook-round8-before.mts`)
 *
 * --from-inputs repeats a month from its snapshot with no network at all: the
 * clients refuse every call, so an answer the snapshot does not hold stops the
 * run. The same snapshot and seed give byte-identical payloads, which is what
 * the before/after comparison and a later re-render rely on. --render posts the
 * payloads to the export service, which needs the staging sign-in again.
 *
 * Settings: where `company_simulation_settings` exists the company's row
 * decides and --share-percent / --return-to-base are refused. On a stack
 * without the table (staging before Round 8 is deployed) those arguments stand
 * in, and sheet 7 of the Monatsabschluss names them as the source.
 *
 * The outputs hold the company's data (driver names, addresses): keep --out
 * OUTSIDE the repository; the script refuses a directory inside it.
 * Exit codes: 2 arguments, 3 sign-in or company refused, 4 the month was refused.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CALENDAR_FORM } from '../src/utils/simulatedRides/calendarForm.ts';
import type { MonthReport } from '../src/utils/simulatedRides/monthWorkbook.ts';
import {
  DEMO_COMPANY_NAME, OFFLINE_DEPS, SNAPSHOT_VERSION, decideSettings, defaultSeed, parseArgs, runMonth, serializeEvents,
  type MonthSnapshot, type RunDeps, type RunOutcome, type SettingsRead,
} from './lib/round8Month.mts';
import { monthFigures } from './lib/round8Figures.mts';

const STAGING_API_HOST = 'api-staging.elprofessor.eu';
const STAGING_APP_URL = 'https://app.elprofessor.eu';
const REPO = path.resolve(import.meta.dirname, '..');

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) fail(2, parsed.error);
const args = parsed.args;
if (!args.out) fail(2, '--out <dir> is required, outside the repository');
const OUT = path.resolve(args.out);
if (OUT === REPO || OUT.startsWith(REPO + path.sep)) fail(2, 'refusing an output directory inside the repository');
mkdirSync(OUT, { recursive: true });

// ── Staging, and only staging ──────────────────────────────────────────────────

function e2eEnv(): Record<string, string> {
  const text = readFileSync(path.join(REPO, 'e2e/.env.local'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const m = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/gu, '');
  }
  return out;
}

/**
 * `src/lib/supabase.ts` reads its URL from `import.meta.env` when it is first
 * imported, so the script runs itself once more with staging's values in the
 * environment rather than trusting whatever .env file vite-node would pick up.
 * Returns the signed-in app client.
 */
async function stagingSession() {
  const env = e2eEnv();
  const api = env.E2E_API_URL ?? '';
  if (new URL(api).host !== STAGING_API_HOST) fail(3, `e2e/.env.local names ${new URL(api).host}, not staging`);
  if (process.env.R8_STAGING_CHILD !== '1') {
    const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, R8_STAGING_CHILD: '1', VITE_SUPABASE_URL: api, VITE_SUPABASE_ANON_KEY: env.E2E_ANON_KEY, VITE_APP_URL: STAGING_APP_URL },
    });
    process.exit(child.status ?? 1);
  }
  if (import.meta.env.VITE_SUPABASE_URL !== api) fail(3, 'the app client is not configured for staging; refusing');
  const { supabase } = await import('../src/lib/supabase.ts');
  const { error } = await supabase.auth.signInWithPassword({ email: env.E2E_DEMO_EMAIL, password: env.E2E_DEMO_PASSWORD });
  if (error) fail(3, `sign-in to staging failed: ${error.message}`);
  return supabase;
}

type AppClient = Awaited<ReturnType<typeof stagingSession>>;

/** The signed-in account's company, refused unless it is the DEMO company (D9). */
async function demoCompany(supabase: AppClient): Promise<{ id: string; name: string }> {
  const { data: user } = await supabase.auth.getUser();
  const profile = await supabase.from('user_profiles').select('company_id').eq('user_id', user.user?.id ?? '').maybeSingle();
  const companyId = (profile.data as { company_id?: string | null } | null)?.company_id;
  if (profile.error || !companyId) fail(3, 'the DEMO login has no company');
  const company = await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle();
  const row = company.data as { id: string; name: string } | null;
  if (company.error || !row) fail(3, 'the DEMO company could not be read');
  if (row.name !== DEMO_COMPANY_NAME) fail(3, `refusing: the signed-in company is not ${DEMO_COMPANY_NAME}`);
  return row;
}

/** Whether `company_simulation_settings` exists here, and if so the company's settings as the screen reads them. */
async function readSettings(supabase: AppClient, companyId: string): Promise<SettingsRead> {
  const probe = await supabase.from('company_simulation_settings').select('company_id').eq('company_id', companyId).limit(1);
  // PGRST205: PostgREST knows no such table; 42P01: PostgreSQL does not.
  if (probe.error && (probe.error.code === 'PGRST205' || probe.error.code === '42P01')) return { kind: 'table_missing' };
  if (probe.error) fail(3, `company_simulation_settings: ${probe.error.message}`);
  const { loadSimulationSettings } = await import('../src/lib/simulationSettingsClient.ts');
  return { kind: 'table', settings: await loadSimulationSettings(companyId, supabase) };
}

// ── The two modes ────────────────────────────────────────────────────────────

async function fetchSnapshot(supabase: AppClient): Promise<{ snapshot: MonthSnapshot; deps: RunDeps }> {
  const year = args.year!;
  const month = args.month!;
  const fetchedAt = new Date().toISOString();
  const company = await demoCompany(supabase);

  const settingsRead = await readSettings(supabase, company.id);
  const settings = decideSettings(settingsRead, { sharePercent: args.sharePercent, returnToBase: args.returnToBase });
  if (!settings.ok) fail(2, settings.reason);

  const [{ loadCompanyDrivers, loadSettings }, { selectableDrivers }, inputs, { loadUberMonth }, { loadRealTripRows }, { resolveBase }, { savedBasePoint }, { addDays }, { createGeocodeClient }, { createTravelRouteClient }] = await Promise.all([
    import('../src/lib/tripAnalysisClient.ts'),
    import('../src/utils/driverStatus.ts'),
    import('../src/lib/simulationInputsClient.ts'),
    import('../src/utils/simulatedRides/uberImportLoader.ts'),
    import('../src/utils/simulatedRides/realTripsLoader.ts'),
    import('../src/utils/simulatedRides/baseSelection.ts'),
    import('../src/utils/simulatedRides/calendarRun.ts'),
    import('../src/utils/simulatedRides/figures.ts'),
    import('../src/lib/geocodeClient.ts'),
    import('../src/lib/travelRouteClient.ts'),
  ]);

  // What the screen loads when it opens (cars, drivers, saved base, company address) …
  const [cars, drivers, tripSettings, address] = await Promise.all([
    supabase.from('cars').select('id, kennzeichen, tuev_gueltig_bis').eq('company_id', company.id).order('kennzeichen'),
    loadCompanyDrivers(company.id),
    loadSettings(company.id),
    supabase.from('company_settings').select('street, house_number, postal_code, city').eq('company_id', company.id).maybeSingle(),
  ]);
  if (cars.error) fail(3, `cars: ${cars.error.message}`);
  if (address.error) fail(3, `company_settings: ${address.error.message}`);
  const carList = ((cars.data ?? []) as { id: string; kennzeichen: string; tuev_gueltig_bis: string | null }[])
    .map(c => ({ id: c.id, plate: c.kennzeichen, tuev: c.tuev_gueltig_bis ?? null }));
  const addressRow = address.data as { street: string | null; house_number: string | null; postal_code: string | null; city: string | null } | null;
  const geocoder = createGeocodeClient();
  const base = await resolveBase({ saved: savedBasePoint(tripSettings), address: addressRow, geocoder });

  // … and what it reads when the month is run.
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = addDays(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`, -1);
  const [notes, facts, checks, unavailability, uber, realTrips] = await Promise.all([
    inputs.loadDriverNotes(company.id, addDays(first, -7)),
    inputs.loadDriverPlanningFacts(company.id),
    inputs.loadWerkstattChecks(company.id, first, last),
    inputs.loadVehicleUnavailability(company.id, addDays(first, -1), addDays(last, 2)),
    loadUberMonth(company.id, year, month, supabase),
    loadRealTripRows(company.id, year, month, supabase),
  ]);

  const snapshot: MonthSnapshot = {
    version: SNAPSHOT_VERSION, fetchedAt, company, year, month,
    seed: args.seed ?? defaultSeed(year, month),
    city: addressRow?.city?.trim() ?? '',
    form: DEFAULT_CALENDAR_FORM,
    cars: carList, carIds: carList.map(c => c.id),
    drivers: selectableDrivers(drivers).map(d => ({ id: d.id, name: d.name })),
    base,
    events: serializeEvents({ notes, facts, checks, unavailability, uber, realTrips, simulation: settings.simulation }),
    settingsSource: settings.source,
    allowEstimate: args.allowEstimate,
    storage: {},
  };
  if (!snapshot.city) fail(4, 'CONFIGURATION_REQUIRED: the company has no city, so there is no address pool');
  return {
    snapshot,
    deps: {
      // Nominatim, as the screen asks it; a generic client name, nothing that names the company.
      fetchFn: url => fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'fleet-simulation-example/1.0' } }),
      geocoder,
      router: createTravelRouteClient(),
    },
  };
}

function readSnapshot(file: string): MonthSnapshot {
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as MonthSnapshot;
  if (snapshot.version !== SNAPSHOT_VERSION) fail(2, `${file}: snapshot version ${String(snapshot.version)}, this script reads ${SNAPSHOT_VERSION}`);
  if (snapshot.company?.name !== DEMO_COMPANY_NAME) fail(3, `${file}: not a snapshot of ${DEMO_COMPANY_NAME}`);
  return args.seed === null ? snapshot : { ...snapshot, seed: args.seed };
}

// ── Output ───────────────────────────────────────────────────────────────────

const monthKey = (s: MonthSnapshot) => `${s.year}-${String(s.month).padStart(2, '0')}`;

function summarize(snapshot: MonthSnapshot, outcome: Extract<RunOutcome, { ok: true }>): void {
  const { result, verification, sourcing } = outcome;
  const notPassed = verification.checks.filter(c => c.outcome !== 'passed').map(c => `${c.code}=${c.outcome}`);
  console.log([
    `month ${monthKey(snapshot)}  seed ${snapshot.seed}  verdict ${verification.verdict}`,
    `routing ${verification.routing}${sourcing.routingFailure ? ` (${sourcing.routingFailure}; estimate asked for)` : ''}  pool ${sourcing.poolFromCache ? 'from snapshot' : 'built'}`,
    `rides ${result.month.rides.length}  shifts ${result.month.shifts.length}  dropped shifts ${result.month.droppedShifts}`,
    `financial ${result.financial.status}  settings from ${snapshot.settingsSource}`,
    `checks not passed: ${notPassed.length ? notPassed.join(', ') : 'none'}`,
  ].join('\n'));
}

function writeFigures(snapshot: MonthSnapshot, outcome: Extract<RunOutcome, { ok: true }>): void {
  const base = snapshot.base.ok ? snapshot.base.label : '—';
  const figures = monthFigures({ label: 'Round 8', month: monthKey(snapshot), seed: snapshot.seed, base }, outcome.result, outcome.verification);
  writeFileSync(path.join(OUT, `round8-${monthKey(snapshot)}-figures.json`), JSON.stringify(figures, null, 2));
}

function writePayloads(workbooks: readonly MonthReport[]): void {
  for (const w of workbooks) {
    writeFileSync(path.join(OUT, `${w.fileName.replace(/\.xlsx$/u, '')}.payload.json`), JSON.stringify(w.payload));
  }
}

async function render(workbooks: readonly MonthReport[]): Promise<void> {
  const { fetchWorkbook } = await import('../src/lib/exportService.ts');
  for (const w of workbooks) {
    const blob = await fetchWorkbook(w.payload);
    writeFileSync(path.join(OUT, w.fileName), Buffer.from(await blob.arrayBuffer()));
    console.log(`wrote ${w.fileName}`);
  }
}

async function main(): Promise<void> {
  let snapshot: MonthSnapshot;
  let deps: RunDeps = OFFLINE_DEPS;
  let session: AppClient | null = null;
  if (args.mode === 'fetch' || args.render) session = await stagingSession();
  if (args.mode === 'fetch') {
    ({ snapshot, deps } = await fetchSnapshot(session!));
  } else {
    snapshot = readSnapshot(args.inputs!);
  }

  const outcome = await runMonth(snapshot, deps);
  const inputsFile = path.join(OUT, `round8-${monthKey(snapshot)}-inputs.json`);
  if (args.mode === 'fetch') {
    // Kept on a refusal too, so the refusal can be read; with the route cache when the run got that far.
    writeFileSync(inputsFile, JSON.stringify({ ...snapshot, storage: outcome.ok ? outcome.storage : snapshot.storage }));
    console.log(`wrote ${path.basename(inputsFile)}`);
  }
  if (!outcome.ok) fail(4, `month ${monthKey(snapshot)} refused at ${outcome.stage}: ${outcome.reason}`);
  summarize(snapshot, outcome);
  writeFigures(snapshot, outcome);
  writePayloads(outcome.workbooks);
  if (session) await render(outcome.workbooks);
}

await main();
