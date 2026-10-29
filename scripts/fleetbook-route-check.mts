/**
 * Re-checks the drive between consecutive rides with our own services.
 *
 *   npx vite-node scripts/fleetbook-route-check.mts --evidence <auditor.csv> [--warnings <60 pairs.csv>] [--out <dir>]
 *   npx vite-node scripts/fleetbook-route-check.mts --rides <sheet.xlsx> [--out <dir>]
 *   options: --backend staging|valhalla (default staging; --valhalla <url> adds a second engine)
 *
 * Geocoding and routing go ONLY through our staging edge functions
 * `geocode-address` and `travel-route` (ridy's Nominatim and OSRM sit behind
 * them; nothing here may contact that server any other way). One call at a
 * time, at most 50 addresses or 100 pairs per call, 250 ms between calls, one
 * retry after 5 s for an infrastructure failure. Answers are cached as JSON in
 * the output directory so a re-run asks nothing it already knows.
 *
 * Credentials come from e2e/.env.local and are never printed or written. The
 * outputs hold real data (addresses, names): keep --out OUTSIDE the repository.
 * Driver and vehicle names are replaced by D01.. / V1.. in every output; the
 * mapping is written to names-mapping.local.csv, which must never leave the machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { addressKey, parseGeocodeResponse, INFRASTRUCTURE_REASONS, MAX_ADDRESSES_PER_CALL, type GeocodeResult } from '../supabase/functions/_shared/geocode-core.ts';
import { parseRouteResponse, MAX_PAIRS_PER_CALL, type RouteResult } from '../supabase/functions/_shared/travel-route-core.ts';
import { deadheadSeconds, roadKm } from '../src/utils/simulatedRides/geo.ts';
import {
  buildTransitions, causeClass, classifyTransition, csvLine, parseCsv, percentile, wallHour, wallMs,
  type AuditRide, type GeocodeLookup, type RouteLookup, type Transition,
} from './lib/routeAudit.mts';

// Outside the repository by default: the output holds the checked addresses, and this repository is public.
const SCRATCH = process.env.ROUTE_CHECK_OUT_ROOT ?? path.join(tmpdir(), 'fleetbook-route-check');
const PAUSE_MS = 250;
const RETRY_MS = 5000;

// -- arguments ------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const evidencePath = arg('evidence');
const ridesPath = arg('rides');
const warningsPath = arg('warnings');
const valhallaUrl = arg('valhalla');
if ((evidencePath === undefined) === (ridesPath === undefined)) {
  console.error('give exactly one of --evidence <csv> or --rides <xlsx>');
  process.exit(2);
}
const name = path.basename((evidencePath ?? ridesPath)!).replace(/\.[^.]+$/u, '').replace(/[^\w-]+/gu, '_');
const OUT = arg('out') ?? `${SCRATCH}/round4/route-check/${name}`;
if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(import.meta.dirname, '..').toLowerCase() + path.sep) && !path.resolve(OUT).includes('scratchpad')) {
  console.error('refusing an output directory inside the repository');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// -- staging access -------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const text = readFileSync(path.resolve(import.meta.dirname, '../e2e/.env.local'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const m = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/gu, '');
  }
  return out;
}
const env = loadEnv();
const API = env.E2E_API_URL;
const ANON = env.E2E_ANON_KEY;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastCallAt = 0;
let token = '';
// E2E_STAGING_USER is the staging site's HTTP basic-auth name, not a GoTrue login: the accounts are the DEMO one and the e2e company admin.
type Account = 'demo' | 'e2e-admin';
let account: Account = 'demo';

async function plainFetch(url: string, init: RequestInit, timeoutMs = 60_000): Promise<{ status: number; body: unknown }> {
  const wait = lastCallAt + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    lastCallAt = Date.now();
  }
}

async function signIn(which: Account): Promise<boolean> {
  const email = which === 'demo' ? env.E2E_DEMO_EMAIL : env.E2E_ADMIN_EMAIL;
  const password = which === 'demo' ? env.E2E_DEMO_PASSWORD : env.E2E_ADMIN_PASSWORD;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const { status, body } = await plainFetch(`${API}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const t = (body as { access_token?: string } | undefined)?.access_token;
      if (status === 200 && typeof t === 'string') { token = t; account = which; return true; }
      if (status < 500 && status !== 429) return false;
    } catch { /* flaky network: retry */ }
    await sleep(RETRY_MS * (attempt + 1));
  }
  return false;
}

