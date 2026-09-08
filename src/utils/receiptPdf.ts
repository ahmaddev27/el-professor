import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Receipt, PAYMENT_METHODS } from '../types/receipt';
import { PdfFilterInfo } from '../components/ReceiptList';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtDate(iso: string) {
  try { return format(new Date(iso), 'dd.MM.yyyy'); } catch { return iso; }
}

function monthLabel(yyyyMM: string): string {
  if (!yyyyMM) return '';
  try {
    return format(new Date(yyyyMM + '-01'), 'MMMM yyyy', { locale: de });
  } catch { return yyyyMM; }
}

// Capitalise first char
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── colour palette ───────────────────────────────────────────────────────────
const C = {
  bg:         [13, 20, 33] as [number, number, number],
  surface:    [20, 30, 48] as [number, number, number],
  card:       [26, 38, 60] as [number, number, number],
  border:     [40, 60, 90] as [number, number, number],
  accent:     [59, 130, 246] as [number, number, number],
  accentDim:  [30, 58, 138] as [number, number, number],
  textPrime:  [230, 240, 255] as [number, number, number],
  textSecond: [148, 163, 184] as [number, number, number],
  textDim:    [71, 85, 105] as [number, number, number],
  danger:     [239, 68, 68] as [number, number, number],
  dangerDim:  [69, 10, 10] as [number, number, number],
  success:    [52, 211, 153] as [number, number, number],
  successDim: [6, 78, 59] as [number, number, number],
  orange:     [251, 146, 60] as [number, number, number],
  gold:       [234, 179, 8] as [number, number, number],
};

// ─── drawing helpers ──────────────────────────────────────────────────────────

function setFill(doc: jsPDF, rgb: [number, number, number]) { doc.setFillColor(...rgb); }
function setStroke(doc: jsPDF, rgb: [number, number, number]) { doc.setDrawColor(...rgb); }
function setTextColor(doc: jsPDF, rgb: [number, number, number]) { doc.setTextColor(...rgb); }

function rect(doc: jsPDF, x: number, y: number, w: number, h: number, fill: [number,number,number], radius = 0) {
  setFill(doc, fill);
  if (radius > 0) doc.roundedRect(x, y, w, h, radius, radius, 'F');
  else doc.rect(x, y, w, h, 'F');
}

function borderedRect(doc: jsPDF, x: number, y: number, w: number, h: number, fill: [number,number,number], stroke: [number,number,number], radius = 2, lineWidth = 0.3) {
  setFill(doc, fill);
  setStroke(doc, stroke);
  doc.setLineWidth(lineWidth);
  if (radius > 0) doc.roundedRect(x, y, w, h, radius, radius, 'FD');
  else doc.rect(x, y, w, h, 'FD');
}

function text(doc: jsPDF, str: string, x: number, y: number, color: [number,number,number], size: number, bold = false, align: 'left'|'right'|'center' = 'left') {
  setTextColor(doc, color);
  doc.setFontSize(size);
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.text(str, x, y, { align });
}

function divider(doc: jsPDF, x: number, y: number, w: number, color: [number,number,number] = C.border) {
  setStroke(doc, color);
  doc.setLineWidth(0.2);
  doc.line(x, y, x + w, y);
}

// ─── page helpers ─────────────────────────────────────────────────────────────

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

function addPage(doc: jsPDF) {
  doc.addPage();
  rect(doc, 0, 0, PAGE_W, PAGE_H, C.bg);
}

function addPageNumber(doc: jsPDF, pageNum: number, totalPages: number) {
  const label = `Seite ${pageNum} / ${totalPages}`;
  text(doc, label, PAGE_W / 2, PAGE_H - 8, C.textDim, 7.5, false, 'center');
  text(doc, 'El-Professor Verwaltungssystem', MARGIN, PAGE_H - 8, C.textDim, 7, false, 'left');
  text(doc, 'Diese Übersicht wurde anhand der aktuell gesetzten Filter erstellt.', PAGE_W - MARGIN, PAGE_H - 8, C.textDim, 7, false, 'right');
}

// ─── main export ─────────────────────────────────────────────────────────────

