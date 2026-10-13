import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { addDays, format, startOfWeek, subWeeks } from 'date-fns';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { splitIntoBusinessWeeks, type UnmatchedEarner } from '../../supabase/functions/_shared/uber-earnings-core';
import {
  blockingEarners,
  buildImportRows,
  findUnlinked,
  readPullAnswer,
  summarizeByDriver,
  weekNumberOf,
  type DriverLinks,
  type DriverPreview,
  type WeekEarnings,
} from '../utils/uberEarningsImport';
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
  formatDate,
  formatEuroCents,
  formatNumber,
  Input,
  type DataTableColumn,
} from './ui';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the rows are written, so the screen reloads its list. */
  onImported: () => void;
}

type Stage = 'range' | 'pulling' | 'preview' | 'importing';

interface Pulled {
  weeks: WeekEarnings[];
  links: DriverLinks;
  unmatched: UnmatchedEarner[];
}

// Reidey's own stable refusal reasons, named. Anything else is shown with its
// code rather than as a bare failure: a pull that touches money says what it is.
const PARTNER_REASON_KEYS: Record<string, TranslationKey> = {
  no_proxy: 'inc.uber.err.partner.no_proxy',
  uber_session_rejected: 'inc.uber.err.partner.uber_session_rejected',
  too_many_pages: 'inc.uber.err.partner.too_many_pages',
  unreadable_amount: 'inc.uber.err.partner.unreadable_amount',
  range_too_long: 'inc.uber.err.partner.range_too_long',
};

// Reasons the edge function and the database answer with. Values are
// TranslationKeys; an unknown reason falls through to the generic sentence.
const PULL_REASON_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  not_connected: 'inc.uber.err.notConnected',
  seal_unreadable: 'inc.uber.err.notConnected',
  token_rejected: 'inc.uber.err.tokenRejected',
  partner_unavailable: 'inc.uber.err.partnerUnavailable',
  partner_malformed: 'inc.uber.err.partnerMalformed',
  invalid_range: 'inc.uber.err.invalidRange',
  range_too_long: 'inc.uber.err.rangeTooLong',
};

const IMPORT_HINT_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  platform_session_not_allowed: 'inc.uber.err.platformSession',
  driver_not_linked: 'inc.uber.err.driverNotLinked',
  already_imported: 'inc.uber.err.alreadyImported',
  invalid_request: 'inc.uber.err.invalidRows',
  invalid_period: 'inc.uber.err.invalidRows',
};

/** supabase-js hides the body of a non-2xx answer behind `error.context`. */
async function failureReason(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    const body = (await context.json()) as { reason?: unknown };
    return typeof body?.reason === 'string' ? body.reason : null;
  } catch {
    return null;
  }
}

function lastBusinessWeek(): { from: string; to: string } {
  const monday = startOfWeek(subWeeks(new Date(), 1), { weekStartsOn: 1 });
  return { from: format(monday, 'yyyy-MM-dd'), to: format(addDays(monday, 6), 'yyyy-MM-dd') };
}

