import React, { useState } from 'react';
import { X, Banknote, CheckCircle } from 'lucide-react';
import { callPlatformRpc } from '../lib/platformRpc';
import { parseGermanAmountToCents } from '../utils/money';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { format } from 'date-fns';

/**
 * What this dialog needs of one `platform_invoices_list` row (migration
 * 20260924110000, decision D14). The company's name used to arrive as an
 * embedded `companies(name)`; the read model answers it as a flat column,
 * because the invoice table is no longer readable across companies.
 */
interface Invoice {
  id: string;
  company_id: string;
  amount: number;
  status: string;
  invoice_number: string;
  company_name?: string | null;
}

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onConfirm: () => void;
}

export default function MarkPaidModal({ invoice, onClose, onConfirm }: Props) {
  const { user, profile } = useAuth();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [amount, setAmount] = useState(invoice.amount.toString());
  const [paidAt, setPaidAt] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!user) return;
    setSaving(true);
    try {
      // The amount is converted once, here, into integer cents: a German amount
      // ("1.234,56") does not survive parseFloat, which read it as 1.234. The
      // database stores round(cents / 100, 2) euros in cash_received_amount, the
      // column's existing unit, so the figure recorded is the one typed.
      const amountCents = parseGermanAmountToCents(amount);
      if (amountCents === null || amountCents <= 0) {
        showToast('error', t('bill.markPaid.invalidAmount'));
        return;
      }

      // The invoice, its payment-trail row and the platform audit row in one
      // transaction. The collector and the trail's German wording come from the
      // caller's own token, as this screen wrote them.
      await callPlatformRpc('platform_invoice_mark_paid', {
        p_invoice_id: invoice.id,
        p_amount_cents: amountCents,
        p_paid_at: new Date(paidAt).toISOString(),
        p_note: note || null,
      });

      showToast('success', t('bill.markPaid.success'));
      onConfirm();
      onClose();
    } catch (err: any) {
      showToast('error', t('bill.errorWithMessage', { message: err.message || t('common.unknown') }));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: '0.75rem',
    fontSize: '0.875rem',
    background: 'var(--bg-subtle)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="rounded-2xl w-full max-w-md" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.12)' }}>
              <Banknote size={20} style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('bill.markPaid.title')}</h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {invoice.company_name || ''} &middot; {invoice.invoice_number}
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-tertiary)' }}><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('bill.field.amountReceived')}</label>
            <input
              type="text"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              style={inputStyle}
              /* German decimal comma in both languages — see src/i18n/index.ts. */
              placeholder="0,00"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('bill.field.dateTime')}</label>
            <input
              type="datetime-local"
              value={paidAt}
              onChange={e => setPaidAt(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('bill.field.collectedBy')}</label>
            <input
              type="text"
              value={profile?.full_name || profile?.email || ''}
              disabled
              style={{ ...inputStyle, opacity: 0.6 }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('bill.field.commentOptional')}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              style={{ ...inputStyle, minHeight: '4rem', resize: 'vertical' }}
              placeholder={t('bill.notePlaceholder')}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--success-solid)', opacity: saving ? 0.6 : 1 }}
          >
            <CheckCircle size={16} /> {saving ? t('common.saving') : t('bill.markPaid.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