/** One call to an edge function; a network failure or 5xx is retried (patiently: the link is flaky). */
async function callFunction(fn: string, payload: unknown): Promise<{ status: number; body: unknown } | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const r = await plainFetch(`${API}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { apikey: ANON, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 401 && attempt < 2 && (await signIn(account))) continue;
      if (r.status !== 429 && r.status < 500) return r;
    } catch { /* network */ }
    await sleep(RETRY_MS * (attempt + 1));
  }
  return null;
}

// -- caches ---------------------------------------------------------------------

function loadCache<T>(file: string): Record<string, T> {
  const p = path.join(OUT, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, T>) : {};
}
const saveCache = (file: string, data: unknown) => writeFileSync(path.join(OUT, file), JSON.stringify(data));
const geoCache = loadCache<GeocodeLookup>('geocode-cache.json');
const routeCache = loadCache<RouteLookup>('osrm-cache.json');
const valhallaCache = loadCache<RouteLookup>('valhalla-cache.json');

const toLookup = (r: GeocodeResult): GeocodeLookup =>
  r.kind === 'located' ? { kind: 'located', lat: r.lat, lon: r.lon } : { kind: 'unlocated', reason: r.reason };

async function geocodeAll(texts: readonly string[]): Promise<void> {
  const todo = new Map<string, string>();
  for (const t of texts) if (!(addressKey(t) in geoCache)) todo.set(addressKey(t), t);
  for (let pass = 0; pass < 2 && todo.size > 0; pass += 1) {
    if (pass === 1) { console.log(`retrying ${todo.size} infrastructure failures after ${RETRY_MS} ms`); await sleep(RETRY_MS); }
    const entries = [...todo.entries()];
    for (let i = 0; i < entries.length; i += MAX_ADDRESSES_PER_CALL) {
      const chunk = entries.slice(i, i + MAX_ADDRESSES_PER_CALL);
      const r = await callFunction('geocode-address', { addresses: chunk.map(([, text], k) => ({ id: `a${k}`, text })) });
      const answer = r === null ? null : parseGeocodeResponse(r.status, r.body);
      if (answer === null || !answer.ok) {
        console.log(`geocode call failed (${answer === null ? 'network' : answer.reason}) for ${chunk.length} addresses`);
        if (answer !== null && answer.reason === 'no_company' && account === 'demo' && (await signIn('e2e-admin'))) { i -= MAX_ADDRESSES_PER_CALL; console.log('using the e2e admin account'); }
        continue;
      }
      const byId = new Map(answer.results.map((x) => [x.id, x]));
      chunk.forEach(([key], k) => {
        const res = byId.get(`a${k}`);
        if (res === undefined) return;
        const infra = res.kind === 'unlocated' && INFRASTRUCTURE_REASONS.has(res.reason);
        if (infra && pass === 0) return;
        geoCache[key] = toLookup(res);
        todo.delete(key);
      });
      saveCache('geocode-cache.json', geoCache);
      console.log(`geocoded ${Object.keys(geoCache).length} addresses (${todo.size} open)`);
    }
  }
}

const pointKey = (p: { lat: number; lon: number }) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
const INFRA_ROUTE = new Set(['timeout', 'unreachable', 'service_error', 'bad_answer', 'request_rejected']);

async function routeAll(pairs: ReadonlyMap<string, [GeocodeLookup & { kind: 'located' }, GeocodeLookup & { kind: 'located' }]>): Promise<void> {
  const todo = new Map([...pairs].filter(([k]) => !(k in routeCache)));
  for (let pass = 0; pass < 2 && todo.size > 0; pass += 1) {
    if (pass === 1) { console.log(`retrying ${todo.size} route failures after ${RETRY_MS} ms`); await sleep(RETRY_MS); }
    const entries = [...todo.entries()];
    for (let i = 0; i < entries.length; i += MAX_PAIRS_PER_CALL) {
      const chunk = entries.slice(i, i + MAX_PAIRS_PER_CALL);
      const r = await callFunction('travel-route', {
        pairs: chunk.map(([, [from, to]], k) => ({ id: `p${k}`, from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon } })),
      });
      const answer = r === null ? null : parseRouteResponse(r.status, r.body);
      if (answer === null || !answer.ok) { console.log(`route call failed (${answer === null ? 'network' : answer.reason})`); continue; }
      const byId = new Map<string, RouteResult>(answer.results.map((x) => [x.id, x]));
      chunk.forEach(([key], k) => {
        const res = byId.get(`p${k}`);
        if (res === undefined) return;
        if (res.kind === 'unavailable' && INFRA_ROUTE.has(res.reason) && pass === 0) return;
        routeCache[key] = res.kind === 'route'
          ? { kind: 'route', seconds: res.durationSeconds, km: res.distanceMeters / 1000 }
          : { kind: 'unavailable', reason: res.reason };
        todo.delete(key);
      });
      saveCache('osrm-cache.json', routeCache);
      console.log(`routed ${Object.keys(routeCache).length} pairs (${todo.size} open)`);
    }
  }
}

async function valhallaAll(pairs: ReadonlyMap<string, [GeocodeLookup & { kind: 'located' }, GeocodeLookup & { kind: 'located' }]>): Promise<void> {
  if (valhallaUrl === undefined) return;
  for (const [key, [from, to]] of pairs) {
    if (key in valhallaCache) continue;
    try {
      const r = await plainFetch(`${valhallaUrl.replace(/\/$/u, '')}/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], costing: 'auto' }),
      });
      const summary = (r.body as { trip?: { summary?: { time?: number; length?: number } } } | undefined)?.trip?.summary;
      valhallaCache[key] = r.status === 200 && summary && Number.isFinite(summary.time) && Number.isFinite(summary.length)
        ? { kind: 'route', seconds: summary.time!, km: summary.length! }
        : { kind: 'unavailable', reason: `http_${r.status}` };
    } catch {
      valhallaCache[key] = { kind: 'unavailable', reason: 'unreachable' };
    }
  }
  saveCache('valhalla-cache.json', valhallaCache);
}

