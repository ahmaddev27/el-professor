import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Ban, Download, ExternalLink, FileUp, Plus, Receipt, Search, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useToast } from '../contexts/ToastContext';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Tooltip,
  formatDate,
  formatEuroCents,
  type DataTableColumn,
} from './ui';
import { exportGehaltsquittungPdf } from './GehaltsquittungDocument';
import { ReceiptAlert, useDocumentProblemMessage, useRefusalMessage, useSignedCopyPicker } from './GehaltsquittungParts';
import {
  loadReceipts,
  openSignedCopy,
  uploadSignedCopy,
  voidReceipt,
  type SalaryCashReceipt,
  type SalaryCashReceiptWithDriver,
} from '../lib/salaryCashReceipts';
import { toCents } from '../utils/money';
import {
  buildReceiptDocumentText,
  receiptCompany,
  receiptDocumentProblem,
  storedReceiptDocumentInput,
} from '../utils/salaryCashReceiptDocument';
import {
  berlinToday,
  outcomeIsUnknown,
  receiptScope,
  scopeRefusal,
  type ReceiptActionRefusal,
} from '../utils/salaryCashReceiptFlow';

/**
 * The company's Gehaltsquittungen on DocumentsPage: number, driver, period,
 * amount, status and signed copy, with the PDF, the signed copy and voiding.
 *
 * Anyone in the company may see the list and open a copy (the table's and the
 * bucket's SELECT policies); voiding and uploading need edit rights on salaries,
 * which the RPCs check again.
 */

type Row = SalaryCashReceiptWithDriver;
type ListState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: Row[] };
type RowAction = 'pdf' | 'view' | 'upload';

export interface GehaltsquittungListProps {
  /** Bumped by the page when the dialog issued a receipt or attached a copy. */
  refreshKey: number;
  /** A receipt to find, e.g. when SalaryDetailsModal links to it. */
  focusReceiptId: string | null;
  onCreate: () => void;
}

