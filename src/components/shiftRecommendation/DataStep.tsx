import { AlertTriangle } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, NativeSelect, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { YearMonth } from '../../utils/shiftRecommendation';
import { MONTH_NAME_KEYS, monthKey, type HistoryMonthOption } from '../../utils/shiftRecommendationScreens';

export type ImportsState = 'loading' | 'failed' | 'ready';
/** What went wrong on "Weiter": the rides could not be read, or no profile could be built from them. */
export type DataStepError = 'trips' | 'profile' | null;

interface Props {
  importsState: ImportsState;
  options: readonly HistoryMonthOption[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  targets: readonly YearMonth[];
  target: string;
  onTarget: (key: string) => void;
  busy: boolean;
  error: DataStepError;
  onRetry: () => void;
  onNext: () => void;
}

/** Step 1: which Fahrtenbuch months to learn from, and which month to plan. */
export function DataStep(props: Props) {
  const { t } = useTranslation();
  const { importsState, options, selected, targets, busy, error } = props;
  const monthLabel = (ym: YearMonth) => `${t(MONTH_NAME_KEYS[ym.month - 1])} ${ym.year}`;
  const canContinue = importsState === 'ready' && selected.size > 0 && !busy && props.target !== '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.data.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5">
        {importsState === 'loading' ? <p className="text-sm text-fg-muted">{t('shiftrec.data.loading')}</p> : null}
        {importsState === 'failed' ? (
          <Alert tone="critical" title={t('shiftrec.data.importsFailedTitle')}>
            <p>{t('shiftrec.data.importsFailed')}</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={props.onRetry}>
              {t('shiftrec.retry')}
            </Button>
          </Alert>
        ) : null}
        {importsState === 'ready' && options.length === 0 ? (
          <EmptyState icon={AlertTriangle} title={t('shiftrec.data.noImports')} />
        ) : null}
        {importsState === 'ready' && options.length > 0 ? (
          <>
            <fieldset className="grid grid-cols-1 gap-2">
              <legend className="text-sm font-semibold text-fg">{t('shiftrec.data.historyLegend')}</legend>
              <p className="text-[13px] text-fg-subtle">{t('shiftrec.data.historyHint')}</p>
              {options.map(option => (
                <label key={option.key} className="flex cursor-pointer items-start gap-3 rounded-surface border border-line bg-raised p-3">
                  <input
                    type="checkbox"
                    checked={selected.has(option.key)}
                    onChange={() => props.onToggle(option.key)}
                    className="mt-0.5 size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">
                      {monthLabel(option)}
                    </span>
                    <span className="block break-words text-[13px] text-fg-muted tabular-nums">
                      {t('shiftrec.data.monthRow', { count: formatNumber(option.rowCount), file: option.fileName })}
                    </span>
                    {option.otherImports > 0 ? (
                      <span className="block text-[13px] text-caution">
                        {t('shiftrec.data.otherImports', { count: option.otherImports })}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
              {selected.size === 0 ? <p className="text-[13px] text-critical">{t('shiftrec.data.noneSelected')}</p> : null}
            </fieldset>
            <Field label={t('shiftrec.data.targetLabel')} hint={t('shiftrec.data.targetHint')} className="sm:max-w-xs">
              <NativeSelect value={props.target} onChange={e => props.onTarget(e.target.value)}>
                {targets.map(ym => (
                  <option key={monthKey(ym)} value={monthKey(ym)}>
                    {monthLabel(ym)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </>
        ) : null}
        {error ? <StepError error={error} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={props.onNext} disabled={!canContinue} loading={busy}>
            {busy ? t('shiftrec.data.loadingTrips') : t('shiftrec.continue')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const ERROR_KEYS: Record<'trips' | 'profile', { title: TranslationKey; body: TranslationKey }> = {
  trips: { title: 'shiftrec.data.tripsFailedTitle', body: 'shiftrec.data.tripsFailed' },
  profile: { title: 'shiftrec.data.profileFailedTitle', body: 'shiftrec.data.profileFailed' },
};

function StepError({ error }: { error: 'trips' | 'profile' }) {
  const { t } = useTranslation();
  return (
    <Alert tone="critical" title={t(ERROR_KEYS[error].title)}>
      {t(ERROR_KEYS[error].body)}
    </Alert>
  );
}
