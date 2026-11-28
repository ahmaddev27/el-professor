/**
 * The "before" half of Round 8's before/after comparison (§13 item 14): the
 * same month, from the same snapshot and seed, built by the generator as
 * Round 8 found it.
 *
 * It runs INSIDE a checkout of that commit, so every `src/` module it loads is
 * the old one; it refuses to run anywhere else, because in this branch it would
 * build the new month and call it the old one. From this branch's checkout:
 *
 *   git worktree add --detach <dir> c1de16a6eb22bc80f79699b3c7e24561fbcd89d1
 *   cp scripts/fleetbook-round8-before.mts <dir>/scripts/
 *   cp scripts/lib/round8Figures.mts <dir>/scripts/lib/
 *   ln -s "$PWD/node_modules" <dir>/node_modules   # package.json and the lock are identical
 *   (cd <dir> && npx vite-node scripts/fleetbook-round8-before.mts \
 *      --from-inputs <out>/round8-2026-09-inputs.json --out <out>)
 *   git worktree remove --force <dir>
 *
 * It writes `before/<workbook>.payload.json` (the old screen's two workbooks),
 * `before-YYYY-MM-figures.json`, and, when `round8-YYYY-MM-figures.json` from
 * `fleetbook-round8-month.mts` is already in <out>, `vorher-nachher-YYYY-MM.md`.
 * No network: the route cache comes from the snapshot, and the clients refuse.
 *
 * The old screen is followed in everything but one point, which the comparison
 * states: without a saved Betriebssitz it started the shifts in the middle of
 * the address pool, and the snapshot holds no routes from there, so it is given
 * the same starting point as the new run and the difference shown is the
 * generator's. Its calendar form is its own default, as the old screen showed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compareFigures, monthFigures, type MonthFigures } from './lib/round8Figures.mts';

const BEFORE_COMMIT = 'c1de16a6eb22bc80f79699b3c7e24561fbcd89d1';
const REPO = path.resolve(import.meta.dirname, '..');

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
if (head !== BEFORE_COMMIT) fail(2, `run this inside a checkout of ${BEFORE_COMMIT} (this one is ${head}); see the header`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const inputs = arg('from-inputs');
const outArg = arg('out');
if (!inputs || !outArg) fail(2, 'give --from-inputs <round8-YYYY-MM-inputs.json> and --out <dir>');
const OUT = path.resolve(outArg);

/** The snapshot as `scripts/lib/round8Month.mts` writes it, read structurally: no type from the new tree. */
interface Snapshot {
  version: number;
  fetchedAt: string;
  company: { id: string; name: string };
  year: number;
  month: number;
  seed: number;
  city: string;
  form: Record<string, unknown>;
  cars: { id: string; plate: string; tuev: string | null }[];
  carIds: string[];
  drivers: { id: string; name: string }[];
  base: { ok: true; base: { lat: number; lon: number }; source: string; label: string } | { ok: false; reason: string };
  events: {
    notes: [string, unknown[]][];
    facts: [string, { allowed_weekdays?: number[] | null; planning_enabled?: boolean | null }][];
    checks: unknown[];
  };
  allowEstimate: boolean;
  storage: Record<string, string>;
}

const snapshot = JSON.parse(readFileSync(inputs, 'utf8')) as Snapshot;
if (snapshot.version !== 1) fail(2, `snapshot version ${snapshot.version}; this script reads 1`);
if (snapshot.company.name !== 'DEMO Monatsplanung GmbH') fail(3, 'not a snapshot of DEMO Monatsplanung GmbH');
if (!snapshot.base.ok) fail(4, `the new run had no base (${snapshot.base.reason}); there is nothing to compare`);
const monthKey = `${snapshot.year}-${String(snapshot.month).padStart(2, '0')}`;

const refuse = (what: string) => async () => { throw new Error(`replay: ${what} is not in the snapshot`); };

