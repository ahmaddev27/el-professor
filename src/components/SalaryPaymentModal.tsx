import React, { useState, useEffect } from 'react';
import { Save, DollarSign, Calendar, FileText, Lock } from 'lucide-react';
import { SalaryPayment } from '../types/receipt';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import {
  PAYMENT_FIELD_LOCK_KEYS,
  PAYMENT_WRITE_REFUSAL_KEYS,
  decidePaymentWrite,
  paymentFieldLock,
} from '../utils/salaryPaymentWrite';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
} from './ui';

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

  // ── Presentation (phase 5)

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next && !loading) onClose();
      }}
    >
      <DialogContent className="max-w-md" onPointerDownOutside={e => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <DollarSign size={24} aria-hidden />
            <span>{payment ? t('sal.payment.editTitle') : t('sal.payment.newTitle')}</span>
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {error && <Alert tone="critical">{error}</Alert>}

          {!payment && (
            <Alert tone="brand">
              <span className="font-semibold">{t('sal.payment.remainingLabel')}</span> {remainingBalance.toFixed(2)} €
            </Alert>
          )}

          <div className="grid gap-3">
            <Field label={t('sal.payment.type')} required>
              <NativeSelect
                value={formData.payment_type}
                onChange={(e) => setFormData({ ...formData, payment_type: e.target.value as 'cash' | 'bank' })}
                disabled={loading || fieldLock !== 'none'}
                required
              >
                {/* The `value`s are the stored `salary_payments.payment_type`. */}
                <option value="cash">{t('sal.payment.cash')}</option>
                <option value="bank">{t('sal.payment.bankTransfer')}</option>
              </NativeSelect>
            </Field>

            {/* Why this stored row is read-only. */}
            {lockMessage && (
              <Alert tone="neutral" icon={Lock} role="note">{lockMessage}</Alert>
            )}
            {/* Shown beside the select rather than after a failed submit. */}
            {blocked && (
              <Alert tone="critical" role="alert">{blocked}</Alert>
            )}
          </div>

          <Field label={t('sal.payment.amount')} required>
            <div className="grid gap-2">
              <div className="relative">
                <DollarSign aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-fg-subtle" />
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  className="ps-9"
                  placeholder="0.00"
                  disabled={loading || fieldLock !== 'none'}
                  readOnly={fieldLock !== 'none'}
                  required
                />
              </div>
              {!payment && remainingBalance > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setFormData({ ...formData, amount: remainingBalance.toFixed(2) })}
                  className="w-full text-positive"
                  disabled={loading}
                >
                  {t('sal.payment.payRemaining', { amount: remainingBalance.toFixed(2) })}
                </Button>
              )}
            </div>
          </Field>

          <Field label={t('sal.payment.date')} required>
            <div className="relative">
              <Calendar aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-fg-subtle" />
              <Input
                type="date"
                value={formData.payment_date}
                onChange={(e) => setFormData({ ...formData, payment_date: e.target.value })}
                className="ps-9"
                disabled={loading}
                required
              />
            </div>
          </Field>

          {/* Offered on every path again: the Gehaltsquittung step that wrote its
              own description ("Gehaltsquittung GQ-…") is gone, and the owner named
              the missing note as one of the things it cost him. */}
          <Field label={t('common.description')} id="sal-payment-description">
            <div className="relative">
              <FileText aria-hidden className="pointer-events-none absolute start-3 top-3 size-[18px] text-fg-subtle" />
              <textarea
                id="sal-payment-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="min-h-20 w-full resize-y rounded-control border border-line-strong bg-field py-2 pe-3 ps-9 font-ui text-sm text-fg shadow-field transition-[border-color,box-shadow] placeholder:text-fg-subtle focus-visible:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus/25 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-subtle [@media(pointer:coarse)]:text-base"
                placeholder={t('sal.payment.descriptionPlaceholder')}
                rows={3}
                disabled={loading}
              />
            </div>
          </Field>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={loading || blocked !== null}>
              <Save aria-hidden />
              <span>{loading ? t('common.saving') : t('common.save')}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default SalaryPaymentModal;
