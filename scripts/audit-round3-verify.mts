/**
 * Read the delivered workbook back and re-sum it, from the file's own bytes.
 *
 *   npx vite-node scripts/audit-round3-verify.mts
 *
 * Section 7 of the external audit asks for exactly this and names the way it
 * must be done: "لا تختبر فقط عينة أول الصفوف: اقرأ كل أوراق العمل الظاهرة
 * والمخفية وكل الصفوف وأعد جمع الإيرادات على نحو مستقل من ناتج الملف نفسه" —
 * do not test only the first rows; read every visible and hidden worksheet and
 * every row, and re-sum the revenue **independently, from the file's own
 * output**.
 *
 * So this script imports nothing from the generator. It opens the `.xlsx`,
 * walks every sheet the workbook declares including hidden ones, reads every
 * row of each, and adds the money up in **integer cents** by its own
 * arithmetic. Then it compares the four places the same figure appears:
 *
 *   - the sum over sheet A, ride by ride
 *   - the `Summe` row of sheet B, and the sum of B's own day rows
 *   - the `Summe` rows of sheets C and D
 *   - the basis and the share on sheet F
 *
 * A figure that only agrees with itself proves nothing, which is why the
 * comparison is between sheets rather than against a number this script was
 * told. It exits non-zero on the first disagreement.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const DIR = path.resolve(import.meta.dirname, '../Docs/audit/round3');

const file = readdirSync(DIR).find(f => f.endsWith('.xlsx'));
if (!file) {
  console.error(`no .xlsx in ${DIR} — run scripts/audit-round3-deliverables.mts first`);
  process.exit(1);
}

const bytes = readFileSync(path.join(DIR, file));
const wb = XLSX.read(bytes, { type: 'buffer' });

/** Every sheet the workbook declares, hidden ones included. */
const hidden = new Set((wb.Workbook?.Sheets ?? []).filter(s => s.Hidden).map(s => s.name));
const sheetNames = wb.SheetNames;

