import React from 'react';
import { X, Download, CheckCircle, Clock, AlertTriangle, XCircle, Banknote } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

const MONTHS_DE = [
  'Januar', 'Februar', 'M\u00E4rz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

interface Invoice {
  id: string;
  company_id: string;
  invoice_month: number;
  invoice_year: number;
  invoice_number: string;
  amount: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  cash_received_amount: number | null;
  receipt_note: string | null;
  created_at: string;
  companies?: { name: string; email?: string | null; street?: string | null; house_number?: string | null; postal_code?: string | null; city?: string | null } | null;
  company_subscriptions?: { plan_id: string; subscription_plans: { name: string } | null } | null;
}

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onDownloadPdf: () => void;
  sellerSettings: any;
}

export default function InvoiceDetailModal({ invoice, onClose, onDownloadPdf, sellerSettings }: Props) {
  const isPaid = invoice.status === 'paid';
  const isOverdue = invoice.status === 'open' && new Date(invoice.due_date) < new Date();
  const co = invoice.companies;
  const planName = invoice.company_subscriptions?.subscription_plans?.name || 'Abonnement';

  const row = (label: string, value: string | React.ReactNode) => (
    <div className="flex justify-between py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="text-sm font-medium text-right" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h2 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
              {isPaid ? 'Quittung' : 'Rechnung'} {invoice.invoice_number}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{co?.name || 'Unbekannt'}</p>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-tertiary)' }}><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Status banner */}
          <div className="flex items-center gap-3 p-3.5 rounded-xl" style={{
            background: isPaid ? 'rgba(34,197,94,0.08)' : isOverdue ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
            border: `1px solid ${isPaid ? 'var(--success)' : isOverdue ? 'var(--danger)' : 'var(--accent)'}`,
          }}>
            {isPaid ? <CheckCircle size={20} style={{ color: 'var(--success)' }} /> : isOverdue ? <AlertTriangle size={20} style={{ color: 'var(--danger)' }} /> : <Clock size={20} style={{ color: 'var(--accent)' }} />}
            <span className="font-semibold text-sm" style={{ color: isPaid ? 'var(--success)' : isOverdue ? 'var(--danger)' : 'var(--accent)' }}>
              {isPaid ? 'Bezahlt' : isOverdue ? '\u00DCberf\u00E4llig' : invoice.status === 'canceled' ? 'Storniert' : 'Offen'}
            </span>
          </div>

          {/* Details */}
          <div>
            {row('Firma', co?.name || '-')}
            {co?.street && row('Adresse', `${co.street} ${co.house_number || ''}, ${co.postal_code || ''} ${co.city || ''}`)}
            {row('Plan', planName)}
            {row('Zeitraum', `${MONTHS_DE[invoice.invoice_month - 1]} ${invoice.invoice_year}`)}
            {row('Rechnungsnummer', invoice.invoice_number)}
            {row('Betrag', <span className="text-base font-bold" style={{ color: 'var(--accent)' }}>{fmtEur(invoice.amount)}</span>)}
            {row('Zahlungsart', 'Barzahlung')}
            {row('F\u00E4llig am', (() => { try { return format(new Date(invoice.due_date), 'dd.MM.yyyy'); } catch { return invoice.due_date; } })())}
            {isPaid && invoice.paid_at && row('Bezahlt am', (() => { try { return format(new Date(invoice.paid_at), 'dd.MM.yyyy, HH:mm', { locale: de }); } catch { return invoice.paid_at; } })())}
            {isPaid && invoice.cash_received_amount != null && row('Erhalten', fmtEur(invoice.cash_received_amount))}
            {invoice.receipt_note && row('Anmerkung', invoice.receipt_note)}
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
            Schlie\u00DFen
          </button>
          <button
            onClick={onDownloadPdf}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            <Download size={16} /> {isPaid ? 'Quittung' : 'Rechnung'} PDF
          </button>
        </div>
      </div>
    </div>
  );
}