// -- inputs ---------------------------------------------------------------------

interface AuditorRow { readonly grouping: string; readonly status: string; readonly seconds: number; readonly km: number }
const auditorByTransition = new Map<Transition, AuditorRow>();

function transitionsFromEvidence(file: string): Transition[] {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const head = rows[0];
  const col = (n: string) => head.indexOf(n);
  return rows.slice(1).map((r) => {
    const t: Transition = {
      grouping: r[col('Grouping')] === 'driver' ? 'driver' : 'vehicle',
      group: r[col('Group')],
      prevNr: +r[col('PreviousLine')],
      nextNr: +r[col('NextLine')],
      prevEnd: r[col('PreviousEnd')],
      nextStart: r[col('NextStart')],
      availableSeconds: +r[col('AvailableSeconds')],
      fromText: r[col('PreviousDropoff')],
      toText: r[col('NextPickup')],
    };
    auditorByTransition.set(t, {
      grouping: t.grouping,
      status: r[col('Status')],
      seconds: r[col('EstimatedRoadSeconds')] === '' ? Number.NaN : +r[col('EstimatedRoadSeconds')],
      km: r[col('RoadKilometers')] === '' ? Number.NaN : +r[col('RoadKilometers')],
    });
    return t;
  });
}

function cellMs(v: unknown): number {
  if (typeof v === 'number') return Math.round((v - 25569) * 86_400_000);
  if (typeof v !== 'string') return Number.NaN;
  const german = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(v.trim());
  if (german) return Date.UTC(+german[3], +german[2] - 1, +german[1], +german[4], +german[5], +(german[6] ?? 0));
  return wallMs(v);
}

