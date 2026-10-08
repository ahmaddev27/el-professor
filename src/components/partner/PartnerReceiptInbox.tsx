/**
 * The reviewer's side of M4: Belege a partner's driver photographed, waiting
 * for a person to accept or reject them.
 *
 * ## The photo is the screen, not a detail of it
 *
 * Everything else on the row — the amount, the category, the date — is what the
 * driver *claimed*. The photo is the only evidence of it, and accepting a Beleg
 * writes a row that moves money: a `bar` Beleg changes `bar_zuruck`, which is
 * what a driver owes the company, and a `Tanken` one changes the Tankenquote.
 * So a reviewer who cannot see the photo cannot decide, and this component's
 * whole shape follows from that: the list is narrow, and the decision is made
 * in a sheet with the document on it.
 *
 * `documents` is a private bucket, so the image needs a signed URL per view
 * (`SIGNED_URL_TTL_SECONDS`). The URL is fetched when the sheet opens and never
 * stored on the row, so a URL cannot outlive the look at it, and nothing in the
 * list markup carries a link to a customer's document.
 *
 * ## A photo that will not load is said out loud
 *
 * A broken `<img>` renders as nothing, and nothing reads as "there is no
 * receipt here" — which would have a reviewer reject a Beleg for the storage
 * layer's fault. Both failures are named: the signing call, and the image's own
 * `onError`. Accept stays available in neither case; a Beleg accepted blind is
 * exactly what the database's `document_missing` refusal exists to prevent.
 *
 * ## Why it is a component and not markup inside BelegePage
 *
 * The same two reasons as `PartnerNoteInbox`: the page is converted and sits at
 * zero in `style-baseline.json`, and a file of its own starts there and stays.
 *
 * ## It is gated, and the gate is the `receipts` page
 *
 * `useCompanyScope().canEdit` is a `WriteRight`, not a boolean, and its first
 * argument is ignored — so the page must be named explicitly, and `receipts` is
 * the key both RPCs ask `current_role_permits()` for themselves. A platform
 * `view` context therefore sees the list and no controls, and the database
 * refuses it again either way.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, DownloadCloud, FileText, Inbox, Receipt as ReceiptIcon, Send, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import type { TranslationKey } from '../../i18n';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
  formatEuro,
  type DataTableColumn,
} from '../ui';
import { controlFrameClass } from '../ui/Input';

type SubmissionStatus = 'pending' | 'accepted' | 'rejected';

interface Submission {
  id: string;
  external_submission_id: string;
  driver_id: string | null;
  receipt_date: string;
  category: string | null;
  description: string | null;
  amount: number;
  payment_method: string;
  postal_code: string | null;
  document_path: string | null;
  status: SubmissionStatus;
  rejected_reason: string | null;
  receipt_id: string | null;
  status_pushed_at: string | null;
  submitted_at: string;
  confirmed_by_driver: boolean;
  drivers: { name: string } | null;
}

/** Long enough to look at a receipt, short enough not to be a shareable link. */
const SIGNED_URL_TTL_SECONDS = 300;

const COLUMNS = 'id, external_submission_id, driver_id, receipt_date, category, '
  + 'description, amount, payment_method, postal_code, document_path, status, '
  + 'rejected_reason, receipt_id, status_pushed_at, submitted_at, '
  + 'confirmed_by_driver, drivers(name)';

/**
 * The four categories the Beleg screen stores literally, against the labels it
 * already owns. A category outside the map renders as its own text rather than
 * as the wrong label — and the door only admits these four or a free
 * description, so that case means a row written before this build.
 */
const CATEGORY_LABEL_KEYS: Record<string, TranslationKey> = {
  'Tanken': 'rec.category.tanken',
  'Autowäsche': 'rec.category.carWash',
  'Autozubehör': 'rec.category.carAccessories',
  'Öl wechseln': 'rec.category.oilChange',
};

