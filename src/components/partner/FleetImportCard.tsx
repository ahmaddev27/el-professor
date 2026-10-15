/**
 * One pull-and-create card of the fleet import: drivers or vehicles.
 *
 * The button does both halves in order. It asks `partner-pull` to store the
 * partner's list as proposals, then asks the database to turn the proposals
 * into drivers or cars (linking to what already exists, never duplicating it).
 * There is no confirmation step: the owner's decision of 14.10.2026 is that the
 * administrator fixes anything afterwards on the ordinary screens.
 *
 * ## Four states, and a failure is never a zero
 *
 * idle, running, done (with the counts the database returned) and failed (with
 * a translated reason). An answer that does not carry its counts is a failure,
 * see `parseImportResult`: "0 created" is a claim, and the screen must not make
 * it on the strength of a missing field.
 */
import { useState } from 'react';
import { CarFront, Loader2, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  importErrorKey,
  parseImportResult,
  pullReasonKey,
  skipReasonKey,
  type ImportResult,
  type ImportScope,
} from '../../lib/partnerFleetImport';
import type { TranslationKey } from '../../i18n';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui';

/** Past this the list says how many more there are. */
const SKIPPED_SHOWN = 20;

type DoneState = { kind: 'done'; seen: number; result: ImportResult };

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | DoneState
  | { kind: 'failed'; reason: TranslationKey };

interface FleetImportCardProps {
  scope: ImportScope;
  /** Connected to the partner. Without it the button explains instead of failing. */
  connected: boolean;
  /** An administrator outside a read-only context; the database decides again. */
  mayImport: boolean;
}

const COPY = {
  drivers: {
    title: 'import.drivers.title',
    body: 'import.drivers.body',
    action: 'import.drivers.action',
    Icon: Users,
    rpc: 'partner_drivers_import',
  },
  vehicles: {
    title: 'import.vehicles.title',
    body: 'import.vehicles.body',
    action: 'import.vehicles.action',
    Icon: CarFront,
    rpc: 'partner_vehicles_import',
  },
} as const;

export function FleetImportCard({ scope, connected, mayImport }: FleetImportCardProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const copy = COPY[scope];

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const pulled = await supabase.functions.invoke('partner-pull', { body: { scope } });
      if (pulled.error) throw pulled.error;
      const answer = pulled.data as { ok?: boolean; reason?: string; seen?: number } | null;
      if (!answer?.ok) {
        setState({ kind: 'failed', reason: pullReasonKey(answer?.reason) });
        return;
      }
      const imported = await supabase.rpc(copy.rpc, { p_partner: 'reidey' });
      if (imported.error) {
        setState({ kind: 'failed', reason: importErrorKey((imported.error as { hint?: unknown }).hint) });
        return;
      }
      const result = parseImportResult(imported.data, scope);
      setState(result
        ? { kind: 'done', seen: answer.seen ?? 0, result }
        : { kind: 'failed', reason: 'import.error.importGeneric' });
    } catch {
      setState({ kind: 'failed', reason: 'import.error.pullGeneric' });
    }
  };

  const running = state.kind === 'running';

  return (
    <Card className="font-ui">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle as="h2">
            <span className="inline-flex items-center gap-2">
              <copy.Icon className="size-4" aria-hidden />
              {t(copy.title)}
            </span>
          </CardTitle>
          <CardDescription>{t(copy.body)}</CardDescription>
        </div>
        <Button onClick={() => void run()} loading={running} disabled={running || !connected || !mayImport}>
          {t(copy.action)}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!connected ? (
          <p className="text-sm text-fg-muted">{t('import.needsConnection')}</p>
        ) : !mayImport ? (
          <p className="text-sm text-fg-muted">{t('import.adminOnly')}</p>
        ) : null}

        {running ? (
          <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('import.running')}
          </div>
        ) : null}

        {state.kind === 'failed' ? (
          <Alert tone="critical" title={t('import.failedTitle')}>{t(state.reason)}</Alert>
        ) : null}

        {state.kind === 'done' ? <ImportOutcome scope={scope} done={state} /> : null}
      </CardContent>
    </Card>
  );
}

function ImportOutcome({ scope, done }: { scope: ImportScope; done: DoneState }) {
  const { t } = useTranslation();
  const { result } = done;
  const shown = result.skipped.slice(0, SKIPPED_SHOWN);
  const nothing = result.created + result.linked + result.skipped.length === 0;

  return (
    <div className="space-y-3">
      <Alert tone={nothing ? 'neutral' : 'positive'} title={t('import.doneTitle')}>
        {nothing
          ? t('import.nothingNew', { seen: String(done.seen) })
          : t('import.doneBody', {
              seen: String(done.seen),
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