function ridesFromWorkbook(file: string): AuditRide[] {
  const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => /^A\b/u.test(n) || /Fahrten/u.test(n)) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true });
  const headAt = rows.findIndex((r) => r.includes('Abholort'));
  if (headAt < 0) throw new Error(`no header row with "Abholort" in sheet ${sheetName}`);
  const head = rows[headAt] as string[];
  const at = (n: string) => head.indexOf(n);
  const need = ['Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes', 'Kennzeichen', 'Fahrername', 'Abholort', 'Zielort', 'Fahrtstatus'];
  for (const n of need) if (at(n) < 0) throw new Error(`column "${n}" missing in sheet ${sheetName}`);
  return rows.slice(headAt + 1).filter((r) => r.length > 0).map((r, i) => ({
    nr: i + 1,
    startMs: cellMs(r[at('Uhrzeit des Fahrtbeginns')]),
    endMs: cellMs(r[at('Uhrzeit des Fahrtendes')]),
    vehicle: String(r[at('Kennzeichen')] ?? ''),
    driver: String(r[at('Fahrername')] ?? ''),
    pickup: String(r[at('Abholort')] ?? ''),
    dropoff: String(r[at('Zielort')] ?? ''),
    cancelled: /storn|cancel|abgebrochen/iu.test(String(r[at('Fahrtstatus')] ?? '')),
  }));
}

// -- pseudonyms -----------------------------------------------------------------

const pseudo = new Map<string, string>();
function alias(grouping: string, group: string): string {
  const key = `${grouping}|${group}`;
  if (!pseudo.has(key)) {
    const n = [...pseudo.keys()].filter((k) => k.startsWith(`${grouping}|`)).length + 1;
    pseudo.set(key, grouping === 'driver' ? `D${String(n).padStart(2, '0')}` : `V${n}`);
  }
  return pseudo.get(key)!;
}

// -- main -----------------------------------------------------------------------

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');

