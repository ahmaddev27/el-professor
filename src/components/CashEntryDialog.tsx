import { useEffect, useRef, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import { useToast } from '../contexts/ToastContext';
import type { TranslationKey } from '../i18n';
import { recordCashMovement } from '../lib/cashMovements';
import {
  CASH_ENTRY_PURPOSE_MAX,
  formatGermanDate,
  validateCashEntry,
  type CashEntryDirection,
  type CashEntryFieldError,
  type CashEntryRefusal,
} from '../utils/cashEntry';
import { createRequestId } from '../utils/salaryCashReceiptFlow';
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from './ui';

export interface CashEntryDialogProps {
  /** `null` keeps the dialog closed. */
  direction: CashEntryDirection | null;
  onClose: () => void;
  /** Called after the database has booked the entry, so the screen reloads its ledger. */
  onBooked: () => void;
}

function refusalKey(refusal: CashEntryRefusal): TranslationKey {
  switch (refusal) {
    case 'not_authorized':
    case 'platform_session_not_allowed':
    case 'request_id_conflict':
    case 'no_response':
    case 'unexpected':
      return `bargeld.add.refusal.${refusal}`;
    default:
      return 'bargeld.add.refusal.invalid';
  }
}

/**
 * One form for both buttons: the direction decides the wording and what the
 * database books (manual_in or manual_out). The browser only validates for the
 * person typing; record_cash_movement refuses everything again. The request id
 * lives until the database answers, so pressing Buchen twice, or again after a
 * lost answer, is the same booking.
 */
export default function CashEntryDialog({ direction, onClose, onBooked }: CashEntryDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [amountText, setAmountText] = useState('');
  const [dateText, setDateText] = useState('');
  const [purpose, setPurpose] = useState('');
  const [errors, setErrors] = useState<Partial<Record<CashEntryFieldError, true>>>({});
  const [refusal, setRefusal] = useState<CashEntryRefusal | null>(null);
  const [saving, setSaving] = useState(false);
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    if (!direction) return;
    setAmountText('');
    setDateText(formatGermanDate(format(new Date(), 'yyyy-MM-dd')));
    setPurpose('');
    setErrors({});
    setRefusal(null);
    requestId.current = null;
  }, [direction]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!direction || saving) return;

    const checked = validateCashEntry({ amountText, dateText, purpose }, format(new Date(), 'yyyy-MM-dd'));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setRefusal(null);
    setSaving(true);
    requestId.current ??= createRequestId();
    const result = await recordCashMovement({
      requestId: requestId.current,
      direction,
      amountCents: checked.entry.amountCents,
      date: checked.entry.date,
      description: checked.entry.purpose,
    });
    setSaving(false);

    if (!result.ok) {
      // A lost answer keeps the request id: booking again is the same entry.
      // A definite refusal frees it, so a corrected form is a new booking.
      if (result.refusal !== 'no_response' && result.refusal !== 'unexpected') requestId.current = null;
      setRefusal(result.refusal);
      return;
    }
    requestId.current = null;
    showToast('success', t(direction === 'in' ? 'bargeld.add.success.in' : 'bargeld.add.success.out'));
    onBooked();
    onClose();
  }

  const isIn = direction === 'in';

  return (
    <Dialog open={direction !== null} onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(isIn ? 'bargeld.add.inTitle' : 'bargeld.add.outTitle')}</DialogTitle>
          <DialogDescription>{t(isIn ? 'bargeld.add.inBody' : 'bargeld.add.outBody')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4" noValidate>
          <Field
            label={t('bargeld.add.amount')}
            hint={t('bargeld.add.amountHint')}
            error={errors.amount ? t('bargeld.add.error.amount') : undefined}
            required
          >
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={amountText}
              onChange={e => setAmountText(e.target.value)}
              className="tabular-nums"
            />
          </Field>
          <Field
            label={t('bargeld.add.date')}
            hint={t('bargeld.add.dateHint')}
            error={errors.date ? t('bargeld.add.error.date') : errors.dateFuture ? t('bargeld.add.error.dateFuture') : undefined}
            required
          >
            <Input
              inputMode="numeric"
              autoComplete="off"
              placeholder={t('bargeld.add.dateHint')}
              value={dateText}
              onChange={e => setDateText(e.target.value)}
              className="tabular-nums"
            />
          </Field>
          <Field
            label={t('bargeld.add.purpose')}
            hint={t('bargeld.add.purposeHint')}
            error={errors.purpose ? t('bargeld.add.error.purpose') : undefined}
            required
          >
            <Input
              maxLength={CASH_ENTRY_PURPOSE_MAX}
              autoComplete="off"
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
            />
          </Field>

          {refusal && <Alert tone="critical">{t(refusalKey(refusal))}</Alert>}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" loading={saving}>
              {t('bargeld.add.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
