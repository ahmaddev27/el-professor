import React from 'react';
import { X, Download, CheckCircle, Clock, AlertTriangle, XCircle, Banknote } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';

// Month names are date formatting, which stays German in both UI languages
// (see the header of src/i18n/index.ts).
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
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
}

// The seller printed on the PDF is read when the PDF is built
// (SubscriptionBillingPage.handleDownloadPdf); this dialog never showed it.
export default function InvoiceDetailModal({ invoice, onClose, onDownloadPdf }: Props) {
  const { t } = useTranslation();
  const isPaid = invoice.status === 'paid';
  const isOverdue = invoice.status === 'open' && new Date(invoice.due_date) < new Date();
  const co = invoice.companies;
  const planName = invoice.company_subscriptions?.subscription_plans?.name || t('bill.invoice.subscriptionFallback');
  const kind = isPaid ? t('bill.invoice.receipt') : t('bill.invoice.invoice');

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
              {t('bill.invoice.titled', { kind, number: invoice.invoice_number })}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{co?.name || t('common.unknown')}</p>
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
              {isPaid ? t('bill.invoice.paid') : isOverdue ? t('bill.invoice.overdue') : invoice.status === 'canceled' ? t('bill.invoice.canceled') : t('bill.invoice.open')}
            </span>
          </div>

          {/* Details */}
          <div>
            {row(t('bill.invoice.company'), co?.name || '-')}
            {co?.street && row(t('common.address'), `${co.street} ${co.house_number || ''}, ${co.postal_code || ''} ${co.city || ''}`)}
            {row(t('bill.invoice.plan'), planName)}
            {row(t('bill.invoice.period'), `${MONTHS_DE[invoice.invoice_month - 1]} ${invoice.invoice_year}`)}
            {row(t('bill.invoice.number'), invoice.invoice_number)}
            {row(t('common.amount'), <span className="text-base font-bold" style={{ color: 'var(--accent)' }}>{fmtEur(invoice.amount)}</span>)}
            {row(t('bill.invoice.paymentMethod'), t('bill.invoice.cashPayment'))}
            {row(t('bill.invoice.dueOn'), (() => { try { return format(new Date(invoice.due_date), 'dd.MM.yyyy'); } catch { return invoice.due_date; } })())}
            {isPaid && invoice.paid_at && row(t('bill.invoice.paidOn'), (() => { try { return format(new Date(invoice.paid_at), 'dd.MM.yyyy, HH:mm', { locale: de }); } catch { return invoice.paid_at; } })())}
            {isPaid && invoice.cash_received_amount != null && row(t('bill.invoice.received'), fmtEur(invoice.cash_received_amount))}
            {invoice.receipt_note && row(t('bill.invoice.note'), invoice.receipt_note)}
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
            {t('common.close')}
          </button>
          <button
            onClick={onDownloadPdf}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            <Download size={16} /> {t('bill.invoice.pdfButton', { kind })}
          </button>
        </div>
      </div>
    </div>
  );
}
