import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Download, Printer, ReceiptText } from 'lucide-react';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
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
import {
  GehaltsquittungPreview,
  exportGehaltsquittungPdf,
  printGehaltsquittung,
} from './GehaltsquittungDocument';
import { ReceiptAlert, useDocumentProblemMessage, useRefusalMessage } from './GehaltsquittungParts';
import { issueReceiptForPayment, type SalaryCashReceipt } from '../lib/salaryCashReceipts';
import { createRequestId, type ReceiptActionRefusal } from '../utils/salaryCashReceiptFlow';
import {
  buildReceiptDocumentText,
  paymentViewDocumentInput,
  receiptCompany,
  receiptDocumentProblem,
  type ReceiptDocumentProblem,
  type ReceiptDocumentText,
} from '../utils/salaryCashReceiptDocument';

/**
 * A read-only view of one cash payment, for a payment with no stored receipt.
 *
 * Owner decision 03.10.2026: every cash payment in a salary can be viewed. This
 * This dialog only **reads**: it queries nothing, draws no GQ number, and writes
 * neither `salary_cash_receipts` nor `cash_movements`.
 *
 * It does offer a download and a print since 04.10.2026, at the owner's request,
 * together with the removal of the banner and the "Ohne Quittungsnummer" line. So
 * the sheet leaves the screen and can be handed to a driver, and a printed copy
 * is indistinguishable from a confirmed Gehaltsquittung except for having no
 * number. **The number is the "Quittung ausstellen" section below** (owner, same
 * day): it calls `issue_salary_cash_receipt`, which draws a real GQ number from
 * the same series and writes the receipt row — and nothing else. It books no
 * cash into the till, because the payment it documents already exists
 * (20261004110000). Once issued, the row opens the stored receipt, not this view.
 *
 * Its text is German in both UI languages, like the Gehaltsquittung it imitates.
 */

export interface CashPaymentViewTarget {
  /** Euros, as salary_payments stores it. */
  amount: number | string;
  /** YYYY-MM-DD */
  paymentDate: string;
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD */
  periodEnd: string;
  driverName: string;
  /**
   * Set when a numbered receipt can be issued for this payment from here: the
   * payment's id, and the reason the caller may not, ready to show (null when
   * they may). Absent for a payment that cannot be issued a receipt.
   */
  issue?: { paymentId: string; blockedMessage: string | null };
}

type Sheet = { kind: 'text'; text: ReceiptDocumentText } | { kind: 'problem'; problem: ReceiptDocumentProblem } | { kind: 'broken' };

