import { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
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
import {
  GehaltsquittungPreview,
  exportGehaltsquittungPdf,
  printGehaltsquittung,
} from './GehaltsquittungDocument';
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
 * This dialog only **reads**: it queries nothing, draws no GQ number, and writes
 * neither `salary_cash_receipts` nor `cash_movements`.
 *
 * It does offer a download and a print since 04.10.2026, at the owner's request,
 * together with the removal of the banner and the "Ohne Quittungsnummer" line. So
 * the sheet now leaves the screen and can be handed to a driver. What it still
 * does not do is draw a number or write a ledger row — which means a printed copy
 * is **indistinguishable from a confirmed Gehaltsquittung except for having no
 * number**. That is the owner's call and it is recorded here rather than argued
 * with; if this becomes the receipt a company issues, it needs a number of its
 * own, and that is a migration, not a button.
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
  /** Which action is running, so the two buttons cannot both be pressed at once. */
  const [busy, setBusy] = useState<'download' | 'print' | null>(null);

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
