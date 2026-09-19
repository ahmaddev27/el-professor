import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, DollarSign, Calendar, FileText, ChevronRight, Lock } from 'lucide-react';
import { SalaryPayment } from '../types/receipt';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import {
  PAYMENT_FIELD_LOCK_KEYS,
  PAYMENT_WRITE_REFUSAL_KEYS,
  decidePaymentWrite,
  paymentFieldLock,
} from '../utils/salaryPaymentWrite';
import { berlinToday } from '../utils/salaryCashReceiptFlow';

interface SalaryPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (payment: Omit<SalaryPayment, 'id' | 'created_by' | 'created_at' | 'updated_at'>) => Promise<void>;
  salaryId: string;
  remainingBalance: number;
  payment?: SalaryPayment;
  /**
   * Why a cash payment cannot be recorded for this salary at all, ready to
   * show; null when it can. A cash payment is now a Gehaltsquittung, so the
   * Gehaltsquittung's own conditions decide — an overlapping salary row, a plan
   * without Dokumente, a caller outside their own company. It is shown beside
   * the type select while that select is still open, so the payment can be
   * recorded as a bank transfer instead of the form closing onto a dead end.
   */
  cashBlockedMessage?: string | null;
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
  width: '100%',
};

const SalaryPaymentModal: React.FC<SalaryPaymentModalProps> = ({
  isOpen,
  onClose,
  onSave,
  salaryId,
  remainingBalance,
  payment,
  cashBlockedMessage = null,
}) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    payment_type: 'cash' as 'cash' | 'bank',
    amount: '',
    payment_date: format(new Date(), 'yyyy-MM-dd'),
    description: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (payment) {
        setFormData({
          payment_type: payment.payment_type,
          amount: payment.amount.toString(),
          payment_date: payment.payment_date,
          description: payment.description,
        });
      } else {
        setFormData({
          payment_type: 'cash',
          amount: '',
          payment_date: format(new Date(), 'yyyy-MM-dd'),
          description: '',
        });
      }
      setError('');
    }
  }, [isOpen, payment]);

  const existing = payment
    ? { payment_type: payment.payment_type, source_type: payment.source_type ?? null, amount: payment.amount }
    : null;

  // What this form's current selection will do. The same function decides the
  // write itself in SalaryDetailsModal, so the notice below and the button's
  // label cannot promise something the save does differently.
  const decision = decidePaymentWrite({
    origin: payment ? 'edit' : 'add',
    paymentType: formData.payment_type,
    amount: formData.amount,
    existing,
  });
  const makesReceipt = decision.kind === 'gehaltsquittung';
  const refused = decision.kind === 'refused' ? t(PAYMENT_WRITE_REFUSAL_KEYS[decision.refusal]) : null;

  // A stored cash row asserts how much cash left the till, and no ledger row
  // backs it. Those two fields are disabled rather than refused on submit: a
  // field that takes a value and then rejects it teaches that the change is
  // possible and merely disallowed today.
  const fieldLock = paymentFieldLock(existing);
  const lockMessage = fieldLock === 'none' ? null : t(PAYMENT_FIELD_LOCK_KEYS[fieldLock]);
  const cashBlocked = makesReceipt ? cashBlockedMessage : null;
  const today = berlinToday();
  const blocked = refused ?? cashBlocked;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (blocked) {
      setError(blocked);
      return;
    }

    const amount = parseFloat(formData.amount);

    if (isNaN(amount) || amount <= 0) {
      setError(t('sal.payment.invalidAmount'));
      return;
    }

    // confirm_salary_cash_payment refuses a future payment date, and the form
    // closes before the Gehaltsquittung step could say so.
    if (makesReceipt && formData.payment_date > today) {
      setError(t('gq.date.future'));
      return;
    }

    setLoading(true);

    try {
      await onSave({
        salary_id: salaryId,
        payment_type: formData.payment_type,
        amount,
        payment_date: formData.payment_date,
        description: formData.description.trim(),
      });
      onClose();
    } catch (err: any) {
      setError(err.message || t('sal.payment.errorSave'));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)' }} className="w-full max-w-md">
        <div style={{ borderBottom: '1px solid var(--border)' }} className="p-6 flex items-center justify-between">
          <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold flex items-center space-x-2">
            <DollarSign size={24} />
            <span>{payment ? t('sal.payment.editTitle') : t('sal.payment.newTitle')}</span>
          </h2>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <AlertCircle style={{ color: 'var(--danger)', flexShrink: 0 }} size={20} />
              <span style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</span>
            </div>
          )}

          {!payment && (
            <div style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', borderRadius: '0.5rem', padding: '1rem' }}>
              <p style={{ color: 'var(--accent)', fontSize: '0.875rem' }}>
                <span className="font-semibold">{t('sal.payment.remainingLabel')}</span> {remainingBalance.toFixed(2)} €
              </p>
            </div>
          )}

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('sal.payment.type')} *
            </label>
            <select
              value={formData.payment_type}
              onChange={(e) => setFormData({ ...formData, payment_type: e.target.value as 'cash' | 'bank' })}
              style={{ ...inputStyle, appearance: 'none', opacity: fieldLock === 'none' ? 1 : 0.6 }}
              disabled={loading || fieldLock !== 'none'}
              required
            >
              {/* The `value`s are the stored `salary_payments.payment_type`. */}
              <option value="cash">{t('sal.payment.cash')}</option>
              <option value="bank">{t('sal.payment.bankTransfer')}</option>
            </select>

            {/* Said before the payment is committed, not after a refusal. */}
            {makesReceipt && !cashBlocked && (
              <div
                style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)', borderRadius: '0.5rem', padding: '0.75rem', marginTop: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
              >
                <Lock size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '0.125rem' }} />
                <span style={{ color: 'var(--warning)', fontSize: '0.8125rem' }}>{t('sal.payment.cashReceiptNotice')}</span>
              </div>
            )}
            {/* Why the amount and the type are read-only on this stored row. */}
            {lockMessage && (
              <div
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.75rem', marginTop: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
              >
                <Lock size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: '0.125rem' }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{lockMessage}</span>
              </div>
            )}
            {/* Shown while the select is still open, so a bank transfer is one click away. */}
            {blocked && (
              <div
                role="alert"
                style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', borderRadius: '0.5rem', padding: '0.75rem', marginTop: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
              >
                <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '0.125rem' }} />
                <span style={{ color: 'var(--danger)', fontSize: '0.8125rem' }}>{blocked}</span>
              </div>
            )}
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('sal.payment.amount')} *
            </label>
            <div className="space-y-2">
              <div className="relative">
                <DollarSign style={{ color: 'var(--text-tertiary)', position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }} size={18} />
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  style={{ ...inputStyle, paddingLeft: '2.25rem', opacity: fieldLock === 'none' ? 1 : 0.6 }}
                  placeholder="0.00"
                  disabled={loading || fieldLock !== 'none'}
                  readOnly={fieldLock !== 'none'}
                  required
                />
              </div>
              {!payment && remainingBalance > 0 && (
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, amount: remainingBalance.toFixed(2) })}
                  style={{ width: '100%', padding: '0.375rem 0.75rem', fontSize: '0.875rem', background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: '0.5rem' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  disabled={loading}
                >
                  {t('sal.payment.payRemaining', { amount: remainingBalance.toFixed(2) })}
                </button>
              )}
            </div>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('sal.payment.date')} *
            </label>
            <div className="relative">
              <Calendar style={{ color: 'var(--text-tertiary)', position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }} size={18} />
              {/* A Gehaltsquittung is refused a future payment date, and this form
                  closes before the step that would say so. Bank transfers are
                  unaffected and may still be dated ahead. */}
              <input
                type="date"
                max={makesReceipt ? today : undefined}
                value={formData.payment_date}
                onChange={(e) => setFormData({ ...formData, payment_date: e.target.value })}
                style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                disabled={loading}
                required
              />
            </div>
          </div>

          {/* A Gehaltsquittung writes its own description ("Gehaltsquittung GQ-…"),
              so the field is not offered on that path rather than silently dropped. */}
          {!makesReceipt && (
            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
                {t('common.description')}
              </label>
              <div className="relative">
                <FileText style={{ color: 'var(--text-tertiary)', position: 'absolute', left: '0.75rem', top: '0.75rem' }} size={18} />
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  style={{ ...inputStyle, paddingLeft: '2.25rem', resize: 'vertical' }}
                  placeholder={t('sal.payment.descriptionPlaceholder')}
                  rows={3}
                  disabled={loading}
                />
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.5rem 1rem' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={loading || blocked !== null}
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none' }}
              onMouseEnter={e => { if (!loading && !blocked) e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
              className="flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {makesReceipt ? <ChevronRight size={20} /> : <Save size={20} />}
              <span>
                {loading
                  ? t('common.saving')
                  : makesReceipt
                    ? t('sal.payment.cashReceiptContinue')
                    : t('common.save')}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SalaryPaymentModal;
