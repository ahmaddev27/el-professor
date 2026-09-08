import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

const C = {
  bg:         [255, 255, 255] as [number, number, number],
  surface:    [248, 250, 252] as [number, number, number],
  border:     [203, 213, 225] as [number, number, number],
  accent:     [15, 118, 110] as [number, number, number],
  accentLight:[204, 251, 241] as [number, number, number],
  textPrime:  [15, 23, 42] as [number, number, number],
  textSecond: [71, 85, 105] as [number, number, number],
  textDim:    [148, 163, 184] as [number, number, number],
  success:    [22, 163, 74] as [number, number, number],
  warning:    [217, 119, 6] as [number, number, number],
};

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

const MONTHS_DE = [
  'Januar', 'Februar', 'M\u00E4rz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export interface InvoicePdfData {
  invoiceNumber: string;
  invoiceMonth: number;
  invoiceYear: number;
  amount: number;
  status: string;
  dueDate: string;
  paidAt: string | null;
  collectedByName: string | null;
  receiptNote: string | null;
  companyName: string;
  companyAddress: string | null;
  planName: string;
  sellerName: string;
  sellerAddress: string;
  sellerTaxInfo: string;
  sellerBank: string;
}

export function generateSubscriptionPdf(data: InvoicePdfData): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210;
  const M = 20;
  const contentW = W - 2 * M;
  let y = M;

  const isPaid = data.status === 'paid';
  const title = isPaid ? 'Quittung' : 'Rechnung';

  // Header bar
  doc.setFillColor(...C.accent);
  doc.rect(0, 0, W, 40, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text(title, M, 26);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Nr. ${data.invoiceNumber}`, W - M, 26, { align: 'right' });

  y = 52;

  // Seller info (left)
  doc.setFontSize(8);
  doc.setTextColor(...C.textDim);
  doc.text('VON', M, y);
  y += 5;
  doc.setFontSize(10);
  doc.setTextColor(...C.textPrime);
  doc.setFont('helvetica', 'bold');
  doc.text(data.sellerName, M, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.textSecond);
  const sellerLines = doc.splitTextToSize(data.sellerAddress, contentW / 2 - 5);
  doc.text(sellerLines, M, y);
  y += sellerLines.length * 4.5;
  if (data.sellerTaxInfo) {
    doc.setFontSize(8);
    doc.text(data.sellerTaxInfo, M, y + 2);
  }

  // Buyer info (right)
  let ry = 52;
  doc.setFontSize(8);
  doc.setTextColor(...C.textDim);
  doc.text('AN', W / 2 + 5, ry);
  ry += 5;
  doc.setFontSize(10);
  doc.setTextColor(...C.textPrime);
  doc.setFont('helvetica', 'bold');
  doc.text(data.companyName, W / 2 + 5, ry);
  ry += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.textSecond);
  if (data.companyAddress) {
    const buyerLines = doc.splitTextToSize(data.companyAddress, contentW / 2 - 5);
    doc.text(buyerLines, W / 2 + 5, ry);
  }

  y = Math.max(y, 85) + 5;

  // Divider
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.line(M, y, W - M, y);
  y += 10;

  // Invoice details
  doc.setFontSize(8);
  doc.setTextColor(...C.textDim);
  const labels = ['Zeitraum', 'F\u00E4llig am', 'Zahlungsart', 'Status'];
  const monthLabel = `${MONTHS_DE[data.invoiceMonth - 1]} ${data.invoiceYear}`;
  let dueDateStr: string;
  try { dueDateStr = format(new Date(data.dueDate), 'dd.MM.yyyy'); } catch { dueDateStr = data.dueDate; }
  const statusLabel = isPaid ? 'Bezahlt' : data.status === 'overdue' ? '\u00DCberf\u00E4llig' : data.status === 'canceled' ? 'Storniert' : 'Offen';
  const values = [monthLabel, dueDateStr, 'Barzahlung', statusLabel];

  const colW = contentW / labels.length;
  labels.forEach((lbl, i) => {
    const x = M + i * colW;
    doc.setFontSize(8);
    doc.setTextColor(...C.textDim);
    doc.text(lbl, x, y);
    doc.setFontSize(10);
    doc.setTextColor(...C.textPrime);
    doc.setFont('helvetica', 'bold');
    doc.text(values[i], x, y + 5);
    doc.setFont('helvetica', 'normal');
  });

  y += 18;

  // Line items table
  doc.setFillColor(...C.surface);
  doc.roundedRect(M, y, contentW, 10, 1, 1, 'F');
  doc.setFontSize(8);
  doc.setTextColor(...C.textDim);
  doc.text('BESCHREIBUNG', M + 4, y + 6.5);
  doc.text('BETRAG', W - M - 4, y + 6.5, { align: 'right' });
  y += 12;

  doc.setFontSize(10);
  doc.setTextColor(...C.textPrime);
  doc.text(`Monatliches Abonnement \u2013 ${data.planName}`, M + 4, y + 5);
  doc.text(fmtEur(data.amount), W - M - 4, y + 5, { align: 'right' });
  doc.setFontSize(8);
  doc.setTextColor(...C.textSecond);
  doc.text(`${MONTHS_DE[data.invoiceMonth - 1]} ${data.invoiceYear}`, M + 4, y + 10);
  y += 16;

  // Divider
  doc.setDrawColor(...C.border);
  doc.line(M, y, W - M, y);
  y += 6;

  // Total
  doc.setFillColor(...C.accent);
  doc.roundedRect(W - M - 60, y - 2, 60, 12, 1, 1, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Gesamt:', W - M - 56, y + 6);
  doc.text(fmtEur(data.amount), W - M - 4, y + 6, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 20;

  // Payment confirmation block (if paid)
  if (isPaid && data.paidAt) {
    doc.setFillColor(220, 252, 231);
    doc.roundedRect(M, y, contentW, 28, 2, 2, 'F');
    doc.setDrawColor(...C.success);
    doc.setLineWidth(0.5);
    doc.roundedRect(M, y, contentW, 28, 2, 2, 'S');

    doc.setFontSize(11);
    doc.setTextColor(...C.success);
    doc.setFont('helvetica', 'bold');
    doc.text('BEZAHLT', M + 6, y + 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...C.textSecond);

    let paidDateStr: string;
    try { paidDateStr = format(new Date(data.paidAt), 'dd.MM.yyyy, HH:mm', { locale: de }); } catch { paidDateStr = data.paidAt; }
    doc.text(`Bezahlt am: ${paidDateStr}`, M + 6, y + 15);
    if (data.collectedByName) {
      doc.text(`Eingesammelt von: ${data.collectedByName}`, M + 6, y + 21);
    }
    y += 34;
  }

  // Note
  if (data.receiptNote) {
    doc.setFontSize(8);
    doc.setTextColor(...C.textDim);
    doc.text('ANMERKUNG', M, y + 2);
    doc.setFontSize(9);
    doc.setTextColor(...C.textSecond);
    const noteLines = doc.splitTextToSize(data.receiptNote, contentW);
    doc.text(noteLines, M, y + 7);
    y += 7 + noteLines.length * 4;
  }

  // Footer
  const footerY = 275;
  doc.setDrawColor(...C.border);
  doc.line(M, footerY, W - M, footerY);
  doc.setFontSize(7);
  doc.setTextColor(...C.textDim);
  if (data.sellerBank) {
    doc.text(data.sellerBank, M, footerY + 5);
  }
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy, HH:mm', { locale: de })}`, W - M, footerY + 5, { align: 'right' });

  return doc;
}