async function main(): Promise<void> {
  const transitions = evidencePath !== undefined ? transitionsFromEvidence(evidencePath) : buildTransitions(ridesFromWorkbook(ridesPath!));
  console.log(`${transitions.length} transitions`);
  if (!(await signIn('demo'))) { console.error('sign-in to staging failed (network or credentials)'); process.exit(3); }

  const texts = [...new Set(transitions.flatMap((t) => [t.fromText, t.toText]))];
  await geocodeAll(texts);
  const geo = (text: string): GeocodeLookup | undefined => geoCache[addressKey(text)];

  const pairs = new Map<string, [GeocodeLookup & { kind: 'located' }, GeocodeLookup & { kind: 'located' }]>();
  const keyOf = (t: Transition): string | null => {
    const a = geo(t.fromText);
    const b = geo(t.toText);
    if (a?.kind !== 'located' || b?.kind !== 'located' || addressKey(t.fromText) === addressKey(t.toText)) return null;
    const key = `${pointKey(a)}>${pointKey(b)}`;
    pairs.set(key, [a, b]);
    return key;
  };
  const keys = transitions.map(keyOf);
  await routeAll(pairs);
  await valhallaAll(pairs);

  const rows = transitions.map((t, i) => {
    const key = keys[i];
    const osrm = key === null ? undefined : routeCache[key];
    const result = classifyTransition(t, geo(t.fromText), geo(t.toText), osrm);
    const val = key === null ? undefined : valhallaCache[key];
    return { t, key, osrm, val, result, auditor: auditorByTransition.get(t) };
  });

  // -- CSV out
  const head = ['Grouping', 'Group', 'PrevNr', 'NextNr', 'PrevEnd', 'NextStart', 'AvailableSeconds', 'Status', 'Reason', 'OsrmSeconds', 'OsrmKm', 'MarginSeconds',
    'AuditorStatus', 'AuditorSeconds', 'AuditorKm', 'ValhallaSeconds', 'ValhallaKm', 'OsrmOverAuditor', 'AbsDiffSeconds', 'Dropoff', 'Pickup'];
  const lines = [csvLine(head)];
  const ratios: number[] = [];
  const diffs: number[] = [];
  const longRatios: number[] = [];
  for (const { t, osrm, result, auditor, val } of rows) {
    const aSec = auditor?.seconds ?? (val?.kind === 'route' ? val.seconds : Number.NaN);
    const aKm = auditor?.km ?? (val?.kind === 'route' ? val.km : Number.NaN);
    const both = osrm?.kind === 'route' && aSec >= 1 && Number.isFinite(aSec);
    const ratio = both ? osrm.seconds / aSec : Number.NaN;
    if (both) {
      ratios.push(ratio);
      diffs.push(Math.abs(osrm.seconds - aSec));
      if (aKm >= 1) longRatios.push(ratio);
    }
    lines.push(csvLine([t.grouping, alias(t.grouping, t.group), t.prevNr, t.nextNr, t.prevEnd, t.nextStart, t.availableSeconds, result.status, result.reason,
      result.roadSeconds, result.roadKm, result.marginSeconds, auditor?.status, f1(aSec), f1(aKm),
      val?.kind === 'route' ? Math.round(val.seconds) : '', val?.kind === 'route' ? f1(val.km) : '',
      Number.isFinite(ratio) ? ratio.toFixed(3) : '', both ? Math.abs(osrm.seconds - aSec).toFixed(0) : '', t.fromText, t.toText]));
  }
  writeFileSync(path.join(OUT, 'transitions.csv'), `\uFEFF${lines.join('\r\n')}\r\n`);

  // -- summary
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  const md: string[] = [`# Route check: ${name}`, '', `Account used: ${account}. Engine: OSRM via travel-route${valhallaUrl ? ' plus Valhalla' : ''}. All road times are free-flow ESTIMATES.`, '',
    `Transitions: ${rows.length}. Distinct addresses: ${texts.length}. Distinct routed point pairs: ${pairs.size}.`, '',
    '## Our status', '```', JSON.stringify(count(rows.map((r) => r.result.status))), '```'];
  const geoReasons = count(texts.map((x) => { const g = geo(x); return g === undefined ? 'not_answered' : g.kind === 'located' ? 'located' : g.reason; }));
  md.push('', '## Addresses (A)', '```', JSON.stringify(geoReasons), '```');

  if (evidencePath !== undefined) {
    const unv = rows.filter((r) => r.auditor?.status === 'UNVERIFIED');
    const bothLocated = unv.filter((r) => geo(r.t.fromText)?.kind === 'located' && geo(r.t.toText)?.kind === 'located' || addressKey(r.t.fromText) === addressKey(r.t.toText));
    const rest = unv.filter((r) => !bothLocated.includes(r)).map((r) => r.result.reason);
    md.push('', `Auditor UNVERIFIED checks: ${unv.length}. Now resolved (both ends located, or same address): ${bothLocated.length}.`,
      `Not resolved by reason: ${JSON.stringify(count(rest))}`,
      `Our status of those 244: ${JSON.stringify(count(unv.map((r) => r.result.status)))}`);
    const sec = (xs: number[], p: number) => percentile(xs, p).toFixed(3);
    md.push('', '## OSRM against the auditor\'s engine (B)', `Rows with both: ${ratios.length}.`,
      `Ratio OSRM/auditor seconds: median ${sec(ratios, 0.5)}, p10 ${sec(ratios, 0.1)}, p90 ${sec(ratios, 0.9)}.`,
      `Same for auditor routes of 1 km or more (${longRatios.length} rows): median ${sec(longRatios, 0.5)}, p10 ${sec(longRatios, 0.1)}, p90 ${sec(longRatios, 0.9)}.`,
      `Absolute difference seconds: median ${sec(diffs, 0.5)}, p10 ${sec(diffs, 0.1)}, p90 ${sec(diffs, 0.9)}, max ${Math.max(...diffs).toFixed(0)}.`);
    const kmRatios = rows.filter((r) => r.osrm?.kind === 'route' && r.auditor && r.auditor.km >= 1).map((r) => (r.osrm as { km: number }).km / r.auditor!.km);
    md.push(`Ratio OSRM/auditor kilometres (auditor 1 km or more, ${kmRatios.length} rows): median ${sec(kmRatios, 0.5)}, p10 ${sec(kmRatios, 0.1)}, p90 ${sec(kmRatios, 0.9)}.`);
    const warnPath = warningsPath ?? path.resolve(path.dirname(evidencePath), '../FleetBook_60_Unique_Routing_Warnings.csv');
    if (existsSync(warnPath)) md.push(...warnedPairs(warnPath, rows));
  }
  writeFileSync(path.join(OUT, 'summary.md'), `${md.join('\n')}\n`);
  writeFileSync(path.join(OUT, 'names-mapping.local.csv'), `${csvLine(['alias', 'real'])}\r\n${[...pseudo].map(([k, v]) => csvLine([v, k])).join('\r\n')}\r\n`);
  console.log(md.join('\n'));
}

