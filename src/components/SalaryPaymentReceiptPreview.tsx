import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
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
import { GehaltsquittungPreview, exportGehaltsquittungPdf } from './GehaltsquittungDocument';
import { ReceiptAlert, useDocumentProblemMessage, useRefusalMessage } from './GehaltsquittungParts';
import { loadReceiptById, type SalaryCashReceiptWithDriver } from '../lib/salaryCashReceipts';
import { receiptCompany } from '../utils/salaryCashReceiptDocument';
import {
  currentLoadState,
  loadReceiptForPreview,
  receiptPreviewView,
  receiptSheet,
  type ReceiptLoadState,
  type ReceiptSheet,
} from '../utils/salaryPaymentReceiptRow';

/**
 * The Gehaltsquittung behind one cash payment, shown over the salary screen.
 *
 * It prints the row the database stored — loaded by the payment's
 * `source_reference` and rendered through storedReceiptDocumentInput — never a
 * reconstruction from the payment. The same sheet the Documents page shows, the
 * same builder, and the same PDF export, so a receipt reached from a salary row
 * and the same receipt reached from Dokumente are one document.
 *
 * Its text is German in both UI languages: the Gehaltsquittung is on the closed
 * list of statutory documents in src/i18n/index.ts. Only the dialog around it
 * is translated.
 */

export interface SalaryPaymentReceiptPreviewProps {
  /** The receipt to show; null closes the dialog. */
  receiptId: string | null;
  onClose: () => void;
  /** The full receipt list on the Documents page, where a copy is uploaded or the receipt voided. */
  onOpenDocuments: (receiptId: string) => void;
}

export default function SalaryPaymentReceiptPreview({
  receiptId,
  onClose,
  onOpenDocuments,
}: SalaryPaymentReceiptPreviewProps) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const documentProblemMessage = useDocumentProblemMessage();
  const { companyId } = useAuth();
  const { effectiveCompanyId, isViewingAsCompany } = useSuperAdmin();
  const { settings } = useCompanySettings();

  const [state, setState] = useState<ReceiptLoadState<SalaryCashReceiptWithDriver>>({
    status: 'loading',
    receiptId: null,
  });
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const company = useMemo(() => receiptCompany(settings), [settings]);

  useEffect(() => {
    if (!receiptId) return undefined;
    setState({ status: 'loading', receiptId });
    setExportFailed(false);

    // loadReceiptForPreview settles the scope before it issues a query and never
    // rejects: a platform account viewing a customer is refused by name rather
    // than shown the empty answer the SELECT policy would give it.
    let active = true;
    void loadReceiptForPreview({ receiptId, companyId, effectiveCompanyId, isViewingAsCompany }, loadReceiptById).then(
      next => {
        if (active) setState(next);
      },
    );
    return () => {
      active = false;
    };
  }, [receiptId, companyId, effectiveCompanyId, isViewingAsCompany]);

  // React commits and paints the newly opened receiptId a frame before the
  // effect above runs. Anything this state still holds for the receipt shown
  // before therefore counts as loading — one frame of the wrong receipt's
  // number, amount and period is one frame of the wrong statutory document.
  const current = currentLoadState(state, receiptId);
  const receipt = current.status === 'loaded' ? current.receipt : null;
  const view = receiptPreviewView(current);

  const sheet = useMemo((): ReceiptSheet | null => {
    if (!receipt) return null;
    // The names are today's company settings and driver record, not a copy taken
    // at confirmation, so an empty one refuses the print instead of signing the
    // receipt to nobody — the same rule the receipt list applies. A stored date
    // or amount the builder refuses surfaces as a message, never as an exception
    // thrown through the salary screen, which sits under no error boundary.
    const driver = { name: receipt.driver?.name ?? '', gender: receipt.driver?.gender ?? null };
    return receiptSheet(receipt, driver, company);
  }, [receipt, company]);

  const downloadPdf = async () => {
    if (sheet?.kind !== 'text') return;
    setExporting(true);
    setExportFailed(false);
    try {
      // The same text the preview above renders, so the PDF cannot differ from it.
      await exportGehaltsquittungPdf(sheet.text);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog
      open={receiptId !== null}
      onOpenChange={open => {
        if (!open && !exporting) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('gq.title')}</DialogTitle>
          <DialogDescription>{t('sal.payment.receiptPreviewIntro')}</DialogDescription>
        </DialogHeader>

        {view.kind === 'loading' ? (
          <p role="status" className="py-6 text-center text-sm text-fg-muted">
            {t('sal.payment.receiptLoading')}
          </p>
        ) : null}

        {view.kind === 'refusal' ? <ReceiptAlert tone="caution">{refusalMessage(view.refusal)}</ReceiptAlert> : null}

        {view.kind === 'document' ? (
          <div className="grid gap-4">
            {/* Voiding deletes the payment, so a voided receipt reached from a
                payment row means it was voided elsewhere since this list loaded. */}
            {view.voided ? <ReceiptAlert tone="caution">{t('sal.payment.receiptVoidedNotice')}</ReceiptAlert> : null}
            {sheet?.kind === 'problem' ? (
              <ReceiptAlert tone="critical">{documentProblemMessage(sheet.problem)}</ReceiptAlert>
            ) : null}
            {sheet?.kind === 'broken' ? <ReceiptAlert tone="critical">{t('gq.pdf.failed')}</ReceiptAlert> : null}
            {sheet?.kind === 'text' ? (
              <>
                <p className="text-[13px] text-fg-muted">{t('gq.preview.germanNote')}</p>
                <GehaltsquittungPreview text={sheet.text} label={t('gq.preview.label')} />
                {exportFailed ? <ReceiptAlert tone="critical">{t('gq.pdf.failed')}</ReceiptAlert> : null}
              </>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={exporting}>
              {t('common.close')}
            </Button>
          </DialogClose>
          {receipt ? (
            <Button variant="ghost" onClick={() => onOpenDocuments(receipt.id)}>
              <ExternalLink aria-hidden />
              {t('sal.payment.openReceipt')}
            </Button>
          ) : null}
          {sheet?.kind === 'text' ? (
            <Button onClick={() => void downloadPdf()} loading={exporting}>
              {exporting ? null : <Download aria-hidden />}
              {exporting ? t('gq.pdf.exporting') : t('gq.pdf.download')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
