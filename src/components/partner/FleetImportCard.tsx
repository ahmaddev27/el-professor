/**
 * The fleet import: one button, every leg (drivers, then vehicles, then the
 * whole Uber earnings history day by day — `runEarningsBackfill`).
 *
 * Each leg does both halves in order (`runImportLeg`, partnerFleetImport.ts). It asks `partner-pull` to store the
 * partner's list as proposals, then asks the database to turn the proposals
 * into drivers or cars (linking to what already exists, never duplicating it).
 * There is no confirmation step: the owner's decision of 14.10.2026 is that the
 * administrator fixes anything afterwards on the ordinary screens.
 *
 * ## Four states, and a failure is never a zero
 *
 * idle, running and finished, where each leg is done (with the counts the
 * database returned), unavailable (the partner does not offer it yet) or failed
 * (with a translated reason). A failing leg never stops the next one, and the
 * overall result is a success only when every leg imported. An answer that does
 * not carry its counts is a failure, see `parseImportResult`: "0 created" is a
 * claim, and the screen must not make it on the strength of a missing field.
 */
import { useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  overallStatus,
  runFleetImport,
  skipReasonKey,
  type FleetOutcome,
  type ImportDeps,
  type ImportScope,
  type LegOutcome,
} from '../../lib/partnerFleetImport';
import { runEarningsBackfill, type BackfillProgress, type EarningsOutcome, type UnmatchedGap } from '../../lib/uberBackfill';
import { supabaseBackfillDeps } from '../../lib/uberBackfillDeps';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, formatDate } from '../ui';

/** Past this the list says how many more there are. */
const SKIPPED_SHOWN = 20;

type State =
  | { kind: 'idle' }
  | { kind: 'running'; progress: BackfillProgress | null }
  | { kind: 'finished'; outcomes: FleetOutcome[] };

interface FleetImportCardProps {
  /** Connected to the partner. Without it the button explains instead of failing. */
  connected: boolean;
  /** An administrator outside a read-only context; the database decides again. */
  mayImport: boolean;
}

const LEG_TITLE = { drivers: 'import.drivers.title', vehicles: 'import.vehicles.title' } as const;

const DEPS: ImportDeps = {
  pull: scope => supabase.functions.invoke('partner-pull', { body: { scope } }),
  importRpc: async rpc => await supabase.rpc(rpc, { p_partner: 'reidey' }),
};