/** The stable codes the two RPCs raise, against what the reviewer is told. */
const REASON_KEYS: Record<string, TranslationKey> = {
  document_missing: 'partner.belege.error.documentMissing',
  driver_not_linked: 'partner.belege.error.driverNotLinked',
  already_reviewed: 'partner.belege.error.alreadyReviewed',
  submission_not_found: 'partner.belege.error.notFound',
  not_authorized: 'partner.belege.error.notAuthorized',
  reason_required: 'partner.belege.error.reasonRequired',
  date_missing: 'partner.belege.error.dateMissing',
  driver_not_found: 'partner.belege.error.driverGone',
};

/** The sender's reasons; several send the operator to Settings, not to the row. */
const NOTIFY_REASON_KEYS: Record<string, TranslationKey> = {
  not_pushable: 'partner.inbox.error.notPushable',
  already_pushed: 'partner.inbox.error.alreadyPushed',
  driver_unknown_at_partner: 'partner.inbox.error.driverUnknownAtPartner',
  not_connected: 'partner.inbox.error.notConnected',
  seal_unreadable: 'partner.inbox.error.sealUnreadable',
  token_rejected: 'partner.inbox.error.tokenRejected',
  partner_unavailable: 'partner.inbox.error.partnerUnavailable',
  submission_not_found: 'partner.belege.error.notFound',
  not_authorized: 'partner.belege.error.notAuthorized',
  seal_key_missing: 'partner.inbox.error.notConfigured',
  endpoint_missing: 'partner.inbox.error.notConfigured',
  endpoint_unparsable: 'partner.inbox.error.notConfigured',
  endpoint_not_https: 'partner.inbox.error.notConfigured',
  endpoint_has_credentials: 'partner.inbox.error.notConfigured',
  endpoint_private_host: 'partner.inbox.error.notConfigured',
  endpoint_unexpected_port: 'partner.inbox.error.notConfigured',
  endpoint_has_path: 'partner.inbox.error.notConfigured',
};

/**
 * The catch-up's reasons. Its own map: a ring that never arrived is not the
 * reviewer's mistake, and most of these send the operator to the Connect card
 * rather than back to a row.
 */
const CATCHUP_REASON_KEYS: Record<string, TranslationKey> = {
  rate_limited: 'partner.catchup.error.rateLimited',
  not_connected: 'partner.inbox.error.notConnected',
  seal_unreadable: 'partner.inbox.error.sealUnreadable',
  token_rejected: 'partner.inbox.error.tokenRejected',
  partner_unavailable: 'partner.inbox.error.partnerUnavailable',
  seal_key_missing: 'partner.inbox.error.notConfigured',
  endpoint_missing: 'partner.inbox.error.notConfigured',
  endpoint_unparsable: 'partner.inbox.error.notConfigured',
  endpoint_not_https: 'partner.inbox.error.notConfigured',
  endpoint_has_credentials: 'partner.inbox.error.notConfigured',
  endpoint_private_host: 'partner.inbox.error.notConfigured',
  endpoint_unexpected_port: 'partner.inbox.error.notConfigured',
  endpoint_has_path: 'partner.inbox.error.notConfigured',
};

interface PartnerReceiptInboxProps {
  companyId: string | null;
  /** The partner and its fleet id, from the company's connection. */
  connection?: { partner: string; fleet: string } | null;
  /** Called after a decision, so the page's own Beleg list picks up the new row. */
  onDecided?: () => void;
}

type DocumentState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; isPdf: boolean }
  | { kind: 'failed' }
  | { kind: 'absent' };

