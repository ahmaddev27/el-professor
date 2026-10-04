import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, DollarSign, Calendar, FileText, Lock } from 'lucide-react';
import { SalaryPayment } from '../types/receipt';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import {
  PAYMENT_FIELD_LOCK_KEYS,
  PAYMENT_WRITE_REFUSAL_KEYS,
  decidePaymentWrite,
  paymentFieldLock,
} from '../utils/salaryPaymentWrite';

/**
 * Add or edit one salary payment.
 *
 * **Owner, 04.10.2026: this form saves and closes.** A cash payment used to
 * hand itself to the Gehaltsquittung wizard from here, which is what he
 * photographed and asked to be gone — the warning above the amount, the
 * "Weiter zur Gehaltsquittung" button, and the three-step dialog that opened
 * instead of saving. A numbered receipt is issued afterwards from the payment's
 * own row (`issue_salary_cash_receipt`), and it books nothing into the till.
 */
interface SalaryPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (payment: Omit<SalaryPayment, 'id' | 'created_by' | 'created_at' | 'updated_at'>) => Promise<void>;
  salaryId: string;
  remainingBalance: number;
  payment?: SalaryPayment;
  /**
   * The live receipt issued for `payment` after the fact, or null. Not a column
   * on `salary_payments` — the salary screen looks it up by payment id — so it
   * arrives beside the row rather than on it. It is the second wall behind
   * `paymentRowActions`, which already hides such a row's pencil, and behind
   * `salary_payments_issued_receipt_guard`, which refuses the UPDATE.
   */
  issuedReceiptId?: string | null;
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
  issuedReceiptId = null,
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
    ? {
        payment_type: payment.payment_type,
        source_type: payment.source_type ?? null,
        amount: payment.amount,
        issued_receipt_id: issuedReceiptId,
      }
    : null;

  // What this form's current selection will do. The same function decides the
  // write itself in SalaryDetailsModal, so what the form offers and what the
  // save does cannot drift.
  const decision = decidePaymentWrite({
    origin: payment ? 'edit' : 'add',
    paymentType: formData.payment_type,
    amount: formData.amount,
    existing,
  });
  const blocked = decision.kind === 'refused' ? t(PAYMENT_WRITE_REFUSAL_KEYS[decision.refusal]) : null;

  // A row behind a receipt is frozen whole — both database triggers refuse the
  // statement, not a column. The fields are disabled rather than refused on
  // submit: a field that takes a value and then rejects it teaches that the
  // change is possible and merely disallowed today.
  const fieldLock = paymentFieldLock(existing);
  const lockMessage = fieldLock === 'none' ? null : t(PAYMENT_FIELD_LOCK_KEYS[fieldLock]);

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

            {/* Why this stored row is read-only. */}
            {lockMessage && (
              <div
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.75rem', marginTop: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
              >
                <Lock size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: '0.125rem' }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{lockMessage}</span>
              </div>
            )}
            {/* Shown beside the select rather than after a failed submit. */}
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
              <input
                type="date"
                value={formData.payment_date}
                onChange={(e) => setFormData({ ...formData, payment_date: e.target.value })}
                style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                disabled={loading}
                required
              />
            </div>
          </div>

          {/* Offered on every path again: the Gehaltsquittung step that wrote its
              own description ("Gehaltsquittung GQ-…") is gone, and the owner named
              the missing note as one of the things it cost him. */}
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
              <Save size={20} />
              <span>{loading ? t('common.saving') : t('common.save')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SalaryPaymentModal;