function UberEarningsImportModal({ isOpen, onClose, onImported }: Props) {
  const { t, tPlural } = useTranslation();
  const { success } = useToast();
  const initial = useMemo(lastBusinessWeek, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [stage, setStage] = useState<Stage>('range');
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A pull still in flight when the dialog closes must not open a preview later.
  const generation = useRef(0);

  const split = splitIntoBusinessWeeks(from, to);
  const rangeProblem: TranslationKey | null = split.ok
    ? null
    : split.problem === 'range_too_long' ? 'inc.uber.err.rangeTooLong' : 'inc.uber.err.invalidRange';

  const rows = useMemo(() => (pulled ? buildImportRows(pulled.weeks) : []), [pulled]);
  const unlinked = useMemo(() => (pulled ? findUnlinked(pulled.weeks, pulled.links) : []), [pulled]);
  // Both causes stop the import and both are named: an earner Reidey cannot
  // place, and a Reidey driver nobody here has linked.
  const blocking = useMemo(() => blockingEarners(unlinked, pulled?.unmatched ?? []), [unlinked, pulled]);
  const preview = useMemo(() => (pulled ? summarizeByDriver(pulled.weeks, pulled.links) : []), [pulled]);

  const close = () => {
    generation.current += 1;
    setStage('range');
    setPulled(null);
    setProblem(null);
    onClose();
  };

  const pull = async () => {
    const mine = ++generation.current;
    setStage('pulling');
    setProblem(null);
    try {
      const { data, error } = await supabase.functions.invoke('uber-earnings-pull', { body: { from, to } });
      if (mine !== generation.current) return;
      const body = data as { reason?: string; partner_reason?: string } | null;
      const reason = error ? await failureReason(error) : body?.reason ?? null;
      const read = error || reason ? null : readPullAnswer(data);
      if (!read) {
        const partnerReason = reason === 'partner_refused' ? body?.partner_reason ?? '' : '';
        setProblem(
          reason === 'partner_refused'
            ? t(PARTNER_REASON_KEYS[partnerReason] ?? 'inc.uber.err.partner.generic', { reason: partnerReason })
            : t(reason && PULL_REASON_KEYS[reason] ? PULL_REASON_KEYS[reason] : 'inc.uber.err.generic'),
        );
        setStage('range');
        return;
      }
      setPulled(read);
      setStage('preview');
    } catch {
      if (mine !== generation.current) return;
      setProblem(t('inc.uber.err.generic'));
      setStage('range');
    }
  };

  const confirm = async () => {
    setStage('importing');
    setProblem(null);
    const { data, error } = await supabase.rpc('income_import_uber', { p_rows: rows });
    if (error) {
      const hint = (error as { hint?: string }).hint ?? '';
      const key = IMPORT_HINT_KEYS[hint] ?? 'inc.uber.err.generic';
      const detail = hint === 'driver_not_linked' ? (error as { details?: string }).details : undefined;
      setProblem(detail ? `${t(key)} (${detail})` : t(key));
      setStage('preview');
      return;
    }
    const result = data as { inserted?: number; drivers?: number } | null;
    success(
      t('inc.uber.doneTitle'),
      t('inc.uber.doneBody', { rows: String(result?.inserted ?? rows.length), drivers: String(result?.drivers ?? 0) }),
    );
    onImported();
    close();
  };

  // ── Presentation ──────────────────────────────────────────────────────────

  const sum = (pick: (row: DriverPreview) => number) => preview.reduce((acc, row) => acc + pick(row), 0);
  const money = (cents: number) => <span className="tabular-nums">{formatEuroCents(cents)}</span>;

  const columns: DataTableColumn<DriverPreview>[] = [
    {
      id: 'driver',
      header: t('common.driver'),
      value: row => row.ourName ?? row.uberName,
      cell: row => (
        <div className="grid gap-0.5">
          {row.ourName ? (
            <span className="font-medium text-fg">{row.ourName}</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{row.uberName}</span>
              <Badge tone="critical">{t('inc.uber.unlinked')}</Badge>
            </span>
          )}
          {row.ourName && row.ourName !== row.uberName && (
            <span className="text-xs text-fg-subtle">{t('inc.uber.uberName', { name: row.uberName })}</span>
          )}
        </div>
      ),
    },
    { id: 'fare', header: t('inc.nettoFahrpreis'), kind: 'currency', value: row => row.fareCents, cell: row => money(row.fareCents) },
    { id: 'promotion', header: t('inc.typeAktionen'), kind: 'currency', value: row => row.promotionCents, cell: row => money(row.promotionCents), hideBelow: 'md' },
    { id: 'tips', header: t('inc.typeTrinkgeld'), kind: 'currency', value: row => row.tipsCents, cell: row => money(row.tipsCents), hideBelow: 'md' },
    { id: 'cash', header: t('inc.typeBargeld'), kind: 'currency', value: row => row.cashCents, cell: row => money(row.cashCents), hideBelow: 'sm' },
    {
      id: 'trips',
      header: t('inc.tripCount'),
      kind: 'number',
      value: row => row.trips,
      cell: row => (row.trips === null ? '—' : formatNumber(row.trips)),
      hideBelow: 'sm',
    },
    {
      id: 'difference',
      header: t('inc.uber.difference'),
      kind: 'currency',
      value: row => row.differenceCents,
      cell: row =>
        row.hasDifference ? (
          <span className="inline-flex items-center justify-end gap-1 font-medium tabular-nums text-critical">
            <AlertTriangle aria-hidden className="size-3.5" />
            {formatEuroCents(row.differenceCents)}
            <span className="sr-only"> {t('inc.uber.differenceFlag')}</span>
          </span>
        ) : (
          money(0)
        ),
    },
  ];

  const weekLines = pulled?.weeks.map(w => `${t('inc.weekLabel', { week: weekNumberOf(w.segment) })}: ${formatDate(w.segment.from)} – ${formatDate(w.segment.to)}`) ?? [];
  const busy = stage === 'pulling' || stage === 'importing';
  const canConfirm = stage === 'preview' && rows.length > 0 && blocking.length === 0;

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('inc.uber.title')}</DialogTitle>
          <DialogDescription>
            {stage === 'preview' || stage === 'importing' ? t('inc.uber.previewIntro') : t('inc.uber.rangeIntro')}
          </DialogDescription>
        </DialogHeader>

        {problem && <Alert tone="critical" title={t('inc.uber.errorTitle')}>{problem}</Alert>}

        {(stage === 'range' || stage === 'pulling') && (
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('inc.uber.from')} required>
                <Input type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={busy} />
              </Field>
              <Field label={t('inc.uber.to')} required error={rangeProblem ? t(rangeProblem) : undefined}>
                <Input type="date" value={to} onChange={e => setTo(e.target.value)} disabled={busy} />
              </Field>
            </div>
            {split.ok && (
              <p className="text-sm text-fg-muted">
                {tPlural({ one: 'inc.uber.weeksCount.one', other: 'inc.uber.weeksCount.other' }, split.value.length)}
              </p>
            )}
          </div>
        )}

        {(stage === 'preview' || stage === 'importing') && pulled && (
          <div className="grid grid-cols-1 gap-4">
            <p className="text-sm text-fg-muted">{weekLines.join(' · ')}</p>

            {blocking.length > 0 && (
              <Alert tone="critical" title={t('inc.uber.blockedTitle')}>
                <p>{t('inc.uber.blockedBody')}</p>
                <ul className="mt-2 list-disc pl-5">
                  {blocking.map((b, i) => (
                    <li key={`${b.kind}-${b.externalDriverId ?? b.name}-${i}`}>
                      {b.kind === 'unmatched_at_reidey'
                        ? t('inc.uber.blockedUnmatched', { name: b.name })
                        : t('inc.uber.blockedUnlinked', { name: b.name, id: b.externalDriverId ?? '' })}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {blocking.length === 0 && rows.length === 0 && (
              <Alert tone="caution">{t('inc.uber.nothingToImport')}</Alert>
            )}

            <DataTable
              caption={t('inc.uber.previewCaption')}
              columns={columns}
              rows={preview}
              getRowId={row => row.externalDriverId}
              density="compact"
              totals={{
                driver: t('inc.sum'),
                fare: money(sum(r => r.fareCents)),
                promotion: money(sum(r => r.promotionCents)),
                tips: money(sum(r => r.tipsCents)),
                cash: money(sum(r => r.cashCents)),
                difference: money(sum(r => r.differenceCents)),
              }}
            />
          </div>
        )}

        <DialogFooter>
          {(stage === 'range' || stage === 'pulling') && (
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
              <Button onClick={pull} disabled={!split.ok || busy}>
                {stage === 'pulling' ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
                {stage === 'pulling' ? t('inc.uber.loading') : t('inc.uber.load')}
              </Button>
            </>
          )}
          {(stage === 'preview' || stage === 'importing') && (
            <>
              <Button variant="secondary" onClick={() => { setStage('range'); setPulled(null); setProblem(null); }} disabled={busy}>
                {t('inc.uber.changeRange')}
              </Button>
              <Button onClick={confirm} disabled={!canConfirm || busy}>
                {stage === 'importing' && <Loader2 aria-hidden className="animate-spin" />}
                {stage === 'importing' ? t('inc.uber.importing') : t('inc.uber.confirm', { count: String(rows.length) })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default UberEarningsImportModal;