function warnedPairs(file: string, rows: readonly { t: Transition; osrm?: RouteLookup }[]): string[] {
  const parsed = parseCsv(readFileSync(file, 'utf8'));
  const h = parsed[0];
  const c = (n: string) => h.indexOf(n);
  const out: string[] = [];
  const causes: string[] = [];
  const csv = [csvLine(['IssueID', 'Vehicle', 'PrevNr', 'NextNr', 'FromGeocode', 'ToGeocode', 'AvailableSeconds', 'AuditorSeconds', 'AuditorKm', 'OsrmSeconds', 'OsrmKm', 'ModelSeconds', 'Cause'])];
  for (const r of parsed.slice(1)) {
    const [prev, next, vehicle] = [+r[c('PreviousLine')], +r[c('NextLine')], r[c('Vehicle')]];
    const row = rows.find((x) => x.t.grouping === 'vehicle' && x.t.group === vehicle && x.t.prevNr === prev && x.t.nextNr === next);
    const from = geoCache[addressKey(r[c('PreviousDropoff')])];
    const to = geoCache[addressKey(r[c('NextPickup')])];
    const fl = from?.kind === 'located';
    const tl = to?.kind === 'located';
    const hour = row === undefined ? Number.NaN : wallHour(row.t.prevEnd);
    const model = fl && tl && Number.isFinite(hour) ? deadheadSeconds(roadKm(from, to), hour) : null;
    const osrm = row?.osrm?.kind === 'route' ? row.osrm : undefined;
    const available = +r[c('AvailableSeconds')];
    const cause = causeClass({ availableSeconds: available, fromLocated: fl, toLocated: tl, modelSeconds: model, engineSeconds: osrm?.seconds ?? null });
    causes.push(cause);
    csv.push(csvLine([r[c('IssueID')], alias('vehicle', vehicle), prev, next, fl ? 'located' : (from as { reason?: string } | undefined)?.reason ?? 'not_answered',
      tl ? 'located' : (to as { reason?: string } | undefined)?.reason ?? 'not_answered', available, r[c('EstimatedRoadSeconds')], r[c('RoadKilometers')],
      osrm ? Math.round(osrm.seconds) : '', osrm ? f1(osrm.km) : '', model ?? '', cause]));
  }
  writeFileSync(path.join(OUT, 'warned-60.csv'), `\uFEFF${csv.join('\r\n')}\r\n`);
  const tally = causes.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  out.push('', '## The warned pairs (C)', `Pairs: ${causes.length}. Cause classes: ${JSON.stringify(tally)}`, 'Per-pair rows: warned-60.csv.');
  return out;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