const problems: string[] = [];
const say = (ok: boolean, what: string, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${detail}`);
  if (!ok) problems.push(`${what} — ${detail}`);
};

/** A sheet as an array of rows of raw cell values, header included. */
const rowsOf = (name: string): unknown[][] =>
  XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });

/**
 * A euro cell to integer cents. The cells are written as numbers, so this is
 * the one conversion, done once, half away from zero — summing the floats
 * would drift and the drift would look like a reconciliation failure.
 */
function cents(cell: unknown): number {
  if (cell === null || cell === '' || cell === undefined) return 0;
  const n = typeof cell === 'number' ? cell : Number(String(cell).replace(',', '.'));
  if (!Number.isFinite(n)) return NaN;
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

const column = (header: unknown[], label: string): number => header.findIndex(h => String(h ?? '') === label);

console.log(`file      ${file} (${bytes.length} bytes)`);
console.log(`sheets    ${sheetNames.length}: ${sheetNames.join(' | ')}`);
console.log(`hidden    ${hidden.size === 0 ? 'none' : [...hidden].join(' | ')}`);
console.log('');

// Every sheet is read in full, and the row counts are printed so a truncated
// read is visible rather than silent.
const all = new Map<string, unknown[][]>();
for (const name of sheetNames) {
  const rows = rowsOf(name);
  all.set(name, rows);
  console.log(`read      ${name}: ${rows.length} rows x ${Math.max(0, ...rows.map(r => r.length))} columns`);
}
console.log('');

// ── Sheet A, ride by ride ──────────────────────────────────────────────────
const A = all.get('A Fahrten');
if (!A) {
  console.error('sheet "A Fahrten" is missing');
  process.exit(1);
}
const aHead = A[0];
const iStatus = column(aHead, 'Status');
const iFare = column(aHead, 'Fahrpreis (EUR)');
const iTip = column(aHead, 'Trinkgeld (EUR)');
const iFee = column(aHead, 'Gebuehr (EUR)');
const iDay = column(aHead, 'Datum der Fahrt');
const iDriver = column(aHead, 'Fahrer');
const iPlate = column(aHead, 'Kennzeichen');

let fareA = 0;
let tipA = 0;
let feeA = 0;
const byStatus = new Map<string, number>();
const byDay = new Map<string, number>();
const byDriver = new Map<string, number>();
const byPlate = new Map<string, number>();
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

for (const row of A.slice(1)) {
  const status = String(row[iStatus] ?? '');
  const fare = cents(row[iFare]);
  const tip = cents(row[iTip]);
  const fee = cents(row[iFee]);
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  fareA += fare;
  tipA += tip;
  feeA += fee;
  add(byDay, String(row[iDay] ?? ''), fare);
  add(byDriver, String(row[iDriver] ?? ''), fare);
  add(byPlate, String(row[iPlate] ?? ''), fare);

  // Every ride must obey the rule the audit's section 3 asks for, read off the
  // file rather than trusted: a fare belongs to a completed ride and a fee does
  // not, and a declined ride is the other way round.
  if (status === 'abgeschlossen' && fee !== 0) problems.push(`a completed ride carries a fee: ${JSON.stringify(row)}`);
  if (status === 'abgelehnt' && (fare !== 0 || tip !== 0)) problems.push(`a declined ride carries a fare or a tip: ${JSON.stringify(row)}`);
}

say(A.length - 1 > 0, 'sheet A holds rides', `${A.length - 1} rows`);
say(
  (byStatus.get('abgelehnt') ?? 0) > 0,
  'sheet A holds declined rides, so the DECLINED checks are not vacuous',
  `abgeschlossen ${byStatus.get('abgeschlossen') ?? 0}, abgelehnt ${byStatus.get('abgelehnt') ?? 0}, storniert ${byStatus.get('storniert') ?? 0}`,
);

// ── Sheet B, the month summary ─────────────────────────────────────────────
const B = all.get('B Monatsuebersicht');
if (!B) {
  console.error('sheet "B Monatsuebersicht" is missing');
  process.exit(1);
}
const bHead = B[0];
const bFare = column(bHead, 'Fahrpreise (EUR)');
const bZero = column(bHead, 'Tag ohne Fahrt');
const bRides = column(bHead, 'Auftraege');
const bDate = column(bHead, 'Datum');
const bBody = B.slice(1).filter(r => String(r[bDate] ?? '') !== 'Summe' && String(r[bDate] ?? '') !== '');
const bTotalRow = B.slice(1).find(r => String(r[bDate] ?? '') === 'Summe');

const fareB = bBody.reduce((n, r) => n + cents(r[bFare]), 0);
const zeroDays = bBody.filter(r => String(r[bZero] ?? '') === 'Ja');

say(bBody.length >= 28 && bBody.length <= 31, 'sheet B has one row per calendar day', `${bBody.length} days`);
say(zeroDays.length > 0, 'sheet B carries zero-ride days, as section 2 requires', `${zeroDays.length} of ${bBody.length}`);
say(
  zeroDays.every(r => Number(r[bRides] ?? -1) === 0),
  'every zero-ride day really holds no order',
  zeroDays.map(r => `${r[bDate]}=${r[bRides]}`).join(' '),
);
say(fareB === fareA, 'sheet B day rows re-sum to sheet A ride by ride', `B ${fareB} vs A ${fareA} cents`);
say(!!bTotalRow && cents(bTotalRow[bFare]) === fareA, 'sheet B total row agrees with sheet A', `${bTotalRow ? cents(bTotalRow[bFare]) : 'no total row'} vs ${fareA}`);

// ── Sheets C and D, the breakdowns ─────────────────────────────────────────
for (const [name, grouped] of [['C Summe je Fahrer', byDriver], ['D Summe je Fahrzeug', byPlate]] as const) {
  const S = all.get(name);
  if (!S) {
    problems.push(`sheet "${name}" is missing`);
    continue;
  }
  const head = S[0];
  const iF = column(head, 'Fahrpreise (EUR)');
  const body = S.slice(1).filter(r => String(r[0] ?? '') !== 'Summe' && String(r[0] ?? '') !== '');
  const sum = body.reduce((n, r) => n + cents(r[iF]), 0);
  const totalRow = S.slice(1).find(r => String(r[0] ?? '') === 'Summe');
  say(sum === fareA, `${name} rows re-sum to sheet A`, `${sum} vs ${fareA} cents`);
  say(!!totalRow && cents(totalRow[iF]) === fareA, `${name} total row agrees with sheet A`, `${totalRow ? cents(totalRow[iF]) : 'no total row'} vs ${fareA}`);
  // And the per-key figures match the ones computed from sheet A, not only the sum.
  for (const r of body) {
    const key = String(r[0] ?? '');
    const expected = grouped.get(key);
    if (expected !== undefined && cents(r[iF]) !== expected) {
      problems.push(`${name}: ${key} shows ${cents(r[iF])} where sheet A sums to ${expected}`);
    }
  }
}

// ── Sheet E, declined and cancelled ────────────────────────────────────────
const E = all.get('E Abgelehnt und storniert');
if (E) {
  const eStatus = column(E[0], 'Status');
  const eDeclined = E.slice(1).filter(r => String(r[eStatus] ?? '') === 'abgelehnt');
  say(
    eDeclined.length === (byStatus.get('abgelehnt') ?? 0),
    'sheet E lists exactly the declined rides of sheet A',
    `E ${eDeclined.length} vs A ${byStatus.get('abgelehnt') ?? 0}`,
  );
}

// ── Sheet F, the basis, the rate and the share ─────────────────────────────
const F = all.get('F Pruefung und Grenzen');
if (F) {
  /*
    The value beside a label, read as a **number** and never through the German
    string parser.

    The first version of this block stripped thousands dots and swapped the
    comma, which is right for "8.252,76" and destroys a numeric cell: `2641.71`
    became `264171`, the share and the remainder each came out a hundred times
    too large, and the basis read as zero. The workbook writes these as numbers
    on purpose — a figure in a spreadsheet should be a figure — so the raw value
    is the one to take, and only a text cell needs parsing.
  */
  const valueOf = (label: string): number | null => {
    const row = F.find(r => String(r[0] ?? '') === label);
    if (!row) return null;
    const cell = row[1];
    if (typeof cell === 'number') return cell;
    if (typeof cell !== 'string' || cell.trim() === '') return null;
    const parsed = Number(cell.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const basisEuro = valueOf('Anspruchsberechtigte Einnahmen (EUR)');
  const rate = valueOf('Satz (%)');
  const amountEuro = valueOf('Betrag (EUR)');
  const restEuro = valueOf('Rest, falls Abzug (EUR)');

  const basis = basisEuro === null ? null : Math.round(basisEuro * 100);
  const amount = amountEuro === null ? null : Math.round(amountEuro * 100);
  const rest = restEuro === null ? null : Math.round(restEuro * 100);

  // Tips are excluded and decline fees included by this deliverable's settings,
  // which sheet F states in its own two rows; both are asserted below so the
  // expectation is read off the file rather than assumed.
  say(String(F.find(r => String(r[0] ?? '') === 'Trinkgeld in Grundlage')?.[1] ?? '') === 'Nein',
      'sheet F says tips are outside the basis', 'Trinkgeld in Grundlage = Nein');
  say(String(F.find(r => String(r[0] ?? '') === 'Gebuehren in Grundlage')?.[1] ?? '') === 'Ja',
      'sheet F says decline fees are inside the basis', 'Gebuehren in Grundlage = Ja');

  const expectedBasis = fareA + feeA;
  say(basis === expectedBasis, 'sheet F basis equals fares plus decline fees from sheet A',
      `F ${basis} vs A ${expectedBasis} cents (fares ${fareA} + fees ${feeA})`);

  say(rate !== null && rate >= 30 && rate <= 33, 'sheet F names a rate inside 30..33 percent', String(rate));

  if (basis !== null && amount !== null && rest !== null) {
    say(amount + rest === basis, 'sheet F share plus remainder equals the basis',
        `${amount} + ${rest} = ${amount + rest} vs ${basis}`);
    if (rate !== null) {
      // Recomputed here in integers, half away from zero, so the figure on the
      // sheet is checked against arithmetic this script did itself.
      const bp = Math.round(rate * 100);
      const q = Math.floor((basis * bp) / 10_000);
      const r = basis * bp - q * 10_000;
      const expected = 2 * r >= 10_000 ? q + 1 : q;
      say(amount === expected, 'sheet F share is the basis times the rate, recomputed independently',
          `${amount} vs ${expected} cents at ${bp} bp`);
    }
  }
}

// ── The simulation marking ─────────────────────────────────────────────────
say(sheetNames.includes('SIMULIERT'), 'the workbook carries the SIMULIERT sheet', sheetNames.includes('SIMULIERT') ? 'present' : 'MISSING');
say(sheetNames[0] !== 'SIMULIERT', 'and it is not the first sheet, so the rides can be re-imported', `first is "${sheetNames[0]}"`);
say(file.startsWith('SIMULIERT_'), 'the file name carries the prefix', file);
const G = all.get('G Quelle und Einstellungen');
const gText = (G ?? []).flat().map(c => String(c ?? '')).join(' ');
say(/simuliert|SIMULIERT/.test(gText), 'sheet G says in words that the rides are simulated', gText.length > 0 ? 'yes' : 'sheet G is empty');
say(/full-month\//.test(gText), 'sheet G names the generator version', (gText.match(/full-month\/[\d.]+/) ?? ['not found'])[0]);

console.log('');
if (problems.length > 0) {
  console.error(`VERIFY FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`VERIFY OK — every sheet read in full, ${A.length - 1} rides re-summed, all cross-sheet totals agree.`);
