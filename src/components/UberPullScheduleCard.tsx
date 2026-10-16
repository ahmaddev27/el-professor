import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Save, Truck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { germanDay } from '../../supabase/functions/_shared/abrechnung-schedule-core';
import { isFailure, isGap } from '../../supabase/functions/_shared/uber-pull-core';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, formatEuroCents } from './ui';

/**
 * The daily Uber pull (owner request 15.10.2026, which reverses his decision of
 * 13.10.2026 that nothing would run by itself).
 *
 * Two tables: `uber_pull_schedules` (one row per company, written by the
 * company's administrator, edited here) and `uber_pull_runs` (one row per
 * operating day the job claimed, written by the job only, read here). The
 * pulling itself is the edge function's job on the host's existing cron tick;
 * this card edits the row and shows what became of each day.
 *
 * A failed day is not retried by the schedule, so the card says so and where to
 * pull it by hand. A claim that never got an outcome is a failure too: it is a
 * crash, and showing it as "pending" would hide it.
 */

interface ScheduleForm {
  enabled: boolean;
  /** `HH:MM`, the value an `<input type="time">` holds. */
  time: string;
  replaceCorrections: boolean;
}

const DEFAULTS: ScheduleForm = { enabled: false, time: '06:00', replaceCorrections: false };

interface RunRow {
  id: string;
  day_key: string;
  pass: 'first' | 'recheck';
  outcome: string | null;
  detail: string | null;
  rows_written: number;
  rows_deleted: number;
  driver_count: number;
  /** Earners Reidey could not place that day: no earnings arrived for them. */
  unmatched: Array<{ name: string; trips: number | null }>;
  /** Figures below zero that were not imported: income.amount cannot hold them. */
  skipped: Array<{ name: string; type: 'umsatz' | 'aktionen' | 'trinkgeld' | 'bargeld'; cents: number }>;
}

/** How many of the latest claims the card lists. */
const RUNS_SHOWN = 14;

const checkboxClass = 'mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed';

/** Domain vocabulary: the four income types stay German in both languages. */
const FIGURE_WORDS = { umsatz: 'Umsatz', aktionen: 'Aktionen', trinkgeld: 'Trinkgeld', bargeld: 'Bargeld' } as const;

const OUTCOME_KEYS = {
  imported: 'settings.uberPull.outcome.imported',
  imported_with_gap: 'settings.uberPull.outcome.imported_with_gap',
  nothing_to_import: 'settings.uberPull.outcome.nothing_to_import',
  blocked_unlinked: 'settings.uberPull.outcome.blocked_unlinked',
  blocked_unmatched: 'settings.uberPull.outcome.blocked_unmatched',
  already_imported: 'settings.uberPull.outcome.already_imported',
  not_connected: 'settings.uberPull.outcome.not_connected',
  seal_unreadable: 'settings.uberPull.outcome.seal_unreadable',
  token_rejected: 'settings.uberPull.outcome.token_rejected',
  partner_refused: 'settings.uberPull.outcome.partner_refused',
  partner_unavailable: 'settings.uberPull.outcome.partner_unavailable',
  partner_malformed: 'settings.uberPull.outcome.partner_malformed',
  company_blocked: 'settings.uberPull.outcome.company_blocked',
  refused: 'settings.uberPull.outcome.refused',
  failed: 'settings.uberPull.outcome.failed',
} as const;

const UberPullScheduleCard: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [form, setForm] = useState<ScheduleForm>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsFailed, setRunsFailed] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    setRunsFailed(false);
    const schedule = await supabase
      .from('uber_pull_schedules')
      .select('enabled, run_time, replace_corrections')
      .eq('company_id', companyId)
      .maybeSingle();
    if (schedule.error) {
      setLoadFailed(true);
    } else if (schedule.data) {
      setForm({
        enabled: schedule.data.enabled,
        time: String(schedule.data.run_time).slice(0, 5),
        replaceCorrections: schedule.data.replace_corrections,
      });
    } else {
      setForm(DEFAULTS);
    }

    const history = await supabase
      .from('uber_pull_runs')
      .select('id, day_key, pass, outcome, detail, rows_written, rows_deleted, driver_count, unmatched, skipped')
      .eq('company_id', companyId)
      .order('day_key', { ascending: false })
      .order('claimed_at', { ascending: false })
      .limit(RUNS_SHOWN);
    if (history.error) {
      setRuns([]);
      setRunsFailed(true);
    } else {
      setRuns((history.data ?? []) as RunRow[]);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId) return;
    setSaving(true);
    const { error } = await supabase
      .from('uber_pull_schedules')
      .upsert({
        company_id: companyId,
        enabled: form.enabled,
        run_time: form.time,
        replace_corrections: form.replaceCorrections,
      }, { onConflict: 'company_id' });
    setSaving(false);
    if (error) {
      showError(t('settings.uberPull.saveFailed'), t('settings.uberPull.saveFailedBody'));
      return;
    }
    success(t('settings.uberPull.saved'), t('settings.uberPull.savedBody'));
    await load();
  };

  const failures = runs.filter((run) => isFailure(run.outcome));

  const body = loadFailed ? (
    <Alert tone="critical" title={t('settings.uberPull.loadFailed')}>
      <Button type="button" variant="secondary" onClick={load}>{t('settings.uberPull.retry')}</Button>
    </Alert>
  ) : (
    <div className="grid grid-cols-1 gap-4">
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-4">
        <p className="text-sm text-fg-muted">{t('settings.uberPull.description')}</p>

        <fieldset disabled={readOnly || loading || saving} className="m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0">
          <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>
              <span className="block font-medium">{t('settings.uberPull.enabled.label')}</span>
              <span className="block text-fg-subtle">{t('settings.uberPull.enabled.hint')}</span>
            </span>
          </label>

          <Field label={t('settings.uberPull.time')} hint={t('settings.uberPull.timeHint')} id="uber-pull-time">
            <Input
              id="uber-pull-time"
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={form.replaceCorrections}
              onChange={(e) => setForm({ ...form, replaceCorrections: e.target.checked })}
            />
            <span>
              <span className="block font-medium">{t('settings.uberPull.replace.label')}</span>
              <span className="block text-fg-subtle">{t('settings.uberPull.replace.hint')}</span>
            </span>
          </label>

          <p className="text-xs text-fg-subtle">{t('settings.uberPull.changeNote')}</p>

          <div className="flex justify-end">
            <Button type="submit" disabled={readOnly || loading || saving || !form.time}>
              <Save aria-hidden />
              <span>{t('common.save')}</span>
            </Button>
          </div>
        </fieldset>
      </form>

      <RunHistory runs={runs} failures={failures.length} loading={loading} failed={runsFailed} onRetry={load} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="justify-start gap-2">
        <Truck aria-hidden className="size-5 text-brand-text" />
        <CardTitle>{t('settings.uberPull.title')}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};

