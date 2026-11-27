import React from 'react';
import { Download, CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import { invoiceCompanyAddress } from '../lib/platformBilling';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui';

// Month names are date formatting, which stays German in both UI languages
// (see the header of src/i18n/index.ts).
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * `invoiceCompanyAddress` returns the recipient's address in the two lines the
 * PDF prints. This dialog's rows are one line each, so it joins them.
 */
const NEWLINE = String.fromCharCode(10);

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * One row of `platform_invoices_list` (migration 20260924110000, decision D14).
 * It used to be a PostgREST row with `companies(...)` and
 * `company_subscriptions(subscription_plans(name))` embedded; since the invoice
 * table is no longer readable across companies, the read model answers those
 * three as flat columns. `company_address` is `companies.address`, one line —
 * the `street` and `house_number` this dialog used to print are columns of
 * `company_settings`, so the old query was refused and this dialog never opened.
 */
interface Invoice {
  id: string;
  company_id: string;
  company_name: string | null;
  company_address: string | null;
  company_postal_code: string | null;
  company_city: string | null;
  plan_name: string | null;
  invoice_month: number;
  invoice_year: number;
  invoice_number: string;
  amount: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  cash_received_amount: number | null;
  receipt_note: string | null;
  created_at: string | null;
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
  const companyName = invoice.company_name;
  const address = invoiceCompanyAddress(invoice);
  const planName = invoice.plan_name || t('bill.invoice.subscriptionFallback');
  const kind = isPaid ? t('bill.invoice.receipt') : t('bill.invoice.invoice');

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the dialog's logic. Everything below only draws.

  const row = (label: string, value: string | React.ReactNode) => (
    <div className="flex justify-between gap-4 border-b border-line py-2.5">
      <span className="text-sm text-fg-subtle">{label}</span>
      <span className="text-right text-sm font-medium text-fg">{value}</span>
    </div>
  );

  const statusTone = isPaid ? 'positive' : isOverdue ? 'critical' : invoice.status === 'canceled' ? 'neutral' : 'info';
  const StatusIcon = isPaid ? CheckCircle : isOverdue ? AlertTriangle : Clock;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {t('bill.invoice.titled', { kind, number: invoice.invoice_number })}
          </DialogTitle>
          <DialogDescription>{companyName || t('common.unknown')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Status banner */}
          <div>
            <Badge tone={statusTone} className="h-8 px-3 text-sm">
              <StatusIcon aria-hidden />
              {isPaid ? t('bill.invoice.paid') : isOverdue ? t('bill.invoice.overdue') : invoice.status === 'canceled' ? t('bill.invoice.canceled') : t('bill.invoice.open')}
            </Badge>
          </div>

          {/* Details */}
          <div>
            {row(t('bill.invoice.company'), companyName || '-')}
            {address && row(t('common.address'), address.split(NEWLINE).join(', '))}
            {row(t('bill.invoice.plan'), planName)}
            {row(t('bill.invoice.period'), `${MONTHS_DE[invoice.invoice_month - 1]} ${invoice.invoice_year}`)}
            {row(t('bill.invoice.number'), invoice.invoice_number)}
            {row(t('common.amount'), <span className="whitespace-nowrap text-base font-bold tabular-nums text-brand-text">{fmtEur(invoice.amount)}</span>)}
            {row(t('bill.invoice.paymentMethod'), t('bill.invoice.cashPayment'))}
            {row(t('bill.invoice.dueOn'), (() => { try { return format(new Date(invoice.due_date), 'dd.MM.yyyy'); } catch { return invoice.due_date; } })())}
            {isPaid && invoice.paid_at && row(t('bill.invoice.paidOn'), (() => { try { return format(new Date(invoice.paid_at), 'dd.MM.yyyy, HH:mm', { locale: de }); } catch { return invoice.paid_at; } })())}
            {isPaid && invoice.cash_received_amount != null && row(t('bill.invoice.received'), <span className="whitespace-nowrap tabular-nums">{fmtEur(invoice.cash_received_amount)}</span>)}
            {invoice.receipt_note && row(t('bill.invoice.note'), invoice.receipt_note)}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button type="button" onClick={onDownloadPdf}>
            <Download aria-hidden /> {t('bill.invoice.pdfButton', { kind })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
