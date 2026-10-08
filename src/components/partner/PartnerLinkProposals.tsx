/**
 * M2's screen: proposals from a partner that a person turns into a link.
 *
 * ## The name is shown, never matched
 *
 * `proposed_name` is rendered for a human to read and the driver is chosen from
 * a list. Nothing here compares the two, and the dialog says so in words,
 * because the operator has to know the choice is theirs rather than a
 * suggestion they are confirming. The owner decided it on 06.10.2026 and this
 * codebase has the scar: fuzzy matching once gave a month's salary to a driver
 * nobody had chosen.
 *
 * ## The drivers come from the page, not from a second query
 *
 * `FahrerPage` already holds them. Querying again would be a second list that
 * can disagree with the one beside it on the same screen.
 *
 * ## The waiting count is a bound, and says so when it is one
 *
 * Confirming claims the submissions that arrived before the link, so an
 * operator wants to know how many before deciding. That preview is two bounded
 * queries counted in the browser; past the bound the column shows `>n` rather
 * than a number it cannot stand behind. The EXACT figures come back from the
 * decision itself — `claimed` from the confirm, `stranded` from the reject —
 * and those are what the toast reports.
 *
 * ## Gated by the page, like the RPCs
 *
 * `canEdit(undefined, 'drivers')`. The first argument of a `WriteRight` is
 * ignored by AuthContext (it is named `_createdByOrRecord`), so the page key is
 * the whole question, and `drivers` is exactly what
 * `current_role_permits('drivers', true)` asks inside both RPCs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Link2, RefreshCw, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import type { Driver } from '../../types/receipt';
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
  NativeSelect,
  Tabs,
  TabsList,
  TabsTrigger,
  type DataTableColumn,
} from '../ui';

type LinkStatus = 'pending' | 'linked' | 'rejected';

interface Proposal {
  id: string;
  partner: string;
  external_driver_id: string;
  proposed_name: string | null;
  proposed_email: string | null;
  proposed_phone: string | null;
  status: LinkStatus;
  driver_id: string | null;
  partner_removed_at: string | null;
  created_at: string;
  drivers: { name: string } | null;
}

/** The stable codes both RPCs raise, against what the operator is told. */
const REASON_KEYS: Record<string, TranslationKey> = {
  link_not_found: 'partner.links.error.linkNotFound',
  driver_not_found: 'partner.links.error.driverNotFound',
  already_decided: 'partner.links.error.alreadyDecided',
  driver_already_linked: 'partner.links.error.driverAlreadyLinked',
  not_authorized: 'partner.links.error.notAuthorized',
};

/** The pull function's reasons. Separate from the decisions' above: the
 *  repairs are different — most of these send the operator to Settings. */
const PULL_REASON_KEYS: Record<string, TranslationKey> = {
  not_connected: 'partner.pull.error.notConnected',
  seal_unreadable: 'partner.pull.error.sealUnreadable',
  token_rejected: 'partner.pull.error.tokenRejected',
  partner_unavailable: 'partner.pull.error.partnerUnavailable',
  not_authorized: 'partner.pull.error.notAuthorized',
  seal_key_missing: 'partner.pull.error.notConfigured',
  endpoint_missing: 'partner.pull.error.notConfigured',
  endpoint_unparsable: 'partner.pull.error.notConfigured',
  endpoint_not_https: 'partner.pull.error.notConfigured',
  endpoint_has_credentials: 'partner.pull.error.notConfigured',
  endpoint_private_host: 'partner.pull.error.notConfigured',
  endpoint_unexpected_port: 'partner.pull.error.notConfigured',
  endpoint_has_path: 'partner.pull.error.notConfigured',
};

const COLUMNS = 'id, partner, external_driver_id, proposed_name, proposed_email, '
  + 'proposed_phone, status, driver_id, partner_removed_at, created_at, drivers(name)';

/** Past this the waiting count is reported as a bound, not a number. */
const WAITING_SCAN_LIMIT = 1000;

interface PartnerLinkProposalsProps {
  companyId: string | null;
  drivers: Driver[];
}