export default function GehaltsquittungList({ refreshKey, focusReceiptId, onCreate }: GehaltsquittungListProps) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { success } = useToast();
  const { companyId, can } = useAuth();
  const { effectiveCompanyId, isViewingAsCompany } = useSuperAdmin();
  const { settings } = useCompanySettings();
  const picker = useSignedCopyPicker();
  const documentProblemMessage = useDocumentProblemMessage();

  // The table's SELECT policy reads the caller's own company, so platform staff
  // viewing another company would see an empty list that looks true. An account
  // with no company at all is a different situation, and says so.
  const outsideCompany = scopeRefusal(receiptScope({ companyId, effectiveCompanyId, isViewingAsCompany }));
  const sameCompany = outsideCompany === null;
  const mayEdit = can('salaries', 'edit');
  const company = useMemo(() => receiptCompany(settings), [settings]);

  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<{ id: string; action: RowAction } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<Row | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusedRef = useRef<string | null>(null);

  const reload = useCallback(() => setReloadKey(current => current + 1), []);

  useEffect(() => {
    if (!sameCompany || !companyId) return undefined;
    let active = true;
    setState({ status: 'loading' });
    loadReceipts(companyId).then(
      rows => {
        if (active) setState({ status: 'ready', rows });
      },
      () => {
        if (active) setState({ status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [sameCompany, companyId, refreshKey, reloadKey]);

  useEffect(() => {
    if (!focusReceiptId || state.status !== 'ready' || focusedRef.current === focusReceiptId) return;
    focusedRef.current = focusReceiptId;
    const row = state.rows.find(candidate => candidate.id === focusReceiptId);
    if (row) setQuery(row.receipt_number);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    sectionRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, [focusReceiptId, state]);

  const rows = useMemo(() => {
    if (state.status !== 'ready') return [];
    const needle = query.trim().toLocaleLowerCase('de');
    if (!needle) return state.rows;
    return state.rows.filter(
      row =>
        row.receipt_number.toLocaleLowerCase('de').includes(needle) ||
        (row.driver?.name ?? '').toLocaleLowerCase('de').includes(needle),
    );
  }, [state, query]);

  const runRowAction = async (row: Row, action: RowAction, work: () => Promise<string | null>) => {
    setBusy({ id: row.id, action });
    setNotice(null);
    try {
      setNotice(await work());
    } finally {
      setBusy(null);
    }
  };

  const downloadPdf = (row: Row) =>
    runRowAction(row, 'pdf', async () => {
      // The names are today's company settings and driver record, not a copy
      // taken at confirmation, so an empty one refuses the print instead of
      // signing the receipt to nobody.
      const driver = { name: row.driver?.name ?? '', gender: row.driver?.gender ?? null };
      const input = storedReceiptDocumentInput(row, driver, company);
      const problem = receiptDocumentProblem(input);
      if (problem) return documentProblemMessage(problem);
      try {
        await exportGehaltsquittungPdf(buildReceiptDocumentText(input));
        return null;
      } catch {
        return t('gq.pdf.failed');
      }
    });

  const viewCopy = (row: Row) =>
    runRowAction(row, 'view', async () =>
      row.signed_copy_path && (await openSignedCopy(row.signed_copy_path)) ? null : t('gq.signed.openFailed'),
    );

  const uploadCopy = (row: Row, file: File) =>
    runRowAction(row, 'upload', async () => {
      if (!companyId) return refusalMessage('company_mismatch');
      try {
        const result = await uploadSignedCopy(companyId, row, file);
        if (!result.ok) return refusalMessage(result.refusal);
        success(t('gq.signed.uploaded'));
        reload();
        return null;
      } catch {
        return refusalMessage('upload_failed');
      }
    });

  const columns: DataTableColumn<Row>[] = [
    {
      id: 'number',
      header: t('gq.col.number'),
      value: row => row.receipt_number,
      sortable: true,
      cell: row => <span className="whitespace-nowrap font-medium tabular-nums">{row.receipt_number}</span>,
    },
    {
      id: 'driver',
      header: t('common.driver'),
      value: row => row.driver?.name ?? '',
      sortable: true,
    },
    {
      id: 'period',
      header: t('common.period'),
      value: row => row.period_start,
      sortable: true,
      hideBelow: 'md',
      cell: row => (
        <span className="whitespace-nowrap tabular-nums">
          {formatDate(row.period_start)} – {formatDate(row.period_end)}
        </span>
      ),
    },
    {
      id: 'paymentDate',
      header: t('gq.col.paymentDate'),
      value: row => row.payment_date,
      kind: 'date',
      sortable: true,
      hideBelow: 'lg',
    },
    {
      id: 'amount',
      header: t('common.amount'),
      value: row => toCents(row.amount),
      kind: 'number',
      sortable: true,
      cell: row => formatEuroCents(toCents(row.amount)),
    },
    {
      id: 'status',
      header: t('common.status'),
      value: row => row.status,
      sortable: true,
      cell: row =>
        row.status === 'voided' ? (
          <span className="grid justify-items-start gap-0.5 py-1">
            <Badge tone="neutral">
              <Ban aria-hidden />
              {t('gq.status.voided')}
            </Badge>
            {row.voided_at ? (
              <span className="whitespace-nowrap text-xs text-fg-subtle">
                {t('gq.status.voidedOn', { date: formatDate(berlinToday(new Date(row.voided_at))) })}
              </span>
            ) : null}
          </span>
        ) : (
          <Badge tone="positive">{t('gq.status.confirmed')}</Badge>
        ),
    },
    {
      id: 'signed',
      header: t('gq.col.signedCopy'),
      value: row => (row.signed_copy_path ? 1 : 0),
      sortable: true,
      hideBelow: 'sm',
      cell: row => {
        if (row.status === 'voided' && !row.signed_copy_path) {
          return (
            <>
              <span aria-hidden className="text-fg-subtle">-</span>
              <span className="sr-only">{t('ui.table.noValue')}</span>
            </>
          );
        }
        return row.signed_copy_path ? (
          <Badge tone="positive">{t('gq.signed.present')}</Badge>
        ) : (
          <Badge tone="caution">{t('gq.signed.missing')}</Badge>
        );
      },
    },
  ];

  const rowActions = (row: Row) => {
    const running = busy?.id === row.id ? busy.action : null;
    const canChange = mayEdit && row.status === 'confirmed';
    return (
      <>
        <Tooltip content={t('gq.pdf.download')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('gq.action.pdfAria', { number: row.receipt_number })}
            loading={running === 'pdf'}
            disabled={busy !== null}
            onClick={() => void downloadPdf(row)}
          >
            {running === 'pdf' ? null : <Download aria-hidden />}
          </Button>
        </Tooltip>
        {row.signed_copy_path ? (
          <Tooltip content={t('gq.action.view')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('gq.action.viewAria', { number: row.receipt_number })}
              loading={running === 'view'}
              disabled={busy !== null}
              onClick={() => void viewCopy(row)}
            >
              {running === 'view' ? null : <ExternalLink aria-hidden />}
            </Button>
          </Tooltip>
        ) : null}
        {canChange ? (
          <Tooltip content={row.signed_copy_path ? t('gq.signed.replace') : t('gq.action.upload')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(row.signed_copy_path ? 'gq.action.replaceAria' : 'gq.action.uploadAria', {
                number: row.receipt_number,
              })}
              loading={running === 'upload'}
              disabled={busy !== null}
              onClick={() => picker.pick(file => void uploadCopy(row, file))}
            >
              {running === 'upload' ? null : <FileUp aria-hidden />}
            </Button>
          </Tooltip>
        ) : null}
        {canChange ? (
          <Tooltip content={t('gq.action.void')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('gq.action.voidAria', { number: row.receipt_number })}
              disabled={busy !== null}
              onClick={() => setVoidTarget(row)}
            >
              <Ban aria-hidden />
            </Button>
          </Tooltip>
        ) : null}
      </>
    );
  };

  const searching = query.trim() !== '' && state.status === 'ready' && state.rows.length > 0;
  const emptyState = searching ? (
    <EmptyState
      size="sm"
      icon={Search}
      title={t('gq.list.noMatch')}
      action={
        <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
          <X aria-hidden />
          {t('gq.list.clearSearch')}
        </Button>
      }
    />
  ) : (
    <EmptyState
      size="sm"
      icon={Receipt}
      title={t('gq.list.empty')}
      description={t('gq.list.emptyHint')}
      action={
        mayEdit ? (
          <Button size="sm" onClick={onCreate}>
            <Plus aria-hidden />
            {t('gq.action.new')}
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <section ref={sectionRef} id="gehaltsquittungen" aria-labelledby="gq-list-heading" className="scroll-mt-4 font-ui">
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle as="h2" id="gq-list-heading">
              {t('gq.list.heading')}
            </CardTitle>
            <CardDescription>{t('gq.list.description')}</CardDescription>
          </div>
          {sameCompany && mayEdit ? (
            <Button onClick={onCreate}>
              <Plus aria-hidden />
              {t('gq.action.new')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          {outsideCompany ? (
            <ReceiptAlert tone="caution">{refusalMessage(outsideCompany)}</ReceiptAlert>
          ) : (
            <>
              <div className="relative w-full max-w-sm">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={t('gq.list.search')}
                  aria-label={t('gq.list.search')}
                  className="pl-9"
                />
              </div>
              {notice ? <ReceiptAlert tone="critical">{notice}</ReceiptAlert> : null}
              <DataTable
                caption={t('gq.list.caption')}
                columns={columns}
                rows={rows}
                getRowId={row => row.id}
                loading={state.status === 'loading'}
                error={state.status === 'error'}
                onRetry={reload}
                rowActions={rowActions}
                rowActionsLabel={t('doc.tableActions')}
                emptyState={emptyState}
                density="compact"
                scrollClassName="max-h-[32rem]"
              />
              {!mayEdit ? <p className="text-xs text-fg-subtle">{t('gq.list.readOnly')}</p> : null}
            </>
          )}
        </CardContent>
      </Card>
      {picker.input}
      <VoidReceiptDialog
        receipt={voidTarget}
        onClose={() => setVoidTarget(null)}
        onVoided={voided => {
          success(t('gq.void.done', { number: voided.receipt_number }));
          reload();
        }}
        onUnknownOutcome={reload}
      />
    </section>
  );
}

function VoidReceiptDialog({
  receipt,
  onClose,
  onVoided,
  onUnknownOutcome,
}: {
  receipt: Row | null;
  onClose: () => void;
  onVoided: (receipt: SalaryCashReceipt) => void;
  onUnknownOutcome: () => void;
}) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ReceiptActionRefusal | null>(null);

  useEffect(() => {
    if (!receipt) return;
    setReason('');
    setTouched(false);
    setRefusal(null);
  }, [receipt]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!receipt || busy) return;
    setTouched(true);
    if (!reason.trim()) return;
    setBusy(true);
    setRefusal(null);
    try {
      // Voiding is idempotent in the database: a voided receipt comes back unchanged.
      const result = await voidReceipt(receipt.id, reason.trim());
      if (result.ok) {
        onVoided(result.receipt);
        onClose();
        return;
      }
      setRefusal(result.refusal);
      if (outcomeIsUnknown(result.refusal)) onUnknownOutcome();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={receipt !== null}
      onOpenChange={open => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('gq.void.title', { number: receipt?.receipt_number ?? '' })}</DialogTitle>
          <DialogDescription>
            {t('gq.void.body', { amount: receipt ? formatEuroCents(toCents(receipt.amount)) : '' })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="grid gap-4" noValidate>
          <Field
            label={t('gq.void.reason')}
            hint={t('gq.void.reasonHint')}
            error={touched && !reason.trim() ? t('gq.refusal.invalidReason') : undefined}
            required
          >
            <Input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} />
          </Field>
          {refusal ? <ReceiptAlert tone="critical">{refusalMessage(refusal)}</ReceiptAlert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={busy}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" loading={busy}>
              {t('gq.action.void')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