export function generateReceiptPdf(receipts: Receipt[], info: PdfFilterInfo): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── cover page ──────────────────────────────────────────────────────────────
  rect(doc, 0, 0, PAGE_W, PAGE_H, C.bg);

  // accent top bar
  rect(doc, 0, 0, PAGE_W, 3, C.accent);

  let y = 24;

  // Logo area / company header
  const company = info.companyName || 'El-Professor';
  text(doc, company.toUpperCase(), PAGE_W / 2, y, C.accent, 10, true, 'center');
  y += 7;

  // Main title
  text(doc, 'BELEGE ZUSAMMENFASSUNG', PAGE_W / 2, y, C.textPrime, 18, true, 'center');
  y += 5;
  divider(doc, MARGIN + 20, y, CONTENT_W - 40, C.accentDim);
  y += 8;

  // Subtitle — creation date
  const now = new Date();
  text(doc, `Erstellt am ${format(now, 'dd.MM.yyyy')} um ${format(now, 'HH:mm')} Uhr`, PAGE_W / 2, y, C.textSecond, 9, false, 'center');
  y += 14;

  // ── info cards row ──────────────────────────────────────────────────────────
  const cardH = 28;
  const gap = 4;
  const cardW = (CONTENT_W - gap * 2) / 3;

  // card 1 — Fahrer
  const driverLabel = info.driver || 'Alle Fahrer';
  borderedRect(doc, MARGIN, y, cardW, cardH, C.card, C.border, 3);
  text(doc, 'FAHRER', MARGIN + cardW / 2, y + 8, C.textDim, 7, true, 'center');
  text(doc, driverLabel, MARGIN + cardW / 2, y + 17, C.textPrime, 9.5, true, 'center');

  // card 2 — Zeitraum
  const x2 = MARGIN + cardW + gap;
  borderedRect(doc, x2, y, cardW, cardH, C.card, C.border, 3);
  text(doc, 'ZEITRAUM', x2 + cardW / 2, y + 8, C.textDim, 7, true, 'center');
  let zeitraum = '';
  if (info.weekRange) {
    zeitraum = `${format(info.weekRange.start, 'dd.MM.yyyy')} – ${format(info.weekRange.end, 'dd.MM.yyyy')}`;
  } else if (info.selectedMonth) {
    zeitraum = cap(monthLabel(info.selectedMonth));
  } else {
    zeitraum = 'Alle Zeiträume';
  }
  text(doc, zeitraum, x2 + cardW / 2, y + 17, C.textPrime, 8.5, true, 'center');

  // card 3 — Monat / Woche
  const x3 = MARGIN + (cardW + gap) * 2;
  borderedRect(doc, x3, y, cardW, cardH, C.card, C.border, 3);
  text(doc, 'MONAT / WOCHE', x3 + cardW / 2, y + 8, C.textDim, 7, true, 'center');
  let mwLabel = '';
  if (info.selectedMonth) mwLabel = cap(monthLabel(info.selectedMonth));
  if (info.selectedWeek !== null) mwLabel += (mwLabel ? ' · ' : '') + `Woche ${info.selectedWeek}`;
  if (!mwLabel) mwLabel = 'Gesamter Zeitraum';
  text(doc, mwLabel, x3 + cardW / 2, y + 17, C.textPrime, 8.5, true, 'center');

  y += cardH + 10;

  // ── summary section title ───────────────────────────────────────────────────
  text(doc, 'BELEGEÜBERSICHT', MARGIN, y, C.accent, 9, true);
  y += 3;
  divider(doc, MARGIN, y, CONTENT_W, C.accentDim);
  y += 8;

  // ── compute summary stats ───────────────────────────────────────────────────
  const total = receipts.reduce((s, r) => s + r.expense, 0);
  const count = receipts.length;
  const avg = count > 0 ? total / count : 0;
  const max = count > 0 ? Math.max(...receipts.map(r => r.expense)) : 0;

  // category breakdown
  const catMap = new Map<string, { count: number; amount: number }>();
  for (const r of receipts) {
    const cat = r.description || 'Sonstiges';
    const existing = catMap.get(cat) ?? { count: 0, amount: 0 };
    catMap.set(cat, { count: existing.count + 1, amount: existing.amount + r.expense });
  }

  // payment method breakdown
  const pmMap = new Map<string, number>();
  for (const r of receipts) {
    const pm = r.paymentMethod || 'bar';
    pmMap.set(pm, (pmMap.get(pm) ?? 0) + r.expense);
  }

  // ── stat cards (2 rows × 3) ─────────────────────────────────────────────────
  const statH = 22;
  const statW = (CONTENT_W - gap * 2) / 3;
  const statData = [
    { label: 'ANZAHL BELEGE', value: String(count), color: C.accent },
    { label: 'GESAMTBETRAG', value: fmtEur(total), color: C.danger },
    { label: 'DURCHSCHNITT PRO BELEG', value: fmtEur(avg), color: C.orange },
    { label: 'HÖCHSTER BELEG', value: fmtEur(max), color: C.gold },
    { label: 'ZAHLUNGSARTEN', value: String(pmMap.size), color: C.success },
    { label: 'KATEGORIEN', value: String(catMap.size), color: C.textSecond },
  ];

  for (let i = 0; i < statData.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const sx = MARGIN + col * (statW + gap);
    const sy = y + row * (statH + 3);
    borderedRect(doc, sx, sy, statW, statH, C.card, C.border, 3);
    text(doc, statData[i].label, sx + 5, sy + 8, C.textDim, 6.5, true);
    text(doc, statData[i].value, sx + 5, sy + 17, statData[i].color, 10.5, true);
  }

  y += 2 * (statH + 3) + 8;

  // ── payment method breakdown ────────────────────────────────────────────────
  if (pmMap.size > 0) {
    text(doc, 'ZAHLUNGSARTEN', MARGIN, y, C.textSecond, 8, true);
    y += 3;
    divider(doc, MARGIN, y, CONTENT_W, C.border);
    y += 5;

    const pmEntries = Array.from(pmMap.entries());
    const pmW = (CONTENT_W - (pmEntries.length - 1) * 3) / Math.min(pmEntries.length, 4);
    pmEntries.forEach(([pm, amount], idx) => {
      if (idx >= 4) return;
      const px = MARGIN + idx * (pmW + 3);
      borderedRect(doc, px, y, pmW, 16, C.surface, C.border, 2);
      const label = PAYMENT_METHODS[pm as keyof typeof PAYMENT_METHODS] || pm;
      text(doc, label, px + pmW / 2, y + 7, C.textSecond, 7, false, 'center');
      text(doc, fmtEur(amount), px + pmW / 2, y + 13.5, C.textPrime, 8, true, 'center');
    });
    y += 22;
  }

  // ── category breakdown table ────────────────────────────────────────────────
  if (catMap.size > 0) {
    // check space
    if (y > PAGE_H - 60) { addPage(doc); y = 20; }

    text(doc, 'KATEGORIEN / BESCHREIBUNGEN', MARGIN, y, C.textSecond, 8, true);
    y += 3;
    divider(doc, MARGIN, y, CONTENT_W, C.border);
    y += 5;

    // header row
    rect(doc, MARGIN, y, CONTENT_W, 7, C.accentDim);
    text(doc, 'Bezeichnung', MARGIN + 3, y + 5, C.textPrime, 7, true);
    text(doc, 'Anzahl', MARGIN + CONTENT_W * 0.65 - 3, y + 5, C.textPrime, 7, true, 'right');
    text(doc, 'Betrag', MARGIN + CONTENT_W - 3, y + 5, C.textPrime, 7, true, 'right');
    y += 9;

    const catEntries = Array.from(catMap.entries()).sort((a, b) => b[1].amount - a[1].amount);
    for (let i = 0; i < catEntries.length; i++) {
      if (y > PAGE_H - 25) { addPage(doc); y = 20; }
      const [cat, stats] = catEntries[i];
      const rowBg = i % 2 === 0 ? C.surface : C.card;
      rect(doc, MARGIN, y - 1, CONTENT_W, 7.5, rowBg);
      // truncate long category names
      const catDisplay = cat.length > 45 ? cat.slice(0, 44) + '…' : cat;
      text(doc, catDisplay, MARGIN + 3, y + 5, C.textPrime, 7);
      text(doc, String(stats.count), MARGIN + CONTENT_W * 0.65 - 3, y + 5, C.textSecond, 7, false, 'right');
      text(doc, fmtEur(stats.amount), MARGIN + CONTENT_W - 3, y + 5, C.accent, 7, true, 'right');
      y += 7.5;
    }
    y += 6;
  }

  // ── receipt list ────────────────────────────────────────────────────────────
  if (receipts.length === 0) {
    if (y > PAGE_H - 30) { addPage(doc); y = 20; }
    text(doc, 'Keine Belege für die aktuellen Filter gefunden.', PAGE_W / 2, y + 10, C.textSecond, 9, false, 'center');
  } else {
    // Start receipts on a new page for clarity
    addPage(doc);
    y = 20;

    text(doc, 'BELEGLISTE', MARGIN, y, C.accent, 10, true);
    y += 3;
    divider(doc, MARGIN, y, CONTENT_W, C.accentDim);
    y += 7;

    // column widths
    const colDate = 22;
    const colDriver = 35;
    const colDesc = CONTENT_W - colDate - colDriver - 22 - 28;
    const colPay = 22;
    const colAmt = 28;

    // table header
    rect(doc, MARGIN, y, CONTENT_W, 8, C.accentDim);
    let cx = MARGIN + 2;
    text(doc, 'Datum', cx, y + 5.5, C.textPrime, 7, true); cx += colDate;
    text(doc, 'Fahrer', cx, y + 5.5, C.textPrime, 7, true); cx += colDriver;
    text(doc, 'Beschreibung', cx, y + 5.5, C.textPrime, 7, true); cx += colDesc;
    text(doc, 'Zahlung', cx, y + 5.5, C.textPrime, 7, true); cx += colPay;
    text(doc, 'Betrag', MARGIN + CONTENT_W - 2, y + 5.5, C.textPrime, 7, true, 'right');
    y += 10;

    const sorted = [...receipts].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const rowH = 8;

      if (y > PAGE_H - 22) { addPage(doc); y = 20; }

      const rowBg = i % 2 === 0 ? C.surface : C.card;
      rect(doc, MARGIN, y, CONTENT_W, rowH, rowBg);

      cx = MARGIN + 2;
      text(doc, fmtDate(r.date), cx, y + 5.5, C.textSecond, 7); cx += colDate;

      const driverStr = (r.driverName || '').length > 16 ? r.driverName.slice(0, 15) + '…' : r.driverName || '-';
      text(doc, driverStr, cx, y + 5.5, C.textPrime, 7); cx += colDriver;

      const descStr = (r.description || '').length > 30 ? r.description.slice(0, 29) + '…' : r.description || '-';
      text(doc, descStr, cx, y + 5.5, C.textSecond, 7); cx += colDesc;

      const pm = r.paymentMethod ? PAYMENT_METHODS[r.paymentMethod as keyof typeof PAYMENT_METHODS] || r.paymentMethod : 'Bar';
      const pmShort = pm.length > 10 ? pm.slice(0, 9) + '…' : pm;
      text(doc, pmShort, cx, y + 5.5, C.textSecond, 7); cx += colPay;

      const amtColor = r.expense > 0 ? C.danger : C.success;
      text(doc, fmtEur(r.expense), MARGIN + CONTENT_W - 2, y + 5.5, amtColor, 7, true, 'right');
      y += rowH;
    }

    // Total row
    rect(doc, MARGIN, y, CONTENT_W, 9, C.accentDim);
    text(doc, 'GESAMT', MARGIN + 2, y + 6, C.textPrime, 7.5, true);
    text(doc, fmtEur(total), MARGIN + CONTENT_W - 2, y + 6, C.danger, 9, true, 'right');
    y += 12;
  }

  // ── footer on all pages ─────────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    // Bottom bar
    rect(doc, 0, PAGE_H - 14, PAGE_W, 14, C.surface);
    rect(doc, 0, PAGE_H - 14, PAGE_W, 0.4, C.accentDim);
    addPageNumber(doc, p, totalPages);
  }

  // ── filename ─────────────────────────────────────────────────────────────────
  const driverPart = info.driver
    ? info.driver.replace(/\s+/g, '_').replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    : 'Alle_Fahrer';
  const monthPart = info.selectedMonth
    ? cap(monthLabel(info.selectedMonth)).replace(/\s+/g, '_').replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue')
    : '';
  const weekPart = info.selectedWeek !== null ? `_Woche_${info.selectedWeek}` : '';
  const filename = `Belege_Zusammenfassung_${driverPart}${monthPart ? '_' + monthPart : ''}${weekPart}.pdf`;

  doc.save(filename);
}