export function PartnerLinkProposals({ companyId, drivers }: PartnerLinkProposalsProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canEdit } = useCompanyScope();
  const mayDecide = canEdit(undefined, 'drivers');

  const [rows, setRows] = useState<Proposal[]>([]);
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [waitingCapped, setWaitingCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<LinkStatus>('pending');
  const [confirming, setConfirming] = useState<Proposal | null>(null);
  const [rejecting, setRejecting] = useState<Proposal | null>(null);
  const [chosenDriver, setChosenDriver] = useState('');
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);

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
        .from('partner_driver_links')
        .select(COLUMNS)
        .eq('company_id', companyId)
        .eq('status', status)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows((data ?? []) as unknown as Proposal[]);

      // Only the open tab needs the preview: a decided proposal's submissions
      // have already been claimed or stranded.
      if (status !== 'pending') {
        setWaiting({});
        setWaitingCapped(false);
        return;
      }
      const counts: Record<string, number> = {};
      let capped = false;
      for (const table of ['partner_note_submissions', 'partner_receipt_submissions'] as const) {
        const { data: pending, error: countError } = await supabase
          .from(table)
          .select('partner, external_driver_id')
          .eq('company_id', companyId)
          .eq('status', 'pending')
          .is('driver_id', null)
          .limit(WAITING_SCAN_LIMIT + 1);
        if (countError) throw countError;
        const list = (pending ?? []) as { partner: string; external_driver_id: string }[];
        if (list.length > WAITING_SCAN_LIMIT) capped = true;
        for (const row of list) {
          const key = `${row.partner}\u0000${row.external_driver_id}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      setWaiting(counts);
      setWaitingCapped(capped);
    } catch {
      // An empty table would read as "no proposals", which is what a failed
      // read must not say.
      setLoadFailed(true);
      setRows([]);
      setWaiting({});
    } finally {
      setLoading(false);
    }
  }, [companyId, status]);

  useEffect(() => { void load(); }, [load]);

  // By a button and not a schedule — the owner's decision of 06.10.2026. The
  // function needs a session for exactly that reason.
  const pull = async () => {
    setPulling(true);
    try {
      const { data, error } = await supabase.functions.invoke('partner-pull', { body: {} });
      if (error) throw error;
      const answer = data as {
        ok?: boolean; reason?: string;
        seen?: number; new?: number; departed?: number; truncated?: boolean;
      };
      if (!answer?.ok) {
        const key = answer?.reason ? PULL_REASON_KEYS[answer.reason] : undefined;
        showToast('error', key ? t(key) : t('partner.pull.error.generic'));
        return;
      }
      const departed = answer.departed ?? 0;
      showToast('success', departed > 0
        ? t('partner.pull.doneWithDepartures', {
            seen: String(answer.seen ?? 0),
            created: String(answer.new ?? 0),
            departed: String(departed),
          })
        : t('partner.pull.done', {
            seen: String(answer.seen ?? 0),
            created: String(answer.new ?? 0),
          }));
      // A roster longer than one walk is said out loud rather than left as a
      // short list the operator would read as complete.
      if (answer.truncated) showToast('error', t('partner.pull.truncated'));
      await load();
    } catch {
      showToast('error', t('partner.pull.error.generic'));
    } finally {
      setPulling(false);
    }
  };

  const reasonMessage = (hint: unknown): string => {
    const key = typeof hint === 'string' ? REASON_KEYS[hint] : undefined;
    return key ? t(key) : t('partner.links.error.generic');
  };

  const confirm = async () => {
    if (!confirming || chosenDriver === '') return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('partner_driver_link_confirm', {
        p_link_id: confirming.id,
        p_driver_id: chosenDriver,
      });
      if (error) throw error;
      const result = data as { receipts?: number; notes?: number } | null;
      const claimed = (result?.receipts ?? 0) + (result?.notes ?? 0);
      showToast('success', claimed > 0
        ? t('partner.links.confirmedWithClaim', { count: String(claimed) })
        : t('partner.links.confirmed'));
      setConfirming(null);
      setChosenDriver('');
      await load();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!rejecting) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('partner_driver_link_reject', {
        p_link_id: rejecting.id,
      });
      if (error) throw error;
      const stranded = (data as { stranded?: number } | null)?.stranded ?? 0;
      showToast('success', stranded > 0
        ? t('partner.links.rejectedWithStranded', { count: String(stranded) })
        : t('partner.links.rejected'));
      setRejecting(null);
      await load();
    } catch (error) {
      showToast('error', reasonMessage((error as { hint?: unknown })?.hint));
    } finally {
      setBusy(false);
    }
  };

  // Only the drivers an operator could sensibly pick, and the list the page is
  // already showing beside this one.
  const pickable = useMemo(
    () => drivers.filter(driver => driver.status !== 'inactive'),
    [drivers],
  );

  const waitingFor = (row: Proposal): number =>
    waiting[`${row.partner}\u0000${row.external_driver_id}`] ?? 0;

  const columns = useMemo<DataTableColumn<Proposal>[]>(() => [
    {
      id: 'proposed',
      header: t('partner.links.col.proposed'),
      value: row => row.proposed_name ?? '',
      sortable: true,
      cell: row => <span>{row.proposed_name || '—'}</span>,
    },
    {
      id: 'contact',
      header: t('partner.links.col.contact'),
      value: row => row.proposed_email ?? '',
      cell: row => <span>{row.proposed_email || row.proposed_phone || '—'}</span>,
      hideBelow: 'md',
    },
    {
      id: 'externalId',
      header: t('partner.links.col.externalId'),
      value: row => row.external_driver_id,
      cell: row => <span className="tabular-nums">{row.partner} · {row.external_driver_id}</span>,
      hideBelow: 'lg',
    },
    {
      id: 'driver',
      header: t('partner.links.col.driver'),
      value: row => row.drivers?.name ?? '',
      sortable: true,
      cell: row => (
        <div className="flex flex-col gap-1">
          {row.drivers?.name
            ? <span>{row.drivers.name}</span>
            : <Badge tone="caution">{t('partner.links.notLinked')}</Badge>}
          {/* The owner's decision of 08.10.2026: a departed driver is badged
              and the link stays. The tooltip says why, because "removed at the
              partner" beside a live link reads as a contradiction otherwise. */}
          {row.partner_removed_at ? (
            <Badge tone="neutral" title={t('partner.links.departedHint')}>
              {t('partner.links.departedBadge')}
            </Badge>
          ) : null}
        </div>
      ),
    },
    ...(status === 'pending'
      ? [{
          id: 'waiting',
          header: t('partner.links.col.waiting'),
          kind: 'number',
          value: (row: Proposal) => waitingFor(row),
          sortable: true,
          cell: (row: Proposal) => (
            <span className="tabular-nums">
              {waitingCapped ? '>' : ''}{waitingFor(row)}
            </span>
          ),
          hideBelow: 'sm',
        } satisfies DataTableColumn<Proposal>]
      : []),
    {
      id: 'created',
      header: t('partner.links.col.created'),
      kind: 'date',
      value: row => row.created_at,
      sortable: true,
      hideBelow: 'lg',
    },
  ], [status, waiting, waitingCapped, t]);

  return (
    <div className="font-ui space-y-4">
      <Alert tone="brand" role="note" title={t('partner.links.confirm.title')}>
        {t('partner.links.confirm.description')}
      </Alert>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={status} onValueChange={value => setStatus(value as LinkStatus)}>
          <TabsList variant="segmented" aria-label={t('partner.links.filterLabel')}>
            <TabsTrigger value="pending">{t('partner.links.status.pending')}</TabsTrigger>
            <TabsTrigger value="linked">{t('partner.links.status.linked')}</TabsTrigger>
            <TabsTrigger value="rejected">{t('partner.links.status.rejected')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {mayDecide ? (
          <Button
            variant="secondary"
            onClick={() => void pull()}
            loading={pulling}
            disabled={pulling || busy}
            title={t('partner.pull.hint')}
          >
            <RefreshCw className="size-4" aria-hidden />
            {t('partner.pull.action')}
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={row => row.id}
        caption={t('partner.links.caption')}
        loading={loading}
        error={loadFailed ? t('partner.links.loadFailed') : null}
        onRetry={() => void load()}
        initialSort={{ columnId: 'created', direction: 'desc' }}
        emptyState={(
          <div className="flex flex-col items-center gap-2 py-6 text-fg-muted">
            <Link2 className="h-6 w-6" aria-hidden />
            <span>{t('partner.links.empty')}</span>
          </div>
        )}
        rowActionsLabel={t('partner.links.actionsLabel')}
        rowActions={status === 'pending' && mayDecide
          ? row => (
              <div className="grid grid-cols-[auto_auto] gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('partner.links.action.confirm')}
                  title={t('partner.links.action.confirm')}
                  onClick={() => { setConfirming(row); setChosenDriver(''); }}
                >
                  <Check className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('partner.links.action.reject')}
                  title={t('partner.links.action.reject')}
                  onClick={() => setRejecting(row)}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            )
          : undefined}
      />

      {/* A Dialog and not ConfirmDialog: the driver has to be chosen, so the
          sheet stays open and carries a field. */}
      <Dialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('partner.links.confirm.title')}</DialogTitle>
            <DialogDescription>{t('partner.links.confirm.description')}</DialogDescription>
          </DialogHeader>
          {confirming ? (
            <p className="text-sm text-fg-muted">
              {confirming.partner} · {confirming.external_driver_id}
              {confirming.proposed_name ? ` · ${confirming.proposed_name}` : ''}
            </p>
          ) : null}
          {/* NativeSelect and not the Radix Select: the browser's own picker on
              a phone, no portal inside a portal, and it is what DriverModal
              already uses on this screen. */}
          <Field label={t('partner.links.confirm.label')} id="partner-link-driver">
            <NativeSelect
              id="partner-link-driver"
              value={chosenDriver}
              onChange={event => setChosenDriver(event.target.value)}
            >
              <option value="">{t('partner.links.confirm.placeholder')}</option>
              {pickable.map(driver => (
                <option key={driver.id} value={driver.id}>{driver.name}</option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void confirm()} disabled={busy || chosenDriver === ''}>
              {t('partner.links.confirm.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejecting !== null} onOpenChange={open => { if (!open) setRejecting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('partner.links.reject.title')}</DialogTitle>
            {/* The consequence is stated BEFORE the decision: the submissions
                waiting on this proposal stay open and have to be decided one by
                one. The exact number comes back from the call. */}
            <DialogDescription>{t('partner.links.reject.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void reject()} disabled={busy}>
              {t('partner.links.reject.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
