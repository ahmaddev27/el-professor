/**
 * The reviewer's side of M3: notes a partner's driver submitted, waiting for a
 * person to accept or reject them.
 *
 * It is a component of its own rather than more markup inside NotesPage, for
 * two reasons. The page is one of the six phase 5 never converted and sits at
 * 86 inline styles and one hard-coded colour in `style-baseline.json`; a file
 * of its own starts at zero and the ratchet keeps it there. And the page is
 * already 1001 lines.
 *
 * ## Why nothing here can show an empty list on a failed read
 *
 * "No submissions" is a claim, and on a failed read it is a false one — a
 * reviewer who sees it stops looking. `DataTable` takes `error` and `onRetry`,
 * so the rule costs one `loadFailed` state and no markup of its own.
 *
 * ## The three absence types never arrive here
 *
 * `sick`, `vacation` and `off` are refused at the door
 * (`partner_note_submission_record`), as Art. 9 data that leaves the transfer
 * by the owner's decision of 06.10.2026. The note at the top of the tab says so
 * rather than leaving a reviewer to wonder why a driver's sick day never came.
 *
 * ## It is gated, and the page around it is not
 *
 * `useCompanyScope()` decides whether accept and reject render at all, so a
 * platform `view` context sees the list and no controls. The rest of NotesPage
 * has no such gating — its add, edit and delete buttons render for everyone and
 * RLS is the only wall — which is an inconsistency inside one screen and is
 * recorded rather than fixed here: widening the page's gating is a behaviour
 * change outside this slice and could take away something a user does today.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Inbox, Send, X } from 'lucide-react';
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
  type DataTableColumn,
} from '../ui';
import { controlFrameClass } from '../ui/Input';

type SubmissionStatus = 'pending' | 'accepted' | 'rejected';

interface Submission {
  id: string;
  external_submission_id: string;
  driver_id: string | null;
  note_type: string;
  note_text: string;
  start_date: string | null;
  end_date: string | null;
  is_full_day: boolean;
  start_time: string | null;
  end_time: string | null;
  status: SubmissionStatus;
  rejected_reason: string | null;
  status_pushed_at: string | null;
  submitted_at: string;
  drivers: { name: string } | null;
}

/**
 * The seven types that may cross, against the label keys NotesPage already
 * owns. The ten live there; only these seven reach this screen, because the
 * database refuses the other three. A type missing from this map renders as its
 * own code rather than as the wrong label.
 */
const TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
  general: 'notes.type.general',
  other: 'notes.type.other',
  blitzer: 'notes.type.speedCamera',
  accident: 'notes.type.accident',
  kontrolle: 'notes.type.inspection',
  breakdown: 'notes.type.breakdown',
  wait: 'notes.type.waiting',
};

/** The stable codes the three RPCs raise, against what the reviewer is told. */
const REASON_KEYS: Record<string, TranslationKey> = {
  driver_not_linked: 'partner.inbox.error.driverNotLinked',
  already_reviewed: 'partner.inbox.error.alreadyReviewed',
  submission_not_found: 'partner.inbox.error.notFound',
  not_authorized: 'partner.inbox.error.notAuthorized',
  reason_required: 'partner.inbox.error.reasonRequired',
  unknown_note_type: 'partner.inbox.error.unknownType',
};

/** The sender's reasons. Its own map, because the repairs differ: several
 *  of these send the operator to Settings rather than back to the row. */
