/**
 * The Fahrerübersicht's column list and hour formatting, in one place.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Two sheets print the same seven Lohnart columns for the same German tax
 * adviser: `fahreruebersichtExport.ts`, which reads the saved Stundennachweis
 * archive, and `monthlyPlanPayrollSummary.ts` (§12), which reads a confirmed
 * monthly plan. A column list copied into two files is a column list that
 * drifts, and a Steuerberater reconciling two sheets whose headers have drifted
 * has no way to see it — the numbers simply do not add up.
 *
 * So the list and the formatter live here and nothing restates them. This
 * module is deliberately **dependency-free**: `fahreruebersichtExport.ts`
 * imports `xlsx` at its top, and §12's builder is a pure function that must be
 * testable without loading a spreadsheet writer.
 *
 * ── WHAT WAS MOVED, AND WHAT WAS NOT ──────────────────────────────────────
 *
 * `minsToDecHours`, `fmtHours`, `MONTHS_DE` and `COLUMNS` are moved out of
 * `fahreruebersichtExport.ts` character for character. Nothing else moved: the
 * cell styles, the sheet assembly and the import-format export stay where they
 * are, because only the list and the units are shared.
 *
 * ── GERMAN, IN BOTH LANGUAGES, AND THE REASON IS NOT INERTIA ──────────────
 *
 * The seven Lohnart names stay German whatever the UI language, for the reason
 * `stundennachweisArchiveExport.ts` already writes down for this same set of
 * columns: a Lohnart is domain vocabulary (`src/i18n/index.ts`), and this sheet
 * has to reconcile with the Stundennachweis PDF beside it, which is statutory
 * German. `MONTHS_DE` is date formatting, which `src/i18n/index.ts` also keeps
 * German. So no dictionary key is added by either sheet.
 */

/** Minutes as decimal hours, rounded to 0,01 h. */
export function minsToDecHours(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

/**
 * Decimal hours with a German decimal comma. **Zero prints as an empty cell**,
 * not as `0,00`: a bucket a driver never worked is nothing to report, and a
 * printed zero in a column the recipient fills by hand reads as a measurement.
 * A caller that must tell "we did not compute this" from "it is zero" decides
 * that above this function — it cannot tell them apart.
 */
export function fmtHours(mins: number): string {
  if (!mins) return '';
  return minsToDecHours(mins).toFixed(2).replace('.', ',');
}

export const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export interface FahreruebersichtColumn {
  label: string;
  /** Column width in characters, for the XLSX writers that consume this list. */
  width: number;
}

/**
 * The 25 columns of the Fahrerübersicht. The first eleven are computed from the
 * hours; the fourteen after them have no source in this product and are left
 * blank for the Steuerberater to fill in — they are not zeros.
 */
export const FAHRERUEBERSICHT_COLUMNS: readonly FahreruebersichtColumn[] = [
  { label: 'Nr.',               width: 5  },
  { label: 'Personalnr.',       width: 13 },
  { label: 'Fahrername',        width: 22 },
  { label: 'Arbeitstage',       width: 12 },
  { label: 'Std. Grundlohn',    width: 14 },
  { label: 'Std. Nacht\n(20-06)',   width: 14 },
  { label: 'Std. Nacht\n(00-04)',   width: 14 },
  { label: 'Std. Samstag',      width: 13 },
  { label: 'Std. Sonntag',      width: 13 },
  { label: 'Std. Feiertag',     width: 13 },
  { label: 'Std. Weihnachten',  width: 16 },
  { label: 'Annahmequote %',    width: 14 },
  { label: 'Bewertung',         width: 12 },
  { label: 'Fahrpreise',        width: 13 },
  { label: 'Gesamtumsatz €',    width: 14 },
  { label: 'Trinkgeld €',       width: 12 },
  { label: 'Bargeld €',         width: 12 },
  { label: 'Online €',          width: 12 },
  { label: 'Bonus €',           width: 11 },
  { label: 'QPP',               width: 10 },
  { label: 'Zielerfüllung %',   width: 14 },
  { label: 'Kranktage',         width: 11 },
  { label: 'Urlaubstage',       width: 12 },
  { label: 'Sonderurlaub',      width: 13 },
  { label: 'Bemerkung',         width: 20 },
];

/**
 * Where `Arbeitstage` sits. §12's own required figure — the month's total hours
 * — is inserted directly after it by `monthlyPlanPayrollSummary.ts`, and that
 * position is load-bearing rather than cosmetic: see the note there.
 * `monthlyPlanPayrollSummary.test.ts` pins the index, so a column added to the
 * list above fails the build instead of moving the total silently.
 */
export const ARBEITSTAGE_INDEX = 3;