async function main(): Promise<void> {
  const [{ readCachedPool }, { prepareRouting }, { DEFAULT_CALENDAR_FORM, parseCalendarForm }, { generateFullMonth }, { verifyMonth }, { buildMonthReport }, { buildOperationalReport }] = await Promise.all([
    import('../src/utils/simulatedRides/addressPool.ts'),
    import('../src/lib/simulationRouting.ts'),
    import('../src/utils/simulatedRides/calendarForm.ts'),
    import('../src/utils/simulatedRides/fullMonth.ts'),
    import('../src/utils/simulatedRides/monthVerification.ts'),
    import('../src/utils/simulatedRides/monthWorkbook.ts'),
    import('../src/utils/simulatedRides/operationalReport.ts'),
  ]);
  const now = new Date(snapshot.fetchedAt);
  const items = new Map(Object.entries(snapshot.storage));
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); } };

  const pool = readCachedPool(snapshot.city, storage, now);
  if (!pool) fail(4, 'the address pool is not in the snapshot');
  const origin = snapshot.base.base;
  const routing = await prepareRouting({
    pool: pool.addresses, base: origin,
    deps: { geocoder: { geocode: refuse('an address check') }, router: { route: refuse('a route') }, storage, now: () => now, sleep: async () => {} },
  });
  if (!routing.ok && !snapshot.allowEstimate) fail(4, `routing: ${routing.reason}`);
  const sourcing = routing.ok
    ? { points: routing.points, travel: routing.model, provenance: routing.provenance }
    : { points: pool.addresses, travel: undefined, provenance: null };

  const form = parseCalendarForm(DEFAULT_CALENDAR_FORM);
  if (!form.ok) fail(4, 'the old default form does not parse');
  const facts = new Map(snapshot.events.facts);
  // The old screen's mapping, as it stood at BEFORE_COMMIT (SimulatedRidesPage, generateCalendar).
  const outcome = generateFullMonth({
    year: snapshot.year, month: snapshot.month, base: origin, pool: sourcing.points, seed: snapshot.seed,
    vehicles: snapshot.cars.filter(c => snapshot.carIds.includes(c.id)).map(c => ({ id: c.id, plate: c.plate, type: 'Mietwagen', tuev_gueltig_bis: c.tuev })),
    drivers: snapshot.drivers.map(d => ({
      id: d.id, name: d.name,
      allowed_weekdays: facts.get(d.id)?.allowed_weekdays ?? null, planning_enabled: facts.get(d.id)?.planning_enabled ?? true,
    })),
    driverNotesMap: new Map(snapshot.events.notes) as never, werkstattChecks: snapshot.events.checks as never,
    settings: form.settings, options: form.options, shiftsPerVehicleDay: form.shiftsPerVehicleDay,
    travel: sourcing.travel, routing: sourcing.provenance ?? undefined, tenantId: snapshot.company.id,
  });
  if (!outcome.ok) fail(4, `the old generator refused the month: ${JSON.stringify(outcome.failure)}`);
  const verification = verifyMonth(outcome.result);

  mkdirSync(path.join(OUT, 'before'), { recursive: true });
  for (const w of [buildMonthReport(outcome.result, verification), buildOperationalReport(outcome.result, verification)]) {
    writeFileSync(path.join(OUT, 'before', `${w.fileName.replace(/\.xlsx$/u, '')}.payload.json`), JSON.stringify(w.payload));
  }
  const before = monthFigures(
    { label: `Generator vor Round 8 (${BEFORE_COMMIT.slice(0, 7)})`, month: monthKey, seed: snapshot.seed, base: snapshot.base.label },
    outcome.result as never, verification as never,
  );
  writeFileSync(path.join(OUT, `before-${monthKey}-figures.json`), JSON.stringify(before, null, 2));
  console.log(`before ${monthKey}: verdict ${verification.verdict}, rides ${outcome.result.month.rides.length}, shifts ${outcome.result.month.shifts.length}`);

  const afterFile = path.join(OUT, `round8-${monthKey}-figures.json`);
  if (!existsSync(afterFile)) { console.log(`no ${path.basename(afterFile)} yet; the comparison is written once it exists`); return; }
  const after = JSON.parse(readFileSync(afterFile, 'utf8')) as MonthFigures;
  writeFileSync(path.join(OUT, `vorher-nachher-${monthKey}.md`), compareFigures(before, after, inputNotes(DEFAULT_CALENDAR_FORM as unknown as Record<string, unknown>)));
  console.log(`wrote vorher-nachher-${monthKey}.md`);
}

/** What the two runs were given differently, in words. */
function inputNotes(oldForm: Record<string, unknown>): string[] {
  const notes: string[] = [];
  for (const key of Object.keys(snapshot.form).sort()) {
    if (!(key in oldForm)) notes.push(`Formularfeld \`${key}\` gibt es nur nachher (${JSON.stringify(snapshot.form[key])}).`);
    else if (JSON.stringify(oldForm[key]) !== JSON.stringify(snapshot.form[key])) {
      notes.push(`Formularfeld \`${key}\`: vorher ${JSON.stringify(oldForm[key])}, nachher ${JSON.stringify(snapshot.form[key])} (jeweils die Vorgabe des Bildschirms).`);
    }
  }
  if (snapshot.base.ok && snapshot.base.source !== 'saved_point') {
    notes.push('Ohne gespeicherten Betriebssitz begann der alte Bildschirm die Schichten in der Mitte des Adresspools. Für den Vergleich beginnt auch der alte Generator am Startpunkt des neuen Laufs, damit die Abweichung die des Generators ist.');
  }
  notes.push('Vorher kannte der Generator keine Stundenspanne je Fahrer, keine Uber-Zahlen, keine importierten Fahrten, keine Fahrzeug-Sperrzeiten und keine Firmeneinstellung zur Rückkehr; nachher liest er sie (Round 8, S2–S8).');
  return notes;
}

await main();