const NOTIFY_REASON_KEYS: Record<string, TranslationKey> = {
  not_pushable: 'partner.inbox.error.notPushable',
  already_pushed: 'partner.inbox.error.alreadyPushed',
  driver_unknown_at_partner: 'partner.inbox.error.driverUnknownAtPartner',
  not_connected: 'partner.inbox.error.notConnected',
  seal_unreadable: 'partner.inbox.error.sealUnreadable',
  token_rejected: 'partner.inbox.error.tokenRejected',
  partner_unavailable: 'partner.inbox.error.partnerUnavailable',
  submission_not_found: 'partner.inbox.error.notFound',
  not_authorized: 'partner.inbox.error.notAuthorized',
  seal_key_missing: 'partner.inbox.error.notConfigured',
  endpoint_missing: 'partner.inbox.error.notConfigured',
  endpoint_unparsable: 'partner.inbox.error.notConfigured',
  endpoint_not_https: 'partner.inbox.error.notConfigured',
  endpoint_has_credentials: 'partner.inbox.error.notConfigured',
  endpoint_private_host: 'partner.inbox.error.notConfigured',
  endpoint_unexpected_port: 'partner.inbox.error.notConfigured',
  endpoint_has_path: 'partner.inbox.error.notConfigured',
};

const COLUMNS = 'id, external_submission_id, driver_id, note_type, note_text, '
  + 'start_date, end_date, is_full_day, start_time, end_time, status, '
  + 'rejected_reason, status_pushed_at, submitted_at, drivers(name)';

interface PartnerNoteInboxProps {
  companyId: string | null;
}

