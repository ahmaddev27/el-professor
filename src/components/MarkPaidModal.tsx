import React, { useState } from 'react';
import { X, Banknote, CheckCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { format } from 'date-fns';

interface Invoice {
  id: string;
  company_id: string;
  amount: number;
  status: string;
  invoice_number: string;
  companies?: { name: string } | null;
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
      const parsedAmount = parseFloat(amount.replace(',', '.'));
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        showToast('error', t('bill.markPaid.invalidAmount'));
        return;
      }

      const { error } = await supabase
        .from('subscription_invoices')
        .update({
          status: 'paid',
          paid_at: new Date(paidAt).toISOString(),
          paid_by: user.id,
          collected_by: user.id,
          cash_received_amount: parsedAmount,
          receipt_note: note || null,
        })
        .eq('id', invoice.id);

      if (error) throw error;

      await supabase.from('subscription_payment_audit').insert({
        invoice_id: invoice.id,
        company_id: invoice.company_id,
        action: 'marked_paid_cash',
        old_status: invoice.status,
        new_status: 'paid',
        amount: parsedAmount,
        changed_by: user.id,
        // Persisted audit record, not a label: the payment trail must read the same
        // regardless of which UI language happened to be active when it was written.
        note: note || `Barzahlung von ${profile?.full_name || profile?.email || 'Admin'} erfasst`,
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
                {invoice.companies?.name || ''} &middot; {invoice.invoice_number}
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
            style={{ background: 'var(--success)', opacity: saving ? 0.6 : 1 }}
          >
            <CheckCircle size={16} /> {saving ? t('common.saving') : t('bill.markPaid.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