export function FleetImportCard({ connected, mayImport }: FleetImportCardProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const stopRequested = useRef(false);

  const run = async () => {
    stopRequested.current = false;
    setState({ kind: 'running', progress: null });
    const report = (progress: BackfillProgress) => setState({ kind: 'running', progress });
    const earnings = (r: typeof report) => runEarningsBackfill(supabaseBackfillDeps(() => stopRequested.current), r);
    setState({ kind: 'finished', outcomes: await runFleetImport(DEPS, earnings, report) });
  };

  const running = state.kind === 'running';

  return (
    <Card className="font-ui">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle as="h2">
            <span className="inline-flex items-center gap-2">
              <Download className="size-4" aria-hidden />
              {t('import.all.title')}
            </span>
          </CardTitle>
          <CardDescription>{t('import.all.body')}</CardDescription>
        </div>
        <Button onClick={() => void run()} loading={running} disabled={running || !connected || !mayImport}>
          {t('import.all.action')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!connected ? (
          <p className="text-sm text-fg-muted">{t('import.needsConnection')}</p>
        ) : !mayImport ? (
          <p className="text-sm text-fg-muted">{t('import.adminOnly')}</p>
        ) : null}

        {state.kind === 'running' ? (
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {progressText(state.progress, t)}
            {state.progress ? (
              <Button variant="secondary" size="sm" onClick={() => { stopRequested.current = true; }}>
                {t('import.stop')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {state.kind === 'finished' ? <Outcomes outcomes={state.outcomes} /> : null}
      </CardContent>
    </Card>
  );
}

function Outcomes({ outcomes }: { outcomes: FleetOutcome[] }) {
  const { t } = useTranslation();
  const overall = overallStatus(outcomes);
  return (
    <div className="space-y-3">
      {overall === 'success' ? (
        <Alert tone="positive" title={t('import.doneTitle')} />
      ) : overall === 'partial' ? (
        <Alert tone="caution" title={t('import.partialTitle')}>{t('import.partialBody')}</Alert>
      ) : (
        <Alert tone="critical" title={t('import.failedTitle')} />
      )}
      {outcomes.map(outcome => <LegOutcomeView key={outcome.scope} outcome={outcome} />)}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function progressText(progress: BackfillProgress | null, t: Translate): string {
  if (!progress) return t('import.running');
  if (progress.phase === 'looking') return t('import.earnings.looking', { weeks: String(progress.weeksChecked) });
  return t('import.earnings.importing', {
    from: formatDate(progress.day), to: formatDate(progress.last), rows: String(progress.rows),
  });
}

function EarningsView({ outcome }: { outcome: EarningsOutcome }) {
  const { t } = useTranslation();
  const title = t('import.earnings.title');
  const body = earningsBody(outcome, t);
  const tone = outcome.status === 'done' || outcome.status === 'nothing' ? 'positive'
    : outcome.status === 'unavailable' ? 'neutral'
    : outcome.status === 'stopped' || outcome.status === 'gap' ? 'caution' : 'critical';
  const drivers = outcome.status === 'done' || outcome.status === 'stopped' || outcome.status === 'failed'
    || outcome.status === 'gap' ? outcome : null;
  return (
    <div className="space-y-3">
      <Alert tone={tone} title={title}>{body}</Alert>
      {drivers && drivers.unmatched.length > 0 ? (
        <Alert tone="critical" title={t('import.earnings.gapTitle')}>
          {t('import.earnings.gapBody', { names: drivers.unmatched.map(g => gapEntry(g, t)).join(', ') })}
        </Alert>
      ) : null}
      {drivers && drivers.created.length > 0 ? (
        <Alert tone="caution" title={t('import.earnings.createdTitle')}>
          {t('import.earnings.createdBody', { names: drivers.created.join(', ') })}
        </Alert>
      ) : null}
      {drivers && drivers.linked.length > 0 ? (
        <Alert tone="neutral" title={t('import.earnings.linkedTitle')}>
          {t('import.earnings.linkedBody', { names: drivers.linked.join(', ') })}
        </Alert>
      ) : null}
    </div>
  );
}

/** `Name` or `Name (trips: 12)`: the count is Reidey's, shown only when it sent one. */
function gapEntry(gap: UnmatchedGap, t: Translate): string {
  return gap.trips === null ? gap.name : t('import.earnings.gapEntry', { name: gap.name, trips: String(gap.trips) });
}

function earningsBody(o: EarningsOutcome, t: Translate): string {
  switch (o.status) {
    case 'gap':
      return t('import.earnings.gap', {
        from: formatDate(o.from), to: formatDate(o.to), days: String(o.days), rows: String(o.rows),
      });
    case 'done':
      return o.resumed && o.days === 0
        ? t('import.earnings.upToDate', { to: formatDate(o.to) })
        : t('import.earnings.done', {
          from: formatDate(o.from), to: formatDate(o.to), days: String(o.days), rows: String(o.rows),
        });
    case 'nothing': return t('import.earnings.nothing');
    case 'unavailable': return t(o.reason);
    case 'stopped':
      return o.through
        ? t('import.earnings.stoppedAfter', { through: formatDate(o.through), rows: String(o.rows) })
        : t('import.earnings.stoppedNone');
    case 'failed': {
      const reason = o.reason === 'import.earnings.unresolved'
        ? t(o.reason, { names: o.detail ?? '' })
        : `${t(o.reason)}${o.detail ? ` (${o.detail})` : ''}`;
      return o.through
        ? t('import.earnings.failedAfter', {
          through: formatDate(o.through), rows: String(o.rows), reason,
        })
        : t('import.earnings.failedNone', { reason });
    }
  }
}

function LegOutcomeView({ outcome }: { outcome: FleetOutcome }) {
  const { t } = useTranslation();
  if (outcome.scope === 'earnings') return <EarningsView outcome={outcome.earnings} />;
  const title = t(LEG_TITLE[outcome.scope]);
  if (outcome.status === 'unavailable') {
    return <Alert tone="neutral" title={title}>{t(outcome.reason)}</Alert>;
  }
  if (outcome.status === 'failed') {
    return <Alert tone="critical" title={title}>{t(outcome.reason)}</Alert>;
  }
  return <ImportOutcome scope={outcome.scope} title={title} seen={outcome.seen} result={outcome.result} />;
}

function ImportOutcome({ scope, title, seen, result }: {
  scope: ImportScope; title: string; seen: number; result: Extract<LegOutcome, { status: 'done' }>['result'];
}) {
  const { t } = useTranslation();
  const shown = result.skipped.slice(0, SKIPPED_SHOWN);
  const nothing = result.created + result.linked + result.skipped.length === 0;

  return (
    <div className="space-y-3">
      <Alert tone={nothing ? 'neutral' : 'positive'} title={title}>
        {nothing
          ? t('import.nothingNew', { seen: String(seen) })
          : t('import.doneBody', {
              seen: String(seen),
              created: String(result.created),
              linked: String(result.linked),
              skipped: String(result.skipped.length),
            })}
      </Alert>
      {result.skipped.length > 0 ? (
        <div>
          <p className="mb-2 text-sm font-medium text-fg">{t('import.skippedTitle')}</p>
          <ul className="space-y-1.5">
            {shown.map(row => (
              <li key={row.linkId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-fg">{row.label || '—'}</span>
                <Badge tone="caution">{t(skipReasonKey(row.reason, scope))}</Badge>
              </li>
            ))}
          </ul>
          {result.skipped.length > shown.length ? (
            <p className="mt-2 text-sm text-fg-muted">
              {t('import.skippedMore', { count: String(result.skipped.length - shown.length) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