export function PartnerNoteInbox({ companyId }: PartnerNoteInboxProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canEdit } = useCompanyScope();
  // canEdit is a WriteRight, not a boolean: (record?, page?) => boolean. The
  // page is named explicitly because this is a component, not a route, so
  // nothing can infer it -- and 'notes' is the key the submission table's
  // own UPDATE policy asks for.
  const mayDecide = canEdit(undefined, 'notes');

  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SubmissionStatus>('pending');
  const [rejecting, setRejecting] = useState<Submission | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

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
        .from('partner_note_submissions')
        .select(COLUMNS)
        .eq('company_id', companyId)
        .eq('status', status)
        .order('submitted_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows((data ?? []) as unknown as Submission[]);
    } catch {
      // An empty table would read as "nothing came in", which is the one thing
      // a failed read must not say.
      setLoadFailed(true);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [companyId, status]);

  useEffect(() => { void load(); }, [load]);

  const reasonMessage = (hint: unknown): string => {
    const key = typeof hint === 'string' ? REASON_KEYS[hint] : undefined;
    return key ? t(key) : t('partner.inbox.error.generic');
  };

  const accept = async (row: Submission) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_note_accept', { p_submission_id: row.id });
      if (error) throw error;
      showToast('success', t('partner.inbox.accepted'));
      await load();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Tell the driver. Returns whether it went, because the reject flow reports
   * a different sentence when it did not — a rejection the driver never hears
   * is not a finished rejection.
   *
   * `already_pushed` counts as delivered: the driver knows, and reporting it
   * as a failure would have the operator pressing for ever.
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
        showToast('error', key ? t(key) : t('partner.inbox.error.generic'));
      }
      return false;
    } catch {
      if (!quiet) showToast('error', t('partner.inbox.error.generic'));
      return false;
    }
  };

  const reject = async () => {
    if (!rejecting) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_note_reject', {
        p_submission_id: rejecting.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      // The rejection is the decision; telling the driver is what makes it
      // useful. Sent quietly so one action produces one sentence, and the
      // sentence says whether the driver heard.
      const delivered = await notify(rejecting.id, true);
      showToast(delivered ? 'success' : 'error', delivered
        ? t('partner.inbox.rejected')
        : t('partner.inbox.rejectedNotSent'));
      setRejecting(null);
      setReason('');
      await load();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  const period = (row: Submission): string => {
    const day = (value: string | null) => (value ? value.split('-').reverse().join('.') : '');
    const range = row.start_date && row.end_date && row.end_date !== row.start_date
      ? `${day(row.start_date)} – ${day(row.end_date)}`
      : day(row.start_date);
    if (row.is_full_day) return range ? `${range} · ${t('notes.fullDay')}` : t('notes.fullDay');
    const clock = [row.start_time, row.end_time].filter(Boolean).join(' – ');
    return [range, clock].filter(Boolean).join(' · ');
  };

  const columns = useMemo<DataTableColumn<Submission>[]>(() => [
    {
      id: 'driver',
      header: t('partner.inbox.col.driver'),
      value: row => row.drivers?.name ?? '',
      sortable: true,
      cell: row => (row.drivers?.name
        ? <span>{row.drivers.name}</span>
        : <Badge tone="caution">{t('partner.inbox.driverUnlinked')}</Badge>),
    },
    {
      id: 'type',
      header: t('partner.inbox.col.type'),
      value: row => row.note_type,
      sortable: true,
      cell: row => {
        const key = TYPE_LABEL_KEYS[row.note_type];
        return <span>{key ? t(key) : row.note_type}</span>;
      },
    },
    {
      id: 'period',
      header: t('partner.inbox.col.period'),
      value: row => row.start_date ?? '',
      sortable: true,
      cell: row => <span className="tabular-nums">{period(row)}</span>,
      hideBelow: 'sm',
    },
    {
      id: 'text',
      header: t('partner.inbox.col.text'),
      value: row => row.note_text,
      cell: row => (
        <span className="block max-w-[22rem] truncate" title={row.note_text}>
          {row.note_text || '—'}
        </span>
      ),
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
        } satisfies DataTableColumn<Submission>,
        {
          // There is no scheduler here, so an undelivered rejection is made
          // visible rather than retried silently. The tooltip says exactly
          // that, because "not notified" without a reason reads as a bug.
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

  return (
    <div className="font-ui space-y-4">
      <Alert tone="brand" role="note" title={t('partner.inbox.absence.title')}>
        {t('partner.inbox.absence.body')}
      </Alert>

      <Tabs value={status} onValueChange={value => setStatus(value as SubmissionStatus)}>
        <TabsList variant="segmented" aria-label={t('partner.inbox.filterLabel')}>
          <TabsTrigger value="pending">{t('partner.inbox.status.pending')}</TabsTrigger>
          <TabsTrigger value="accepted">{t('partner.inbox.status.accepted')}</TabsTrigger>
          <TabsTrigger value="rejected">{t('partner.inbox.status.rejected')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={row => row.id}
        caption={t('partner.inbox.caption')}
        loading={loading}
        error={loadFailed ? t('partner.inbox.loadFailed') : null}
        onRetry={() => void load()}
        initialSort={{ columnId: 'submitted', direction: 'desc' }}
        emptyState={(
          <div className="flex flex-col items-center gap-2 py-6 text-fg-muted">
            <Inbox className="h-6 w-6" aria-hidden />
            <span>{t('partner.inbox.empty')}</span>
          </div>
        )}
        rowActionsLabel={t('partner.inbox.actionsLabel')}
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
          : status === 'pending' && mayDecide
          ? row => (
              <div className="grid grid-cols-[auto_auto] gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('partner.inbox.action.accept')}
                  title={t('partner.inbox.action.accept')}
                  onClick={() => void accept(row)}
                >
                  <Check className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('partner.inbox.action.reject')}
                  title={t('partner.inbox.action.reject')}
                  onClick={() => { setRejecting(row); setReason(''); }}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            )
          : undefined}
      />

      {/* A Dialog and not ConfirmDialog: the reason is required, so the sheet
          has to stay open and carry a field. */}
      <Dialog open={rejecting !== null} onOpenChange={open => { if (!open) setRejecting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('partner.inbox.reject.title')}</DialogTitle>
            <DialogDescription>{t('partner.inbox.reject.description')}</DialogDescription>
          </DialogHeader>
          {/* Field wires its label into Input and the selects only, so a raw
              textarea needs the same id on both or the label points at nothing. */}
          <Field label={t('partner.inbox.reject.label')} id="partner-reject-reason">
            <textarea
              id="partner-reject-reason"
              rows={3}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder={t('partner.inbox.reject.placeholder')}
              className={cn(controlFrameClass, 'h-auto py-2 [@media(pointer:coarse)]:h-auto')}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void reject()}
              disabled={busy || reason.trim() === ''}
            >
              {t('partner.inbox.reject.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