export default function SalaryPaymentCashView({
  target,
  onClose,
  onIssued,
}: {
  /** The payment to show; null closes the dialog. */
  target: CashPaymentViewTarget | null;
  onClose: () => void;
  /** A receipt was issued for the payment shown; the caller reloads and opens it. */
  onIssued?: (receipt: SalaryCashReceipt) => void;
}) {
  const { t } = useTranslation();
  const documentProblemMessage = useDocumentProblemMessage();
  const refusalMessage = useRefusalMessage();
  const { settings } = useCompanySettings();
  const company = useMemo(() => receiptCompany(settings), [settings]);
  /** Which action is running, so the two buttons cannot both be pressed at once. */
  const [busy, setBusy] = useState<'download' | 'print' | null>(null);

  // ── Issuing a numbered receipt for this payment ──────────────────────────
  const paymentId = target?.issue?.paymentId ?? null;
  const [place, setPlace] = useState(settings?.default_signature_city || settings?.city || '');
  const [issuing, setIssuing] = useState(false);
  const [placeMissing, setPlaceMissing] = useState(false);
  const [refusal, setRefusal] = useState<ReceiptActionRefusal | null>(null);
  // One request id per payment shown: a retry after an answer that never
  // arrived is the same request, so the database hands back the receipt it
  // already wrote instead of a second one.
  const [requestId, setRequestId] = useState(() => createRequestId());
  useEffect(() => {
    setRequestId(createRequestId());
    setRefusal(null);
    setPlaceMissing(false);
    setPlace(settings?.default_signature_city || settings?.city || '');
  }, [paymentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sheet = useMemo((): Sheet | null => {
    if (!target) return null;
    // Nothing here may throw into the salary screen, which has no error boundary.
    try {
      const input = paymentViewDocumentInput(
        { ...target },
        { name: target.driverName, gender: null },
        company,
      );
      const problem = receiptDocumentProblem(input);
      return problem ? { kind: 'problem', problem } : { kind: 'text', text: buildReceiptDocumentText(input) };
    } catch {
      return { kind: 'broken' };
    }
  }, [target, company]);

  /**
   * Download or print the sheet. Guarded on `sheet.kind === 'text'`, because a
   * sheet that failed to build has nothing to render and both paths would throw
   * inside a hidden container where nobody would see it.
   */
  const run = async (what: 'download' | 'print'): Promise<void> => {
    if (sheet?.kind !== 'text' || busy !== null) return;
    setBusy(what);
    try {
      if (what === 'download') await exportGehaltsquittungPdf(sheet.text);
      else await printGehaltsquittung(sheet.text);
    } finally {
      setBusy(null);
    }
  };

  const issue = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!paymentId || issuing || target?.issue?.blockedMessage) return;
    if (place.trim() === '') {
      setPlaceMissing(true);
      return;
    }
    setIssuing(true);
    setRefusal(null);
    try {
      const result = await issueReceiptForPayment({ requestId, paymentId, place: place.trim() });
      if (result.ok) {
        onIssued?.(result.receipt);
        return;
      }
      setRefusal(result.refusal);
      // A request id the database already used for another place: start over.
      if (result.refusal === 'request_id_conflict') setRequestId(createRequestId());
      // No answer: the receipt may exist. The next attempt reuses the same id,
      // so the database answers with the receipt it already wrote.
    } finally {
      setIssuing(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('sal.payment.viewCashTitle')}</DialogTitle>
          <DialogDescription>{t(target?.issue ? 'sal.payment.viewCashIntroIssuable' : 'sal.payment.viewCashIntro')}</DialogDescription>
        </DialogHeader>
        {sheet?.kind === 'problem' ? (
          <ReceiptAlert tone="critical">{documentProblemMessage(sheet.problem)}</ReceiptAlert>
        ) : null}
        {sheet?.kind === 'broken' ? <ReceiptAlert tone="critical">{t('sal.payment.viewCashBroken')}</ReceiptAlert> : null}
        {sheet?.kind === 'text' ? (
          <div className="grid gap-4">
            <p className="text-[13px] text-fg-muted">{t('gq.preview.germanNote')}</p>
            <GehaltsquittungPreview text={sheet.text} label={t('sal.payment.viewCashLabel')} />
          </div>
        ) : null}
        {target?.issue ? (
          <form onSubmit={event => void issue(event)} className="grid gap-3 rounded-surface border border-line p-4" noValidate>
            <p className="text-sm font-semibold text-fg">{t('sal.payment.issueTitle')}</p>
            <p className="text-[13px] text-fg-muted">{t('sal.payment.issueIntro')}</p>
            {target.issue.blockedMessage ? (
              <ReceiptAlert tone="caution">{target.issue.blockedMessage}</ReceiptAlert>
            ) : (
              <>
                <Field
                  label={t('gq.place.label')}
                  hint={t('gq.place.hint')}
                  error={placeMissing && place.trim() === '' ? t('gq.place.missing') : undefined}
                  required
                >
                  <Input
                    value={place}
                    onChange={event => setPlace(event.target.value)}
                    autoComplete="address-level2"
                    maxLength={120}
                  />
                </Field>
                {refusal ? <ReceiptAlert tone="critical">{refusalMessage(refusal)}</ReceiptAlert> : null}
                <div>
                  <Button type="submit" loading={issuing} disabled={sheet?.kind !== 'text'}>
                    {issuing ? null : <ReceiptText aria-hidden />}
                    {t('sal.payment.issueAction')}
                  </Button>
                </div>
              </>
            )}
          </form>
        ) : null}
        <DialogFooter className="sm:justify-between">
          {/* Offered only once the sheet actually built: a download that produces
              a broken PDF, or a print of nothing, is worse than no button. */}
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            <Button
              variant="secondary"
              disabled={sheet?.kind !== 'text' || busy !== null}
              onClick={() => { void run('download'); }}
            >
              <Download aria-hidden />
              {busy === 'download' ? t('gq.action.preparing') : t('common.download')}
            </Button>
            <Button
              variant="secondary"
              disabled={sheet?.kind !== 'text' || busy !== null}
              onClick={() => { void run('print'); }}
            >
              <Printer aria-hidden />
              {busy === 'print' ? t('gq.action.preparing') : t('common.print')}
            </Button>
          </div>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