export function PartnerReceiptInbox({ companyId, connection, onDecided }: PartnerReceiptInboxProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canEdit } = useCompanyScope();
  // canEdit is a WriteRight: (record?, page?) => boolean, and the first
  // argument is ignored. 'receipts' is the page both RPCs ask for themselves.
  const mayDecide = canEdit(undefined, 'receipts');

  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SubmissionStatus>('pending');
  const [open, setOpen] = useState<Submission | null>(null);
  const [document, setDocument] = useState<DocumentState>({ kind: 'loading' });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    try {
      const { data, error } = await supabase
        .from('partner_receipt_submissions')
        .select(COLUMNS)
        .eq('company_id', companyId)
        .eq('status', status)
        .order('submitted_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows((data ?? []) as unknown as Submission[]);
    } catch {
      // An empty table would read as "no Belege came in", which is the one
      // thing a failed read must not say.
      setLoadFailed(true);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [companyId, status]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Sign the photo for this look at it. Fetched when the sheet opens, never
   * kept on the row: a URL that outlives the review is a link to a customer's
   * document sitting in memory for no reason.
   */
  useEffect(() => {
    if (!open) return;
    const path = open.document_path?.trim() ?? '';
    if (path === '') {
      setDocument({ kind: 'absent' });
      return;
    }
    // The prefix, checked again here. The database pins it with a constraint
    // and the bucket's policies key on that first folder, so this is the third
    // wall and not the first — but a signed URL is minted from whatever the
    // column says, and this is the line that reads it.
    if (!path.startsWith(`${companyId}/partner/`)) {
      setDocument({ kind: 'failed' });
      return;
    }
    let cancelled = false;
    setDocument({ kind: 'loading' });
    void (async () => {
      try {
        const { data, error } = await supabase.storage
          .from('documents')
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        if (cancelled) return;
        if (error || !data?.signedUrl) {
          setDocument({ kind: 'failed' });
          return;
        }
        setDocument({
          kind: 'ready',
          url: data.signedUrl,
          isPdf: path.toLowerCase().endsWith('.pdf'),
        });
      } catch {
        if (!cancelled) setDocument({ kind: 'failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [open, companyId]);

  /**
   * Ask the partner what is waiting and ingest it.
   *
   * This exists because there is no scheduler in this stack. A submission
   * reaches us when the partner RINGS (owner's decision, 08.10.2026: Reidey
   * cannot replay the token it issued, so it rings and we fetch with the token
   * we hold sealed). A ring that never arrives — their queue died, we were
   * down, the gateway dropped it — is a receipt that silently never came, and
   * nothing can retry it on its own. So the retry is a person, and this is the
   * button. It is safe to press twice: every submission is idempotent on the
   * partner's own id.
   */
  const catchUp = async () => {
    if (!connection) return;
    setFetching(true);
    try {
      const { data, error } = await supabase.functions.invoke('partner-intake', {
        body: { kind: 'catchup', partner: connection.partner, fleet: connection.fleet },
      });
      if (error) throw error;
      const answer = data as {
        ok?: boolean; reason?: string; waiting?: number;
        ingested?: number; failed?: number; more?: boolean;
      };
      if (!answer?.ok) {
        const key = answer?.reason ? CATCHUP_REASON_KEYS[answer.reason] : undefined;
        showToast('error', key ? t(key) : t('partner.catchup.failed'));
        return;
      }
      // Four outcomes, and they must not look alike: nothing was waiting,
      // everything came, some came, and none of what was waiting could be
      // ingested. "Fetched 0" beside "0 waiting" is the only one that is good
      // news, and the only one the old draft of this said in both cases.
      const ingested = answer.ingested ?? 0;
      const failed = answer.failed ?? 0;
      if (ingested === 0 && failed === 0) {
        showToast('success', t('partner.catchup.nothing'));
      } else if (failed === 0) {
        showToast('success', t('partner.catchup.done', { count: String(ingested) }));
      } else {
        showToast('error', t('partner.catchup.partial', {
          count: String(ingested), failed: String(failed),
        }));
      }
      await load();
      onDecided?.();
    } catch {
      showToast('error', t('partner.catchup.failed'));
    } finally {
      setFetching(false);
    }
  };

  const reasonMessage = (hint: unknown): string => {
    const key = typeof hint === 'string' ? REASON_KEYS[hint] : undefined;
    return key ? t(key) : t('partner.belege.error.generic');
  };

  const closeSheet = () => {
    setOpen(null);
    setRejecting(false);
    setReason('');
    setDocument({ kind: 'loading' });
  };

  const accept = async (row: Submission) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_receipt_accept', { p_submission_id: row.id });
      if (error) throw error;
      showToast('success', t('partner.belege.accepted'));
      closeSheet();
      await load();
      onDecided?.();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Tell the driver. Returns whether it went, because a rejection the driver
   * never hears is not a finished rejection — they keep a photo of a receipt
   * nobody will pay and no screen of theirs says why.
   *
   * `already_pushed` counts as delivered: the driver knows, and reporting it as
   * a failure would have the operator pressing for ever.
   */
  const notify = async (id: string, quiet = false): Promise<boolean> => {
    try {
      const { data, error } = await supabase.functions.invoke('partner-notify', {
        body: { submission_id: id },
      });
      if (error) throw error;
      const answer = data as { ok?: boolean; reason?: string; duplicate?: boolean };
      if (answer?.ok) {
        if (!quiet) {
          showToast('success', answer.duplicate
            ? t('partner.inbox.notifyAlready')
            : t('partner.inbox.notifySent'));
        }
        return true;
      }
      if (answer?.reason === 'already_pushed') return true;
      if (!quiet) {
        const key = answer?.reason ? NOTIFY_REASON_KEYS[answer.reason] : undefined;
        showToast('error', key ? t(key) : t('partner.belege.error.generic'));
      }
      return false;
    } catch {
      if (!quiet) showToast('error', t('partner.belege.error.generic'));
      return false;
    }
  };

  const reject = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_receipt_reject', {
        p_submission_id: open.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      // The rejection is the decision; telling the driver is what makes it
      // useful. Sent quietly so one action produces one sentence, and the
      // sentence says whether the driver heard.
      const delivered = await notify(open.id, true);
      showToast(delivered ? 'success' : 'error', delivered
        ? t('partner.belege.rejected')
        : t('partner.belege.rejectedNotSent'));
      closeSheet();
      await load();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  const subject = (row: Submission): string => {
    if (row.category) {
      const key = CATEGORY_LABEL_KEYS[row.category];
      return key ? t(key) : row.category;
    }
    return row.description ?? '—';
  };

  const columns = useMemo<DataTableColumn<Submission>[]>(() => [
    {
      id: 'driver',
      header: t('partner.belege.col.driver'),
      value: row => row.drivers?.name ?? '',
      sortable: true,
      cell: row => (row.drivers?.name
        ? <span>{row.drivers.name}</span>
        : <Badge tone="caution">{t('partner.inbox.driverUnlinked')}</Badge>),
    },
    {
      id: 'subject',
      header: t('partner.belege.col.subject'),
      value: row => subject(row),
      sortable: true,
      cell: row => (
        <div className="grid grid-cols-1">
          <span>{subject(row)}</span>
          {/* The date moves into the first cell below `sm`, where the row has
              to hold two 40 px actions beside it. */}
          <span className="tabular-nums text-xs text-fg-muted sm:hidden">
            {row.receipt_date.split('-').reverse().join('.')}
          </span>
        </div>
      ),
    },
    {
      id: 'date',
      header: t('common.date'),
      kind: 'date',
      value: row => row.receipt_date,
      sortable: true,
      hideBelow: 'sm',
    },
    {
      id: 'amount',
      header: t('common.expenses'),
      kind: 'currency',
      value: row => row.amount,
      sortable: true,
    },
    {
      id: 'document',
      header: t('partner.belege.col.document'),
      value: row => (row.document_path ? 1 : 0),
      sortable: true,
      // A Beleg with no photo cannot be accepted (the database refuses it), so
      // the list says which ones those are before anyone opens them.
      cell: row => (row.document_path
        ? <Badge tone="positive">{t('partner.belege.photoThere')}</Badge>
        : <Badge tone="critical">{t('partner.belege.photoMissing')}</Badge>),
      hideBelow: 'md',
    },
    {
      id: 'submitted',
      header: t('partner.inbox.col.submitted'),
      kind: 'date',
      value: row => row.submitted_at,
      sortable: true,
      hideBelow: 'lg',
    },
    ...(status === 'rejected'
      ? [{
          id: 'reason',
          header: t('partner.inbox.col.reason'),
          value: (row: Submission) => row.rejected_reason ?? '',
          cell: (row: Submission) => <span>{row.rejected_reason || '—'}</span>,
          hideBelow: 'md',
        } satisfies DataTableColumn<Submission>,
        {
          // There is no scheduler here, so an undelivered rejection is made
          // visible rather than retried silently.
          id: 'delivery',
          header: t('partner.inbox.col.delivery'),
          value: (row: Submission) => (row.status_pushed_at ? 1 : 0),
          sortable: true,
          cell: (row: Submission) => (row.status_pushed_at
            ? <Badge tone="positive">{t('partner.inbox.notified')}</Badge>
            : (
              <Badge tone="caution" title={t('partner.inbox.undeliveredHint')}>
                {t('partner.inbox.undelivered')}
              </Badge>
            )),
        } satisfies DataTableColumn<Submission>]
      : []),
  ], [status, t]);

  const canAccept = open !== null
    && open.status === 'pending'
    && document.kind === 'ready'
    && open.drivers?.name !== undefined;

  return (
    <div className="font-ui space-y-4">
      <Alert tone="brand" role="note" title={t('partner.belege.note.title')}>
        {t('partner.belege.note.body')}
      </Alert>

      <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center sm:justify-between">
        <Tabs value={status} onValueChange={value => setStatus(value as SubmissionStatus)}>
          <TabsList variant="segmented" aria-label={t('partner.belege.filterLabel')}>
            <TabsTrigger value="pending">{t('partner.inbox.status.pending')}</TabsTrigger>
            <TabsTrigger value="accepted">{t('partner.inbox.status.accepted')}</TabsTrigger>
            <TabsTrigger value="rejected">{t('partner.inbox.status.rejected')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Only with a connection to ask. Without one there is nothing to
            fetch from, and a button that cannot work is worse than none. */}
        {connection && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void catchUp()}
            disabled={fetching}
            loading={fetching}
            title={t('partner.catchup.hint')}
          >
            <DownloadCloud aria-hidden />
            {t('partner.catchup.action')}
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={row => row.id}
        caption={t('partner.belege.caption')}
        loading={loading}
        error={loadFailed ? t('partner.belege.loadFailed') : null}
        onRetry={() => void load()}
        initialSort={{ columnId: 'submitted', direction: 'desc' }}
        emptyState={(
          <div className="flex flex-col items-center gap-2 py-6 text-fg-muted">
            <Inbox className="h-6 w-6" aria-hidden />
            <span>{t('partner.belege.empty')}</span>
          </div>
        )}
        rowActionsLabel={t('partner.belege.actionsLabel')}
        rowActions={status === 'rejected' && mayDecide
          ? row => (row.status_pushed_at ? null : (
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={t('partner.inbox.action.notify')}
                title={t('partner.inbox.action.notify')}
                onClick={() => { void (async () => {
                  setBusy(true);
                  try { await notify(row.id); await load(); } finally { setBusy(false); }
                })(); }}
              >
                <Send className="h-4 w-4" aria-hidden />
              </Button>
            ))
          : row => (
              // Every row opens, whatever the tab and whatever the rights: the
              // photo is why anyone comes here, and looking at a document is
              // not a write. The decision buttons inside are gated.
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('partner.belege.action.open')}
                title={t('partner.belege.action.open')}
                onClick={() => { setOpen(row); setRejecting(false); setReason(''); }}
              >
                <ReceiptIcon className="h-4 w-4" aria-hidden />
              </Button>
            )}
      />

      {/* A Dialog and not ConfirmDialog: the document has to stay on screen
          while the decision is made, and the rejection carries a field. */}
      <Dialog open={open !== null} onOpenChange={value => { if (!value) closeSheet(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('partner.belege.sheet.title')}</DialogTitle>
            <DialogDescription>
              {open ? `${subject(open)} · ${formatEuro(open.amount)}` : ''}
            </DialogDescription>
          </DialogHeader>

          {open && (
            <div className="grid grid-cols-1 gap-4">
              {/* What the driver claimed. The photo below is the evidence of
                  it, which is why the two are not mixed into one block. */}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <div className="grid grid-cols-1">
                  <dt className="text-fg-muted">{t('partner.belege.col.driver')}</dt>
                  <dd>{open.drivers?.name ?? t('partner.inbox.driverUnlinked')}</dd>
                </div>
                <div className="grid grid-cols-1">
                  <dt className="text-fg-muted">{t('common.date')}</dt>
                  <dd className="tabular-nums">
                    {open.receipt_date.split('-').reverse().join('.')}
                  </dd>
                </div>
                <div className="grid grid-cols-1">
                  <dt className="text-fg-muted">{t('rec.paymentMethod')}</dt>
                  <dd>
                    {open.payment_method === 'bar'
                      ? t('partner.belege.methodCash')
                      : t('partner.belege.methodTransfer')}
                  </dd>
                </div>
                <div className="grid grid-cols-1">
                  <dt className="text-fg-muted">{t('partner.belege.postalCode')}</dt>
                  <dd className="tabular-nums">{open.postal_code || '—'}</dd>
                </div>
              </dl>

              {/* `bar` is the one that moves what the driver owes, so the sheet
                  says so rather than leaving it to the reviewer's memory. */}
              {open.payment_method === 'bar' && open.status === 'pending' && (
                <Alert tone="caution" role="note">
                  {t('partner.belege.cashWarning')}
                </Alert>
              )}

              <div className="grid grid-cols-1 gap-2">
                <span className="text-sm text-fg-muted">{t('partner.belege.documentLabel')}</span>
                {document.kind === 'loading' && (
                  <div className="h-64 animate-pulse rounded-surface bg-sunken" />
                )}
                {document.kind === 'absent' && (
                  <Alert tone="critical" title={t('partner.belege.photoMissing')}>
                    {t('partner.belege.photoMissingBody')}
                  </Alert>
                )}
                {document.kind === 'failed' && (
                  <Alert tone="critical" title={t('partner.belege.photoFailed')}>
                    {t('partner.belege.photoFailedBody')}
                  </Alert>
                )}
                {document.kind === 'ready' && (document.isPdf ? (
                  <Button variant="secondary" asChild>
                    <a href={document.url} target="_blank" rel="noreferrer">
                      <FileText aria-hidden />
                      {t('partner.belege.openPdf')}
                    </a>
                  </Button>
                ) : (
                  <a href={document.url} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={document.url}
                      alt={t('partner.belege.documentAlt')}
                      className="max-h-[28rem] w-full rounded-surface border border-line object-contain"
                      // An <img> that fails renders as nothing, and nothing
                      // reads as "there is no receipt" — which would have a
                      // reviewer reject a Beleg for storage's fault.
                      onError={() => setDocument({ kind: 'failed' })}
                    />
                  </a>
                ))}
              </div>

              {open.status === 'rejected' && (
                <Alert tone="critical" title={t('partner.belege.wasRejected')}>
                  {open.rejected_reason || '—'}
                </Alert>
              )}

              {rejecting && (
                <Field label={t('partner.inbox.reject.label')} id="partner-beleg-reject-reason">
                  <textarea
                    id="partner-beleg-reject-reason"
                    rows={3}
                    value={reason}
                    onChange={event => setReason(event.target.value)}
                    placeholder={t('partner.belege.reject.placeholder')}
                    className={cn(controlFrameClass, 'h-auto py-2 [@media(pointer:coarse)]:h-auto')}
                  />
                </Field>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={closeSheet} disabled={busy}>
              {t('common.close')}
            </Button>
            {open?.status === 'pending' && mayDecide && !rejecting && (
              <>
                <Button
                  variant="danger"
                  onClick={() => setRejecting(true)}
                  disabled={busy}
                >
                  <X aria-hidden />
                  {t('partner.inbox.action.reject')}
                </Button>
                {/* Accept needs the photo on screen and a driver this company
                    linked. Both are refusals of the database's own
                    (`document_missing`, `driver_not_linked`); withholding the
                    button means the reviewer reads why instead of a toast. */}
                <Button
                  onClick={() => { if (open) void accept(open); }}
                  disabled={busy || !canAccept}
                  title={canAccept ? undefined : t('partner.belege.acceptBlocked')}
                >
                  <Check aria-hidden />
                  {t('partner.belege.action.accept')}
                </Button>
              </>
            )}
            {open?.status === 'pending' && mayDecide && rejecting && (
              <Button
                variant="danger"
                onClick={() => void reject()}
                disabled={busy || reason.trim() === ''}
              >
                {t('partner.inbox.reject.submit')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
