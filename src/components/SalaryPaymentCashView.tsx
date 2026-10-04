import { useMemo } from 'react';
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
} from './ui';
import { GehaltsquittungPreview } from './GehaltsquittungDocument';
import { ReceiptAlert, useDocumentProblemMessage } from './GehaltsquittungParts';
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
 * dialog only reads: it queries nothing, draws no GQ number, writes neither
 * salary_cash_receipts nor cash_movements, and offers no PDF, so the sheet
 * cannot circulate as a receipt. The sheet says so itself (banner and number).
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
}

type Sheet = { kind: 'text'; text: ReceiptDocumentText } | { kind: 'problem'; problem: ReceiptDocumentProblem } | { kind: 'broken' };

export default function SalaryPaymentCashView({
  target,
  onClose,
}: {
  /** The payment to show; null closes the dialog. */
  target: CashPaymentViewTarget | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const documentProblemMessage = useDocumentProblemMessage();
  const { settings } = useCompanySettings();
  const company = useMemo(() => receiptCompany(settings), [settings]);

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

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('sal.payment.viewCashTitle')}</DialogTitle>
          <DialogDescription>{t('sal.payment.viewCashIntro')}</DialogDescription>
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
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
