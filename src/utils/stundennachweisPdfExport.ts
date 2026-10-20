/**
 * Shared Stundennachweis PDF renderer.
 *
 * Used by StundennachweisPage (live export) and DocumentsPage (archive export).
 * Layout: Datum | Schicht 1–3 Von/Bis | Grundlohn | Nachtarbeit | Nacht 0–4 |
 *         Sonntag | Feiertag | Weihn./1. Mai
 * Samstag is tracked internally but NOT shown as a column.
 *
 * After the main table a "Notizen / Hinweise" section is rendered.
 * If it doesn't fit on page 1, page 2 is created automatically.
 */

import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { categorizeWarnings, formatDateDE } from './warningCategories';
import { SIMULATED_SHORT_NOTICE, simulatedFileName } from './simulatedRides/marker';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PdfDayRow {
  date: Date;
  weekday: string;
  isSat: boolean;
  isSun: boolean;
  isHol: boolean;
  von1: string; bis1: string; bis1Display?: string;
  von2: string; bis2: string; bis2Display?: string;
  von3: string; bis3: string; bis3Display?: string;
  grundlohn:     string;
  nachtarbeit:   string;
  nachtarbeit04: string;
  sonntag:       string;
  feiertag:      string;
  weihnachten:   string;
  /**
   * A short marker printed beside the date, after the `[N]` note marker.
   * The monthly-plan Stundennachweis uses it for `(n)` — the day's real number
   * of periods — when more than three had to be shown in three column pairs, so
   * the three printed pairs never read as the whole day. Absent for every other
   * caller, and then the date cell is unchanged.
   */
  marker?:       string;
  [key: string]: unknown;
}

export interface PdfTotals {
  grundlohn:   number;
  nachtarbeit: number;
  nacht04:     number;
  sonntag:     number;
  feiertag:    number;
  weihnachten: number;
  [key: string]: number;
}

export interface PdfDriver {
  name:            string;
  personalnummer?: string | null;
}

/** A note to display in the notes section of the PDF. */
export interface PdfNote {
  /** Primary date of the note (YYYY-MM-DD or full ISO string). */
  note_date:  string;
  /** Optional time portion (HH:MM or full ISO string; used if note_date contains no time). */
  note_time?: string | null;
  /** Human-readable note type / planning behavior label. */
  note_type?: string | null;
  /** Full note text / description. */
  note_text?: string | null;
  /** Range start date (YYYY-MM-DD) if note spans multiple days. */
  start_date?: string | null;
  /** Range end date (YYYY-MM-DD) if note spans multiple days. */
  end_date?: string | null;
}

export interface HistoricalPdfCorrectionEntry {
  wageCode:       string;
  wageLabel:      string;
  planActualMins: number;
  correctionMins: number;
  finalMins:      number;
  targetMins:     number;
}

export interface HistoricalGrossReconciliation {
  grundlohnH:       number;
  grundlohnCents:   number;
  nachtarbeitH:     number;
  nachtarbeitCents: number;
  nacht04H:         number;
  nacht04Cents:     number;
  sonntagH:         number;
  sonntagCents:     number;
  feiertagH:        number;
  feiertagCents:    number;
  ausgleichH:       number;
  ausgleichCents:   number;
  finalGrossCents:  number;
  targetGrossCents: number;
  differenzCents:   number;
  overTarget:       boolean;
}

export interface HistoricalLohnartRow {
  wageCode:     string;   // e.g. '1000'
  wageLabel:    string;   // e.g. 'Stundenlohn'
  targetH:      number;   // target hours from Lohnabrechnung
  actualH:      number;   // hours from reconstructed rides
  correctionH:  number;   // correction (target - actual)
  finalH:       number;   // = target (always exact)
  ratePercent:  number;   // surcharge % (0 = base, 25/40/50/100)
  amountCents:  number;   // computed amount in euro-cents
}

export interface HistoricalLohnartReconciliation {
  hourlyCents:      number;
  rows:             HistoricalLohnartRow[];
  totalAmountCents: number;
  hasNegative:      boolean;
}

