import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { SalaryCalculation } from '../types/receipt';
import { CompanySettings } from '../types/settings';

export interface DriverPdfOptions {
  salary: SalaryCalculation;
  settings: CompanySettings | null;
  payrollGrossAmount?: number | null;
  payrollNetAmount?: number | null;
  cashSalaryAmount?: number;
  bankSalaryAmount?: number;
  totalNetPayout?: number;
}

function fmtEur(n: number | null | undefined): string {
  if (n == null) return '0,00 €';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtDateStr(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'dd.MM.yyyy', { locale: de });
  } catch {
    return dateStr;
  }
}

export function generateDriverSalaryPdf(opts: DriverPdfOptions): void {
  const {
    salary,
    settings,
    payrollGrossAmount,
    payrollNetAmount,
    cashSalaryAmount,
    bankSalaryAmount,
    totalNetPayout,
  } = opts;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const marginL = 20;
  const marginR = 20;
  const contentW = pageW - marginL - marginR;
  const col2 = marginL + contentW;

  const companyName = settings?.company_name || 'Unternehmen';
  const calculatedSalaryTotal = salary.netto_salary ?? salary.amount_due ?? 0;
  const hasPayroll = payrollGrossAmount != null || payrollNetAmount != null;

  // ─── Header band ───
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, pageW, 38, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Fahrer-Zusammenfassung', marginL, 15);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Gehaltsübersicht · Interne Auswertung', marginL, 22);

  const periodLabel = salary.period_start && salary.period_end
    ? `${fmtDateStr(salary.period_start)} – ${fmtDateStr(salary.period_end)}`
    : format(new Date(), 'MM/yyyy', { locale: de });
  doc.text(`Zeitraum: ${periodLabel}`, marginL, 29);

  let y = 50;

  // ─── Company info ───
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(companyName, marginL, y);
  y += 6;
  if (settings?.address) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text(settings.address, marginL, y);
    y += 5;
  }
  y += 4;
  doc.setDrawColor(200, 200, 200);
  doc.line(marginL, y, pageW - marginR, y);
  y += 8;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(`Fahrer: ${salary.driver_name}`, marginL, y);
  y += 12;

  // ─── Salary calculation card ───
  const calcCardY = y;
  const calcCardH = 52;
  doc.setFillColor(247, 250, 255);
  doc.setDrawColor(220, 230, 245);
  doc.roundedRect(calcCardY > 0 ? marginL : marginL, calcCardY, contentW, calcCardH, 3, 3, 'FD');

  y = calcCardY + 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(37, 99, 235);
  doc.text('Gehaltsberechnung', marginL + 6, y);
  y += 7;

  const tableRows: [string, string, boolean?][] = [
    [`Gesamtumsatz`, fmtEur(salary.revenue)],
    [`Umsatzanteil (${(salary.salary_ratio * 100).toFixed(0)}%)`, fmtEur(salary.revenue_share)],
    ['Trinkgeld (100%)', fmtEur(salary.tips)],
  ];

  if (salary.netto_salary != null && salary.netto_salary !== salary.amount_due) {
    tableRows.push(['Berechneter Betrag (System)', fmtEur(salary.amount_due)]);
    tableRows.push(['Manuell angepasst', fmtEur(salary.netto_salary), true]);
  }

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(50, 50, 50);
  for (const [label, value, highlight] of tableRows) {
    if (highlight) { doc.setFont('helvetica', 'bold'); doc.setTextColor(37, 99, 235); }
    else { doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50); }
    doc.text(label, marginL + 6, y);
    doc.text(value, col2 - 2, y, { align: 'right' });
    y += 6;
  }

  // Total line
  y += 1;
  doc.setDrawColor(37, 99, 235);
  doc.line(marginL + 6, y, col2 - 2, y);
  y += 5;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30, 30, 30);
  doc.text('Berechnetes Fahrer-Gehalt', marginL + 6, y);
  doc.text(fmtEur(calculatedSalaryTotal), col2 - 2, y, { align: 'right' });
  y = calcCardY + calcCardH + 10;

  // ─── Payroll split card (only if data provided) ───
  if (hasPayroll) {
    const gross = payrollGrossAmount ?? 0;
    const net = payrollNetAmount ?? 0;
    const cash = cashSalaryAmount ?? (calculatedSalaryTotal - gross);
    const bank = bankSalaryAmount ?? net;
    const total = totalNetPayout ?? (cash + bank);
    const cashNeg = cash < -0.01;

    const splitCardY = y;
    const splitCardH = 62;
    doc.setFillColor(240, 253, 244);
    doc.setDrawColor(134, 239, 172);
    doc.roundedRect(marginL, splitCardY, contentW, splitCardH, 3, 3, 'FD');

    let sy = splitCardY + 8;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(22, 163, 74);
    doc.text('Lohnabrechnung & Auszahlung', marginL + 6, sy);
    sy += 7;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(50, 50, 50);

    doc.text('Brutto in Lohnabrechnung', marginL + 6, sy);
    doc.text(fmtEur(gross), col2 - 2, sy, { align: 'right' });
    sy += 6;

    doc.text('Netto laut Lohnabrechnung / Bankgehalt', marginL + 6, sy);
    doc.text(fmtEur(net), col2 - 2, sy, { align: 'right' });
    sy += 8;

    doc.setDrawColor(134, 239, 172);
    doc.line(marginL + 6, sy, col2 - 2, sy);
    sy += 5;

    // Bargehalt
    doc.text('Bargehalt', marginL + 6, sy);
    if (cashNeg) doc.setTextColor(220, 38, 38);
    doc.text(fmtEur(cash) + (cashNeg ? ' ⚠' : ''), col2 - 2, sy, { align: 'right' });
    doc.setTextColor(50, 50, 50);
    sy += 6;

    // Bankgehalt
    doc.text('Bankgehalt', marginL + 6, sy);
    doc.text(fmtEur(bank), col2 - 2, sy, { align: 'right' });
    sy += 8;

    doc.setDrawColor(134, 239, 172);
    doc.line(marginL + 6, sy, col2 - 2, sy);
    sy += 5;

    // Total net payout
    doc.setFont('helvetica', 'bold');
    if (cashNeg) doc.setTextColor(202, 138, 4); else doc.setTextColor(22, 163, 74);
    doc.text('Gesamt Netto Auszahlung', marginL + 6, sy);
    doc.text(fmtEur(total), col2 - 2, sy, { align: 'right' });

    y = splitCardY + splitCardH + 10;
  }

  // ─── Payment status ───
  const statusCardY = y;
  doc.setFillColor(248, 248, 248);
  doc.setDrawColor(220, 220, 220);
  doc.roundedRect(marginL, statusCardY, contentW, 22, 3, 3, 'FD');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(50, 50, 50);
  doc.text('Zahlungsstatus', marginL + 6, statusCardY + 8);

  const statusLabel = salary.payment_status === 'paid' ? 'Vollständig bezahlt'
    : salary.payment_status === 'partially_paid' ? 'Teilweise bezahlt'
    : 'Ausstehend';
  const sc = salary.payment_status === 'paid' ? [22, 163, 74] : salary.payment_status === 'partially_paid' ? [202, 138, 4] : [220, 38, 38];
  doc.setTextColor(sc[0], sc[1], sc[2]);
  doc.text(statusLabel, col2 - 2, statusCardY + 8, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  doc.text(`Bezahlt: ${fmtEur(salary.total_paid ?? 0)}`, marginL + 6, statusCardY + 15);
  doc.text(`Restbetrag: ${fmtEur(salary.remaining_balance ?? 0)}`, col2 - 2, statusCardY + 15, { align: 'right' });

  y = statusCardY + 32;

  // ─── Signature lines ───
  y = Math.max(y, 210);
  doc.setDrawColor(180, 180, 180);
  doc.line(marginL, y, marginL + 70, y);
  doc.line(pageW - marginR - 70, y, pageW - marginR, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  doc.text('Arbeitgeber / Unterschrift', marginL, y + 5);
  doc.text('Fahrer / Unterschrift', pageW - marginR - 70, y + 5);
  doc.text('Ort, Datum: ________________________________', marginL, y + 14);

  // ─── Disclaimer ───
  y += 28;
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  const disclaimer = 'Diese Übersicht dient nur zur internen Prüfung und ersetzt keine offizielle Lohnabrechnung. Steuerliche Behandlung bitte mit dem Steuerberater prüfen.';
  const disclaimerLines = doc.splitTextToSize(disclaimer, contentW);
  doc.text(disclaimerLines, marginL, y);

  // ─── Page footer ───
  const footerY = 285;
  doc.setDrawColor(230, 230, 230);
  doc.line(marginL, footerY, pageW - marginR, footerY);
  doc.setFontSize(8);
  doc.setTextColor(160, 160, 160);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy', { locale: de })}`, marginL, footerY + 5);
  doc.text('Vertraulich · Nur für interne Verwendung', pageW / 2, footerY + 5, { align: 'center' });
  doc.text(companyName, pageW - marginR, footerY + 5, { align: 'right' });

  // ─── Save ───
  const safeName = salary.driver_name.replace(/[^a-zA-Z0-9äöüÄÖÜß ]/g, '_');
  const periodSafe = salary.period_start
    ? format(new Date(salary.period_start), 'yyyy-MM', { locale: de })
    : format(new Date(), 'yyyy-MM', { locale: de });
  doc.save(`Fahrer-Zusammenfassung_${safeName}_${periodSafe}.pdf`);
}
