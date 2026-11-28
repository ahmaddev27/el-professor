import { useState } from 'react';
import { Banknote, CheckCircle } from 'lucide-react';
import { callPlatformRpc } from '../lib/platformRpc';
import { parseGermanAmountToCents } from '../utils/money';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { format } from 'date-fns';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, cn,
} from './ui';
import { controlFrameClass } from './ui/Input';

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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the dialog's logic and is unchanged, bar the
  // `inputStyle` object, which was only look and is classes now. Everything
  // below only draws.

  const textareaClass = cn(
    controlFrameClass,
    'h-auto min-h-16 resize-y py-2 [@media(pointer:coarse)]:h-auto',
  );

  return (
    <Dialog
      open
      onOpenChange={open => {
        // The dialog stays open while the save runs, so a failure is shown in it.
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-positive-soft text-positive">
              <Banknote aria-hidden className="size-5" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span>{t('bill.markPaid.title')}</span>
              <span className="truncate text-xs font-normal text-fg-subtle">
                {invoice.company_name || ''} &middot; {invoice.invoice_number}
              </span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">{t('bill.markPaid.title')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label={t('bill.field.amountReceived')}>
            <Input
              type="text"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="tabular-nums"
              /* German decimal comma in both languages — see src/i18n/index.ts. */
              placeholder="0,00"
            />
          </Field>
          <Field label={t('bill.field.dateTime')}>
            <Input
              type="datetime-local"
              value={paidAt}
              onChange={e => setPaidAt(e.target.value)}
            />
          </Field>
          <Field label={t('bill.field.collectedBy')}>
            <Input
              type="text"
              value={profile?.full_name || profile?.email || ''}
              disabled
            />
          </Field>
          <Field label={t('bill.field.commentOptional')} id="mark-paid-note">
            <textarea
              id="mark-paid-note"
              value={note}
              onChange={e => setNote(e.target.value)}
              className={textareaClass}
              placeholder={t('bill.notePlaceholder')}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving} loading={saving}>
            {saving ? null : <CheckCircle aria-hidden />}
            {saving ? t('common.saving') : t('bill.markPaid.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