export interface StundennachweisExportData {
  driver:   PdfDriver;
  month:    number;
  year:     number;
  rows:     PdfDayRow[];
  totals:   PdfTotals;
  /** Driver notes for the month — shown in "Notizen / Hinweise" section. */
  notes?:    PdfNote[];
  /** Generation warnings (e.g. uncovered Fahrtenbuch trips). */
  warnings?: string[];
  /** When true: render historical wording (Historische Hinweise, Finale Summe, etc.) */
  isHistorical?: boolean;
  /** Structured correction rows for the historical correction table on page 2. */
  historicalCorrections?: HistoricalPdfCorrectionEntry[];
  /** Full gross reconciliation breakdown (amounts in cents) for historical PDFs. */
  historicalGrossReconciliation?: HistoricalGrossReconciliation;
  /** Working-hours Lohnart reconciliation for Mit-Arbeitsstunden PDFs. */
  historicalLohnartReconciliation?: HistoricalLohnartReconciliation;
  /** When true: this is the Inhaber/Ausgleichsfahrer — show adjusted wording. */
  isOwnerDriver?: boolean;
  /**
   * One line under the title, for a document about a month that has not
   * happened: "PLANUNG / VORSCHAU — kein Arbeitszeitnachweis · Erstellt am …".
   *
   * It occupies the same slot as the historical subtitle, so a caller that sets
   * neither renders exactly as before. `isHistorical` wins if both are set —
   * a historical reconciliation is never a proposal.
   */
  planningNotice?: string;
  /**
   * Whether any ride this document was computed from is simulated. REQUIRED,
   * so that no caller can build a Stundennachweis without deciding: the hours
   * and Lohnart figures come from ride times, and a simulated ride's times are
   * invented. The rule is the trips', not a company flag: the caller derives it
   * from the source trips (see simulatedRides/importMarker.ts). True stamps a
   * line on every page and prefixes the file name.
   */
  simulated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function minsToDecimal(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

function fmtDec(v: number): string {
  return v.toFixed(2).replace('.', ',');
}

/** Format a date string (YYYY-MM-DD or ISO) as dd.MM.yyyy. */
function fmtDate(s: string): string {
  const d = s.slice(0, 10);
  const [y, mo, day] = d.split('-');
  return `${day}.${mo}.${y}`;
}

/** Extract HH:MM from an ISO datetime string or a plain HH:MM string. */
function fmtTime(s: string | null | undefined): string {
  if (!s) return '';
  // ISO datetime: "2026-05-20T12:16:00" or "2026-05-20 12:16:00"
  const m = s.match(/[T ](\d{2}:\d{2})/);
  if (m) return m[1];
  // Already HH:MM
  if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  return '';
}

/**
 * Reconstruct a Date from a stored row.
 * Prefers date_key ("YYYY-MM-DD"), falls back to dayIndex, then first of month.
 */
export function deserializePdfRowDate(
  row: Record<string, unknown>,
  month: number,
  year: number,
): Date {
  if (typeof row.date_key === 'string' && row.date_key.length === 10) {
    const [y, mo, d] = row.date_key.split('-').map(Number);
    return new Date(y, mo - 1, d);
  }
  if (typeof row.dayIndex === 'number') {
    return new Date(year, month - 1, row.dayIndex as number);
  }
  return new Date(year, month - 1, 1);
}

/**
 * Convert a stored rows_json element into a PdfDayRow.
 * Old records without von3/bis3 default to '' — safe.
 */
export function toPdfDayRow(
  raw: Record<string, unknown>,
  month: number,
  year: number,
): PdfDayRow {
  const date = deserializePdfRowDate(raw, month, year);
  const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const str  = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const bool = (k: string) => !!(raw[k]);
  return {
    date,
    weekday:       str('weekday') || WEEKDAY_SHORT[date.getDay()],
    isSat:         bool('isSat'),
    isSun:         bool('isSun'),
    isHol:         bool('isHol'),
    von1:          str('von1'),
    bis1:          str('bis1'),
    bis1Display:   str('bis1Display') || undefined,
    von2:          str('von2'),
    bis2:          str('bis2'),
    bis2Display:   str('bis2Display') || undefined,
    von3:          str('von3'),
    bis3:          str('bis3'),
    bis3Display:   str('bis3Display') || undefined,
    grundlohn:     str('grundlohn'),
    nachtarbeit:   str('nachtarbeit'),
    nachtarbeit04: str('nachtarbeit04'),
    sonntag:       str('sonntag'),
    feiertag:      str('feiertag'),
    weihnachten:   str('weihnachten'),
    noteHighlight: bool('noteHighlight'),
  };
}

// ── Main export function ──────────────────────────────────────────────────────

function _buildDoc(data: StundennachweisExportData): jsPDF {
  const pdf = _buildDocBody(data);
  if (data.simulated) stampSimulated(pdf);
  return pdf;
}

/** The marker on every page, top and bottom, in the margins no table uses. */
function stampSimulated(pdf: jsPDF): void {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(180, 0, 0);
    pdf.text(SIMULATED_SHORT_NOTICE, 105, 6, { align: 'center' });
    pdf.text(SIMULATED_SHORT_NOTICE, 105, 294, { align: 'center' });
  }
  pdf.setTextColor(0, 0, 0);
}

function _buildDocBody(data: StundennachweisExportData): jsPDF {
  const { driver, month, year, rows, totals, notes = [], warnings = [], isHistorical = false, historicalCorrections = [] } = data;
  // A planning proposal, never a record. Empty for every existing caller, which
  // is what keeps their header byte-identical.
  const planningNotice = !isHistorical && typeof data.planningNotice === 'string'
    ? data.planningNotice.trim()
    : '';
  const monthName    = MONTH_NAMES_DE[month - 1];
  const nextMonthDay = new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
  const today        = format(nextMonthDay, 'dd.MM.yyyy');

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PW = 210, PH = 297;
  const ML = 10, MR = 10, MT = 12, MB = 12;
  const TW = PW - ML - MR; // 190 mm

  const setB = (sz: number) => { pdf.setFont('helvetica', 'bold');   pdf.setFontSize(sz); };
  const setN = (sz: number) => { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(sz); };

  const C_BLACK : [number,number,number] = [  0,   0,   0];
  const C_DARK  : [number,number,number] = [ 50,  50,  50];
  const C_MED   : [number,number,number] = [110, 110, 110];
  const C_HBKG  : [number,number,number] = [218, 218, 218];
  const C_TFBKG : [number,number,number] = [208, 208, 208];
  const C_HOL   : [number,number,number] = [255, 237, 204];
  const C_SUN   : [number,number,number] = [240, 240, 240];
  const C_SAT   : [number,number,number] = [247, 247, 247];

  // Column definitions — widths must sum to TW (190 mm).
  // Samstag is deliberately excluded from visible columns.
  const cols: { key: string; w: number; label: string; sub: string }[] = [
    { key: 'date',  w: 30, label: 'Datum',          sub: ''    },
    { key: 'von1',  w: 12, label: 'Schicht 1',      sub: 'Von' },
    { key: 'bis1',  w: 12, label: '',               sub: 'Bis' },
    { key: 'von2',  w: 12, label: 'Schicht 2',      sub: 'Von' },
    { key: 'bis2',  w: 12, label: '',               sub: 'Bis' },
    { key: 'von3',  w: 12, label: 'Schicht 3',      sub: 'Von' },
    { key: 'bis3',  w: 12, label: '',               sub: 'Bis' },
    { key: 'gl',    w: 18, label: 'Grundlohn',      sub: ''    },
    { key: 'na',    w: 16, label: 'Nacht-\narbeit', sub: ''    },
    { key: 'na04',  w: 16, label: 'Nacht\n0–4 Uhr', sub: ''   },
    { key: 'sun',   w: 14, label: 'Sonn-\ntag',     sub: ''    },
    { key: 'hol',   w: 14, label: 'Feier-\ntag',    sub: ''    },
    { key: 'xmas',  w: 10, label: 'Weihn.\n1. Mai', sub: ''    },
  ];
  const colSum = cols.reduce((s, c) => s + c.w, 0);
  if (colSum !== TW) cols[0].w += TW - colSum;

  const colX: number[] = [];
  let cx = ML;
  for (const c of cols) { colX.push(cx); cx += c.w; }

  const HDR1_H = 8.0;
  const HDR2_H = 4.5;
  const ROW_H  = 5.6;
  const TOT_H  = 6.5;

  const SIG_LABEL_Y = PH - MB;
  const SIG_LINE_Y  = SIG_LABEL_Y - 8;

  let y = MT;

  // ── Document header ─────────────────────────────────────────────────────────
  setB(10); pdf.setTextColor(...C_BLACK);
  pdf.text(driver.name, ML, y + 6);
  if (driver.personalnummer) {
    setN(8); pdf.setTextColor(...C_DARK);
    pdf.text(`Pers.-Nr.: ${driver.personalnummer}`, ML, y + 11);
  }
  setB(14); pdf.setTextColor(...C_BLACK);
  pdf.text('Stundennachweis', PW / 2, y + (isHistorical || planningNotice ? 5.5 : 7.5), { align: 'center' });
  if (isHistorical) {
    setN(8); pdf.setTextColor(...C_MED);
    pdf.text('Historischer Abgleich', PW / 2, y + 11, { align: 'center' });
  } else if (planningNotice) {
    setB(7); pdf.setTextColor(150, 70, 0);
    pdf.text(planningNotice, PW / 2, y + 11, { align: 'center' });
    pdf.setTextColor(...C_BLACK);
  }
  setB(10); pdf.setTextColor(...C_BLACK);
  pdf.text(`${monthName} ${year}`, PW - MR, y + 6, { align: 'right' });
  setN(8); pdf.setTextColor(...C_DARK);
  pdf.text('Monat / Jahr', PW - MR, y + 11, { align: 'right' });

  const HLINE_Y = y + 14;
  pdf.setDrawColor(...C_BLACK); pdf.setLineWidth(0.4);
  pdf.line(ML, HLINE_Y, PW - MR, HLINE_Y);
  y = HLINE_Y + 3;

  // ── Table header row 1 ──────────────────────────────────────────────────────
  pdf.setDrawColor(...C_DARK); pdf.setLineWidth(0.25);
  for (let ci = 0; ci < cols.length; ci++) {
    pdf.setFillColor(...C_HBKG);
    pdf.rect(colX[ci], y, cols[ci].w, HDR1_H, 'FD');
    const c = cols[ci];
    if (!c.label) continue;
    const cx2 = colX[ci] + c.w / 2;
    const cy2 = y + HDR1_H / 2 + 0.5;
    setB(7); pdf.setTextColor(...C_BLACK);
    if (c.label.includes('\n')) {
      const [l1, l2] = c.label.split('\n');
      pdf.text(l1, cx2, cy2 - 1.5, { align: 'center' });
      pdf.text(l2, cx2, cy2 + 1.5, { align: 'center' });
    } else {
      pdf.text(c.label, cx2, cy2, { align: 'center' });
    }
  }
  y += HDR1_H;

  // ── Table header row 2 (Von / Bis sub-labels) ───────────────────────────────
  for (let ci = 0; ci < cols.length; ci++) {
    pdf.setFillColor(...C_HBKG);
    pdf.rect(colX[ci], y, cols[ci].w, HDR2_H, 'FD');
    if (cols[ci].sub) {
      setB(7); pdf.setTextColor(...C_BLACK);
      pdf.text(cols[ci].sub, colX[ci] + cols[ci].w / 2, y + HDR2_H / 2 + 0.9, { align: 'center' });
    }
  }
  y += HDR2_H;

  // ── Data rows ───────────────────────────────────────────────────────────────
  for (const row of rows) {
    const bg: [number, number, number] =
      row.isHol ? C_HOL : row.isSun ? C_SUN : row.isSat ? C_SAT : [255, 255, 255];

    pdf.setFillColor(...bg);
    pdf.setDrawColor(...C_DARK);
    pdf.setLineWidth(0.2);
    for (let ci = 0; ci < cols.length; ci++) {
      pdf.rect(colX[ci], y, cols[ci].w, ROW_H, 'FD');
    }

    const cy2  = y + ROW_H / 2 + 1.2;
    const bold = row.isSat || row.isSun || row.isHol;
    pdf.setTextColor(...C_BLACK);

    if (bold) setB(7.5); else setN(7.5);
    // Show plain "Notiz" marker in date cell if note highlight
    const noteMarker = row.noteHighlight ? ' [N]' : '';
    // §11's marker: absent for every caller that does not set it, so the cell is
    // unchanged for the four existing ones.
    const planMarker = typeof row.marker === 'string' && row.marker ? ` ${row.marker}` : '';
    pdf.text(`${row.weekday} ${format(row.date, 'dd.MM.yy')}${noteMarker}${planMarker}`, colX[0] + 1.5, cy2);
    if (row.isHol) {
      setN(6); pdf.setTextColor(130, 60, 0);
      pdf.text('F', colX[0] + cols[0].w - 3, cy2);
      pdf.setTextColor(...C_BLACK);
    }

    const vals: string[] = [
      row.von1, row.bis1Display ?? row.bis1,
      row.von2, row.bis2Display ?? row.bis2,
      row.von3, row.bis3Display ?? row.bis3,
      row.grundlohn, row.nachtarbeit, row.nachtarbeit04,
      row.sonntag, row.feiertag, row.weihnachten,
    ];
    for (let ci = 1; ci < cols.length; ci++) {
      const v = vals[ci - 1];
      if (!v) continue;
      // Use smaller font for long cross-midnight bis values (e.g. "01:18+ (01.06.)")
      const fontSize = v.length > 7 ? 5.5 : 7.5;
      setN(fontSize); pdf.setTextColor(...C_BLACK);
      pdf.text(v, colX[ci] + cols[ci].w / 2, cy2, { align: 'center' });
    }

    y += ROW_H;
  }

  // ── Totals row ──────────────────────────────────────────────────────────────
  pdf.setFillColor(...C_TFBKG);
  pdf.setDrawColor(...C_DARK);
  pdf.setLineWidth(0.35);
  for (let ci = 0; ci < cols.length; ci++) {
    pdf.rect(colX[ci], y, cols[ci].w, TOT_H, 'FD');
  }
  const tcy = y + TOT_H / 2 + 1.2;
  setB(7.5); pdf.setTextColor(...C_BLACK);
  pdf.text(isHistorical ? 'Finale Summe:' : 'Summe (Dez.):', colX[0] + 1.5, tcy);

  const totVals: string[] = [
    '', '', '', '', '', '',
    fmtDec(minsToDecimal(totals.grundlohn)),
    fmtDec(minsToDecimal(totals.nachtarbeit)),
    fmtDec(minsToDecimal(totals.nacht04)),
    fmtDec(minsToDecimal(totals.sonntag)),
    fmtDec(minsToDecimal(totals.feiertag)),
    fmtDec(minsToDecimal(totals.weihnachten)),
  ];
  for (let ci = 1; ci < cols.length; ci++) {
    if (!totVals[ci - 1]) continue;
    setB(7.5); pdf.setTextColor(...C_BLACK);
    pdf.text(totVals[ci - 1], colX[ci] + cols[ci].w / 2, tcy, { align: 'center' });
  }

  // ── Footer (page 1) ─────────────────────────────────────────────────────────
  y += TOT_H;

  // Historical footnote below totals row
  if (isHistorical) {
    setN(6.5); pdf.setTextColor(80, 80, 80);
    pdf.text('Finale Summe = Plan-Ist aus rekonstruierten Fahrten + historische Korrektur.', ML, y + 4);
    y += 6;
  }

  const FOOTER_Y = y + 5;
  pdf.setDrawColor(185, 185, 185); pdf.setLineWidth(0.2);
  pdf.line(ML, FOOTER_Y - 2.5, PW - MR, FOOTER_Y - 2.5);
  setN(7.5); pdf.setTextColor(...C_MED);
  pdf.text('Lohn+Gehalt', ML, FOOTER_Y);
  pdf.text('– 1 –', PW / 2, FOOTER_Y, { align: 'center' });
  pdf.text(today, PW - MR, FOOTER_Y, { align: 'right' });

  // ── Signature lines ─────────────────────────────────────────────────────────
  const sigW = (TW - 20) / 2;
  pdf.setDrawColor(...C_BLACK); pdf.setLineWidth(0.4);
  pdf.line(ML,             SIG_LINE_Y, ML + sigW,             SIG_LINE_Y);
  pdf.line(PW - MR - sigW, SIG_LINE_Y, PW - MR,               SIG_LINE_Y);
  setN(7.5); pdf.setTextColor(...C_DARK);
  pdf.text('Datum, Unterschrift Arbeitnehmer', ML,             SIG_LABEL_Y);
  pdf.text('Datum, Unterschrift Arbeitgeber',  PW - MR - sigW, SIG_LABEL_Y);

  // ── Notes / Hinweise section ─────────────────────────────────────────────────
  const hasNotes    = notes.length > 0;
  const hasWarnings = warnings.length > 0;
  const lohnartRecon = (data as StundennachweisExportData).historicalLohnartReconciliation;
  const hasHistoricalContent = isHistorical && (
    (data as StundennachweisExportData).historicalGrossReconciliation != null ||
    lohnartRecon != null ||
    historicalCorrections.length > 0 ||
    warnings.length > 0
  );

  const isOwnerDriver = !!(data as StundennachweisExportData).isOwnerDriver;

  if (hasNotes || hasWarnings || hasHistoricalContent) {

    if (isHistorical && isOwnerDriver) {
      // ── Inhaber/Ausgleichsfahrer: no payroll targets ───────────────────────
      const NOTE_LINE_H = 5.5;
      const availableY = FOOTER_Y + 4;
      let ny = availableY + 6;

      setB(8); pdf.setTextColor(...C_DARK);
      pdf.text('Historische Hinweise', ML, ny);
      ny += 1.5;
      pdf.setDrawColor(...C_DARK); pdf.setLineWidth(0.2);
      pdf.line(ML, ny, ML + 60, ny);
      ny += 5;

      setN(7.5); pdf.setTextColor(80, 80, 80);
      pdf.text('Inhaber / Ausgleichsfahrer — keine Lohnabrechnungs-Zielwerte', ML + 2, ny);
      ny += NOTE_LINE_H;
      setN(6.5); pdf.setTextColor(80, 80, 80);
      pdf.text('Ausgleichsfahrten dokumentiert, nicht lohnabrechnungsrelevant.', ML + 2, ny);

    } else if (isHistorical && lohnartRecon) {
      // ── Working-hours mode: Lohnart reconciliation table ─────────────────────
      const NOTE_LINE_H = 5.5;
      const tblRowH2 = 5;
      const lrRows = lohnartRecon.rows;
      const totalH = 10 + 10 + (lrRows.length + 3) * tblRowH2 + 10;

      const availableY = FOOTER_Y + 4;
      const availableH  = SIG_LINE_Y - 16 - availableY;
      let ny = availableY + 6;

      if (totalH > availableH) {
        pdf.addPage();
        ny = MT + 4;
        setB(9); pdf.setTextColor(...C_BLACK);
        pdf.text(`${driver.name} – Historischer Stundennachweis ${monthName} ${year}`, ML, ny);
        ny += 7;
      }

      setB(8); pdf.setTextColor(...C_DARK);
      pdf.text('Historische Lohnarten-Abstimmung', ML, ny);
      ny += 1.5;
      pdf.setDrawColor(...C_DARK); pdf.setLineWidth(0.2);
      pdf.line(ML, ny, ML + 80, ny);
      ny += 4;

      setN(6.5); pdf.setTextColor(80, 80, 80);
      pdf.text('Abgleich laut Lohnabrechnung. Die finalen Lohnarten entsprechen den eingetragenen Steuerberater-Werten.', ML + 2, ny);
      ny += NOTE_LINE_H;

      const C_HBKG2: [number, number, number] = [235, 235, 245];
      const fmtH2 = (h: number) => `${h.toFixed(2).replace('.', ',')} Std`;
      const fmtEur2 = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
      const fmtPct = (p: number) => p === 0 ? 'Basis' : `${p} %`;

      const COL_CODE = 14;
      const COL_BEZ3 = 44;
      const COL_H3   = 22;
      const COL_PCF  = 16;
      const COL_EUR  = 28;
      const COLS = [COL_CODE, COL_BEZ3, COL_H3, COL_H3, COL_H3, COL_H3, COL_PCF, COL_EUR];
      const tblX3 = ML + 2;

      const drawLrRow = (cells: string[], rowY: number, rowH: number, bold: boolean, bg?: [number,number,number]) => {
        let rx = tblX3;
        if (bg) { pdf.setFillColor(...bg); COLS.forEach(w => { pdf.rect(rx, rowY, w, rowH, 'F'); rx += w; }); rx = tblX3; }
        bold ? setB(6) : setN(6);
        pdf.setTextColor(...C_DARK);
        for (let ci = 0; ci < COLS.length; ci++) {
          const align = ci >= 2 ? 'right' : 'left';
          const xOff = align === 'right' ? COLS[ci] - 1 : 1;
          pdf.text(cells[ci] ?? '', rx + xOff, rowY + rowH - 1.5, { align });
          rx += COLS[ci];
        }
        pdf.setDrawColor(190, 190, 190); pdf.setLineWidth(0.12);
        rx = tblX3;
        COLS.forEach(w => { pdf.rect(rx, rowY, w, rowH, 'S'); rx += w; });
      };

      drawLrRow(['Code', 'Bezeichnung', 'Ziel', 'Ist', 'Korr.', 'Final', 'Satz', 'Betrag'], ny, tblRowH2, true, C_HBKG2);
      ny += tblRowH2;

      for (const row of lrRows) {
        const corrSign = row.correctionH >= 0 ? '+' : '';
        const corrStr = `${corrSign}${row.correctionH.toFixed(2).replace('.', ',')}`;
        const rowBg: [number,number,number] | undefined = row.correctionH < 0 ? [255, 245, 230] : undefined;
        drawLrRow([
          row.wageCode,
          row.wageLabel,
          fmtH2(row.targetH),
          fmtH2(row.actualH),
          corrStr,
          fmtH2(row.finalH),
          fmtPct(row.ratePercent),
          fmtEur2(row.amountCents),
        ], ny, tblRowH2, false, rowBg);
        ny += tblRowH2;
      }

      // Total row
      const totalCols = COLS.length;
      const totalRowCells = Array(totalCols).fill('');
      totalRowCells[COL_BEZ3 > 0 ? 1 : 0] = 'Gesamt';
      totalRowCells[totalCols - 1] = fmtEur2(lohnartRecon.totalAmountCents);
      drawLrRow(totalRowCells, ny, tblRowH2, true, C_HBKG2);
      ny += tblRowH2 + 3;

      if (lohnartRecon.hasNegative) {
        setN(6.5); pdf.setTextColor(180, 100, 0);
        pdf.text('Hinweis: Negative Korrekturen vorhanden — Ist-Stunden übersteigen Lohnabrechnung-Zielwerte.', ML + 2, ny);
      } else {
        setN(6.5); pdf.setTextColor(60, 100, 60);
        pdf.text('Abgleich: OK — Finale Lohnarten entsprechen exakt den eingetragenen Steuerberater-Werten.', ML + 2, ny);
      }

    } else if (isHistorical) {
      // ── Historical mode: full gross reconciliation table ──────────────────
      const NOTE_LINE_H = 5.5;
      const NOTE_TITLE_H = 10;
      const gr = (data as StundennachweisExportData).historicalGrossReconciliation;

      // Row count: header + 5 Zuschlag rows + Ausgleich + Finales Brutto + Ziel + Differenz + Status + footer
      const reconcRowCount = gr ? 12 : (historicalCorrections.length > 0 ? historicalCorrections.length + 3 : 2);
      const totalH = NOTE_TITLE_H + 12 + reconcRowCount * NOTE_LINE_H + 6;

      const availableY = FOOTER_Y + 4;
      const availableH  = SIG_LINE_Y - 16 - availableY;

      let ny = availableY + 6;

      if (totalH > availableH) {
        pdf.addPage();
        ny = MT + 4;
        setB(9); pdf.setTextColor(...C_BLACK);
        pdf.text(`${driver.name} – Historischer Stundennachweis ${monthName} ${year}`, ML, ny);
        ny += 7;
      }

      // Section title
      setB(8); pdf.setTextColor(...C_DARK);
      pdf.text('Historische Hinweise', ML, ny);
      ny += 1.5;
      pdf.setDrawColor(...C_DARK); pdf.setLineWidth(0.2);
      pdf.line(ML, ny, ML + 60, ny);
      ny += 5;

      // Intro text
      setN(7.5); pdf.setTextColor(...C_DARK);
      const introText = 'Dieser Stundennachweis wurde auf Basis der Einzelfahrt-Rekonstruktion und der übermittelten Steuerberater-Zielwerte erstellt. Das Fahrtenbuch bleibt unverändert dokumentiert.';
      const wrappedIntro = pdf.splitTextToSize(introText, TW - 4) as string[];
      for (const wl of wrappedIntro) {
        pdf.text(wl, ML + 2, ny);
        ny += NOTE_LINE_H;
      }
      ny += 2;

      if (gr) {
        // ── New gross reconciliation table ──────────────────────────────────
        setB(7.5); pdf.setTextColor(...C_DARK);
        pdf.text('Historische Brutto-Abstimmung', ML + 2, ny);
        ny += NOTE_LINE_H;

        setN(7); pdf.setTextColor(80, 80, 80);
        pdf.text('Abgleich laut Steuerberater Ziel-Brutto (inkl. aller Zuschläge)', ML + 2, ny);
        ny += NOTE_LINE_H + 1;

        const fmtH = (h: number) => `${h.toFixed(2).replace('.', ',')} h`;
        const fmtEur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

        const COL_BEZ2   = 64;
        const COL_H2     = 28;
        const COL_BETRAG = 38;
        const tblX2 = ML + 2;
        const tblHdrH2 = 5;
        const tblRowH2 = 5;

        const drawGrossRow = (
          cols: string[],
          rowY: number,
          rowH: number,
          isBold: boolean,
          bgColor?: [number, number, number],
        ) => {
          const widths = [COL_BEZ2, COL_H2, COL_BETRAG];
          let rx = tblX2;
          if (bgColor) {
            pdf.setFillColor(...bgColor);
            for (const w of widths) { pdf.rect(rx, rowY, w, rowH, 'F'); rx += w; }
          }
          rx = tblX2;
          if (isBold) setB(6.5); else setN(6.5);
          pdf.setTextColor(...C_DARK);
          const aligns: Array<'left' | 'right'> = ['left', 'right', 'right'];
          for (let i = 0; i < cols.length && i < widths.length; i++) {
            if (aligns[i] === 'right') {
              pdf.text(cols[i] ?? '', rx + widths[i] - 1, rowY + rowH - 1.5, { align: 'right' });
            } else {
              pdf.text(cols[i] ?? '', rx + 1, rowY + rowH - 1.5);
            }
            rx += widths[i];
          }
          pdf.setDrawColor(180, 180, 180); pdf.setLineWidth(0.15);
          rx = tblX2;
          for (const w of widths) {
            pdf.rect(rx, rowY, w, rowH, 'S');
            rx += w;
          }
        };

        drawGrossRow(['Lohnbestandteil', 'Stunden', 'Betrag'], ny, tblHdrH2, true, C_HBKG);
        ny += tblHdrH2;

        drawGrossRow(['Grundlohn aus Fahrten', fmtH(gr.grundlohnH), fmtEur(gr.grundlohnCents)], ny, tblRowH2, false);
        ny += tblRowH2;
        drawGrossRow(['Nachtarbeit-Zuschlag (20–06 Uhr, 25%)', fmtH(gr.nachtarbeitH), fmtEur(gr.nachtarbeitCents)], ny, tblRowH2, false);
        ny += tblRowH2;
        drawGrossRow(['Nacht 0–4-Zuschlag (00–04 Uhr, +25%)', fmtH(gr.nacht04H), fmtEur(gr.nacht04Cents)], ny, tblRowH2, false);
        ny += tblRowH2;
        drawGrossRow(['Sonntag-Zuschlag (50%)', fmtH(gr.sonntagH), fmtEur(gr.sonntagCents)], ny, tblRowH2, false);
        ny += tblRowH2;
        drawGrossRow(['Feiertag-Zuschlag (100%)', fmtH(gr.feiertagH), fmtEur(gr.feiertagCents)], ny, tblRowH2, false);
        ny += tblRowH2;

        if (gr.ausgleichCents > 0) {
          drawGrossRow(['Ausgleich (Basisstunden)', fmtH(gr.ausgleichH), fmtEur(gr.ausgleichCents)], ny, tblRowH2, false, [245, 240, 255]);
          ny += tblRowH2;
        }

        drawGrossRow(['Finales Brutto', '', fmtEur(gr.finalGrossCents)], ny, tblRowH2, true, C_HBKG);
        ny += tblRowH2;
        drawGrossRow(['Steuerberater Ziel-Brutto', '', fmtEur(gr.targetGrossCents)], ny, tblRowH2, false);
        ny += tblRowH2;

        const diff = gr.differenzCents;
        const diffStr = diff === 0 ? '0,00 €' : (diff > 0 ? `+${fmtEur(diff)}` : fmtEur(diff));
        drawGrossRow(['Differenz (Final – Ziel)', '', diffStr], ny, tblRowH2, false,
          diff === 0 ? [240, 255, 240] : (diff > 0 ? [255, 240, 240] : [255, 250, 230]));
        ny += tblRowH2;

        ny += 3;
        const statusOk = !gr.overTarget && gr.differenzCents === 0;
        if (statusOk) {
          setN(6.5); pdf.setTextColor(60, 100, 60);
          pdf.text('Abgleich: OK — Finales Brutto inkl. Zuschläge entspricht dem Steuerberater Ziel-Brutto.', ML + 2, ny);
        } else if (gr.overTarget) {
          setN(6.5); pdf.setTextColor(180, 30, 30);
          pdf.text('Hinweis: Brutto aus Fahrten inkl. Zuschläge übersteigt das Ziel-Brutto.', ML + 2, ny);
        } else {
          setN(6.5); pdf.setTextColor(180, 100, 0);
          pdf.text('Abgleich: Nicht OK — Differenz vorhanden. Cent-genaue Prüfung erforderlich.', ML + 2, ny);
        }
        ny += NOTE_LINE_H;

      } else if (historicalCorrections.length > 0) {
        // ── Legacy minutes-based corrections fallback ────────────────────────
        setB(7.5); pdf.setTextColor(...C_DARK);
        pdf.text('Historische Korrekturen', ML + 2, ny);
        ny += NOTE_LINE_H;

        setN(7); pdf.setTextColor(80, 80, 80);
        pdf.text('Korrektur laut übermittelter Steuerberater-Werte', ML + 2, ny);
        ny += NOTE_LINE_H + 1;

        const COL_LOHNART  = 28;
        const COL_BEZ      = 52;
        const COL_PLAN     = 22;
        const COL_KORR     = 22;
        const COL_FINAL    = 22;
        const COL_ZIEL     = 22;
        const COL_STATUS   = 18;
        const tblX = ML + 2;
        const tblHdrH = 5;
        const tblRowH = 5;

        const drawTableRow = (
          colData: string[],
          rowY: number,
          rowH: number,
          isBold: boolean,
          bgColor?: [number, number, number],
        ) => {
          const widths = [COL_LOHNART, COL_BEZ, COL_PLAN, COL_KORR, COL_FINAL, COL_ZIEL, COL_STATUS];
          let rx = tblX;
          if (bgColor) { pdf.setFillColor(...bgColor); }
          for (let i = 0; i < widths.length; i++) {
            if (bgColor) pdf.rect(rx, rowY, widths[i], rowH, 'F');
            rx += widths[i];
          }
          rx = tblX;
          if (isBold) setB(6.5); else setN(6.5);
          pdf.setTextColor(...C_DARK);
          for (let i = 0; i < colData.length && i < widths.length; i++) {
            pdf.text(colData[i] ?? '', rx + 1, rowY + rowH - 1.5);
            rx += widths[i];
          }
          pdf.setDrawColor(180, 180, 180); pdf.setLineWidth(0.15);
          rx = tblX;
          for (const w of widths) {
            pdf.rect(rx, rowY, w, rowH, 'S');
            rx += w;
          }
        };

        const fmtMins = (m: number) => {
          const h = Math.floor(m / 60); const mn = m % 60;
          return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
        };

        drawTableRow(
          ['Lohnart', 'Bezeichnung', 'Plan-Ist', 'Hist. Korrektur', 'Finale Summe', 'Zielwert', 'Status'],
          ny, tblHdrH, true, C_HBKG,
        );
        ny += tblHdrH;

        for (const c of historicalCorrections) {
          drawTableRow(
            [
              c.wageCode,
              c.wageLabel,
              fmtMins(c.planActualMins),
              `+${fmtMins(c.correctionMins)}`,
              fmtMins(c.finalMins),
              fmtMins(c.targetMins),
              'OK',
            ],
            ny, tblRowH, false,
          );
          ny += tblRowH;
        }

        ny += 3;
        setN(6.5); pdf.setTextColor(80, 80, 80);
        pdf.text('Abgleich: OK — alle Werte entsprechen den übermittelten Steuerberater-Zielwerten.', ML + 2, ny);
        ny += NOTE_LINE_H;

      } else {
        // No corrections needed
        setN(7.5); pdf.setTextColor(60, 100, 60);
        pdf.text('Abgleich OK — Plan-Ist entspricht dem Zielwert, keine Korrektur erforderlich.', ML + 2, ny);
        ny += NOTE_LINE_H;
      }

    } else {
      // ── Normal mode: existing behavior ────────────────────────────────────────
      const noteLines: string[] = [];

      for (const n of notes) {
        let dateStr = '';
        if (n.start_date && n.end_date && n.start_date !== n.end_date) {
          dateStr = `${fmtDate(n.start_date)}–${fmtDate(n.end_date)}`;
        } else {
          dateStr = fmtDate(n.note_date.slice(0, 10));
          const timeFromDate = fmtTime(n.note_date);
          const timeVal = timeFromDate || fmtTime(n.note_time);
          if (timeVal) dateStr += ` ${timeVal} Uhr`;
        }
        const typePart = n.note_type ? ` — ${n.note_type}` : '';
        const textPart = n.note_text ? ` — ${n.note_text}` : '';
        noteLines.push(`${dateStr}${typePart}${textPart}`);
      }

      if (warnings.length > 0) {
        const groups = categorizeWarnings(warnings);
        const summaryParts = groups.map(g => `${g.items.length} ${g.label}`);
        noteLines.push(`Generierungswarnungen: ${summaryParts.join(', ')}`);
        noteLines.push('');

        for (const g of groups) {
          if (g.category === 'critical') {
            noteLines.push(`${g.label} (${g.items.length}):`);
            for (const item of g.items.slice(0, 15)) {
              const display = item.date
                ? `${formatDateDE(item.date)}: ${item.text.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')}`
                : item.text;
              noteLines.push(`  ${display}`);
            }
            if (g.items.length > 15) noteLines.push(`  ... und ${g.items.length - 15} weitere`);
          } else if (g.category === 'target' || g.category === 'note') {
            noteLines.push(`${g.label} (${g.items.length}):`);
            for (const item of g.items.slice(0, 5)) {
              const display = item.date
                ? `${formatDateDE(item.date)}: ${item.text.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')}`
                : item.text;
              noteLines.push(`  ${display}`);
            }
            if (g.items.length > 5) noteLines.push(`  ... und ${g.items.length - 5} weitere`);
          } else {
            noteLines.push(`${g.label} (${g.items.length}) — Details im System sichtbar`);
          }
        }
      }

      const NOTE_LINE_H = 5.5;
      const NOTE_TITLE_H = 10;
      const NOTE_PADDING = 4;
      const totalNotesH = NOTE_TITLE_H + NOTE_PADDING + noteLines.length * NOTE_LINE_H + NOTE_PADDING;

      const availableY = FOOTER_Y + 4;
      const availableH  = SIG_LINE_Y - 16 - availableY;

      let ny = availableY + 6;

      if (totalNotesH > availableH) {
        pdf.addPage();
        ny = MT + 4;
        setB(9); pdf.setTextColor(...C_BLACK);
        pdf.text(`${driver.name} - Stundennachweis ${monthName} ${year}`, ML, ny);
        ny += 7;
      }

      setB(8); pdf.setTextColor(...C_DARK);
      pdf.text('Notizen / Hinweise', ML, ny);
      ny += 1.5;
      pdf.setDrawColor(...C_DARK); pdf.setLineWidth(0.2);
      pdf.line(ML, ny, ML + 60, ny);
      ny += 4;

      for (const line of noteLines) {
        const isWarn = line.startsWith('Hinweis:') || line.startsWith('Warnung:') || line.startsWith('Konflikt:');
        setN(7.5);
        pdf.setTextColor(isWarn ? 180 : C_DARK[0], isWarn ? 80 : C_DARK[1], isWarn ? 0 : C_DARK[2]);
        const maxLineW = TW - 4;
        const wrapped = pdf.splitTextToSize(line, maxLineW) as string[];
        for (const wl of wrapped) {
          pdf.text(wl, ML + 2, ny);
          ny += NOTE_LINE_H;
        }
      }
    }
  }

  return pdf;
}

export function exportStundennachweisAsPdf(
  data: StundennachweisExportData,
  filename?: string,
): void {
  const doc = _buildDoc(data);
  const monthName = MONTH_NAMES_DE[(data.month ?? 1) - 1] ?? 'Monat';
  const safeName = (data.driver?.name ?? 'Fahrer').replace(/[/\\:*?"<>|\s]+/g, '_');
  const fallback = `${data.isHistorical ? 'Historischer_' : ''}Stundennachweis_${safeName}_${monthName}_${data.year ?? ''}`;
  const plain = typeof filename === 'string' && filename.trim() ? filename.trim() : fallback;
  const base = data.simulated ? simulatedFileName(plain) : plain;
  doc.save(base.endsWith('.pdf') ? base : `${base}.pdf`);
}

export function getStundennachweisBlob(data: StundennachweisExportData): Blob {
  const doc = _buildDoc(data);
  return doc.output('blob');
}