interface RunHistoryProps {
  runs: RunRow[];
  failures: number;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}

/** What became of each pulled day. An empty list and a failed read are different claims. */
const RunHistory: React.FC<RunHistoryProps> = ({ runs, failures, loading, failed, onRetry }) => {
  const { t, tPlural } = useTranslation();
  if (loading) return null;
  const gaps = runs.filter((run) => isGap(run.outcome)).length;

  let content: React.ReactNode;
  if (failed) {
    content = (
      <Alert tone="critical" title={t('settings.uberPull.runs.loadFailed')}>
        <Button type="button" variant="secondary" onClick={onRetry}>{t('settings.uberPull.retry')}</Button>
      </Alert>
    );
  } else if (runs.length === 0) {
    content = <p className="text-fg-subtle">{t('settings.uberPull.runs.empty')}</p>;
  } else {
    content = (
      <>
        {failures > 0 && (
          <Alert
            tone="critical"
            title={tPlural({
              one: 'settings.uberPull.runs.failedOne',
              other: 'settings.uberPull.runs.failedOther',
            }, failures)}
          >
            {t('settings.uberPull.runs.failedBody')}
          </Alert>
        )}
        {gaps > 0 && (
          <Alert
            tone="caution"
            title={tPlural({
              one: 'settings.uberPull.runs.gapOne',
              other: 'settings.uberPull.runs.gapOther',
            }, gaps)}
          >
            {t('settings.uberPull.runs.gapBody')}
          </Alert>
        )}
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0">
          {runs.map((run) => <RunLine key={run.id} run={run} />)}
        </ul>
      </>
    );
  }

  return (
    <section aria-live="polite" className="grid grid-cols-1 gap-2 rounded-md border border-border bg-canvas p-4 text-sm text-fg">
      <h3 className="font-medium">{t('settings.uberPull.runs.title')}</h3>
      {content}
    </section>
  );
};

const RunLine: React.FC<{ run: RunRow }> = ({ run }) => {
  const { t } = useTranslation();
  const failure = isFailure(run.outcome);
  const gap = isGap(run.outcome);
  const outcomeKey = run.outcome && run.outcome in OUTCOME_KEYS
    ? OUTCOME_KEYS[run.outcome as keyof typeof OUTCOME_KEYS]
    : 'settings.uberPull.outcome.open';
  const counts = run.outcome === 'imported' || gap
    ? t('settings.uberPull.runs.counts', { rows: run.rows_written, drivers: run.driver_count })
    : null;

  return (
    <li className="grid grid-cols-1 gap-1 sm:flex sm:items-center sm:gap-3">
      <span className="tabular-nums font-medium">{germanDay(run.day_key)}</span>
      {run.pass === 'recheck' && <Badge tone="neutral">{t('settings.uberPull.runs.recheck')}</Badge>}
      <Badge tone={failure ? 'critical' : gap ? 'caution' : 'positive'}>
        {failure || gap ? <AlertTriangle aria-hidden /> : <CheckCircle2 aria-hidden />}
        {t(outcomeKey)}
      </Badge>
      {counts && <span className="text-fg-subtle">{counts}</span>}
      {run.rows_deleted > 0 && (
        <span className="text-fg-subtle">{t('settings.uberPull.runs.replaced', { count: run.rows_deleted })}</span>
      )}
      {gap && run.unmatched.length > 0 && (
        <span className="min-w-0 break-words text-fg">
          {t('settings.uberPull.runs.gapNames', {
            names: run.unmatched.map((u) => (u.trips === null ? u.name : `${u.name} (${u.trips})`)).join(', '),
          })}
        </span>
      )}
      {gap && run.skipped.length > 0 && (
        <span className="min-w-0 break-words text-fg">
          {t('settings.uberPull.runs.skippedNames', {
            items: run.skipped.map((f) => `${f.name}: ${FIGURE_WORDS[f.type]} ${formatEuroCents(f.cents)}`).join('; '),
          })}
        </span>
      )}
      {failure && run.detail && <span className="min-w-0 break-words text-fg-subtle">{run.detail}</span>}
    </li>
  );
};

export default UberPullScheduleCard;
