import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { BudgetResult } from '../../utils/tripAnalysis/types';
import {
  formatBerlinDateTime,
  recomputeLog,
  type BudgetRow,
  type BudgetState,
  type CompanyDriver,
  type DriverTableRow,
} from '../../lib/tripAnalysisView';
import { formatHours, formatStoredEuro } from '../../lib/tripAnalysisFormat';
import { BUDGET_PROBLEM_KEYS } from '../../lib/tripAnalysisLabels';
import { BudgetStateBadge } from './TripAnalysisBadges';

/** Hours as a German decimal, blank for "not set", or undefined when the text is neither. */
export function parseReserveHours(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(trimmed)) return undefined;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 744 ? value : undefined;
}

/** The stored reserve as the input shows it: a German decimal, or empty for "not set". */
export function reserveText(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(n).replace('.', ',');
}

interface Props {
  row: DriverTableRow;
  driver: CompanyDriver | undefined;
  budgetRow: BudgetRow | undefined;
  budget: BudgetResult | null;
  state: BudgetState;
  /** An administrator of this company, outside a read-only context. */
  canEdit: boolean;
  onSaveReserve: (hours: number | null) => Promise<boolean>;
  onConfirm: () => Promise<boolean>;
}

/**
 * One driver's month budget: the figures the hours are derived from, the
 * reserve the owner holds back, and the explicit confirmation that freezes the
 * pay figures onto the month.
 *
 * The snapshot is the database's (`app_private.driver_month_budget_guard`), so
 * this card only asks for it — it never sends salary or rate, and a value it
 * sends for `confirmed_at` is discarded.
 */
export function TripAnalysisBudgetCard({ row, driver, budgetRow, budget, state, canEdit, onSaveReserve, onConfirm }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => reserveText(budgetRow?.reserved_hours));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // A different driver, month or stored value starts the field over.
  useEffect(() => {
    setText(reserveText(budgetRow?.reserved_hours));
    setSubmitted(false);
  }, [budgetRow?.id, budgetRow?.reserved_hours, row.driverId]);

  const hours = parseReserveHours(text);
  const log = recomputeLog(budgetRow);
  const dash = '—';
  const euro = (value: number | string | null) => formatStoredEuro(value) ?? dash;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (hours === undefined) return;
    setSaving(true);
    await onSaveReserve(hours);
    setSaving(false);
  };

  const confirm = async () => {
    setConfirming(true);
    await onConfirm();
    setConfirming(false);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wallet aria-hidden className="size-4 text-fg-subtle" />
          <CardTitle>{t('ta.budget.title')}</CardTitle>
        </div>
        <BudgetStateBadge state={state} />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {!row.linked ? (
          <Alert tone="caution">{t('ta.budget.noDriver')}</Alert>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <div className="grid gap-0.5">
                <dt className="text-[13px] font-medium text-fg-muted">{t('ta.col.hoursRange')}</dt>
                <dd className="text-[15px] font-semibold tabular-nums text-fg">
                  {row.hoursMin === null || row.hoursMax === null
                    ? t('ta.notComputable')
                    : `${formatHours(row.hoursMin)} – ${formatHours(row.hoursMax)}`}
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-[13px] font-medium text-fg-muted">{t('ta.col.reserve')}</dt>
                <dd className="text-[15px] font-semibold tabular-nums text-fg">
                  {row.reservedHours === null ? t('ta.notSetShort') : formatHours(row.reservedHours)}
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-[13px] font-medium text-fg-muted">{t('ta.col.cap')}</dt>
                <dd className="text-[15px] font-semibold tabular-nums text-fg">
                  {row.capHours === null ? t('ta.notComputable') : formatHours(row.capHours)}
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-[13px] font-medium text-fg-muted">{t('ta.col.activity')}</dt>
                <dd className="text-[15px] font-semibold tabular-nums text-fg">{formatHours(row.activityHours)}</dd>
              </div>
            </dl>

            <p className="text-xs text-fg-muted">
              {t('ta.budget.used', { min: euro(row.salaryMin), max: euro(row.salaryMax), rate: euro(row.hourlyRate) })}
              {budgetRow?.confirmed_at ? ` · ${t('ta.budget.confirmedAt', { date: formatBerlinDateTime(Date.parse(budgetRow.confirmed_at)) })}` : ''}
            </p>
            {state === 'not_confirmed' ? <p className="text-xs text-fg-subtle">{t('ta.budget.unconfirmedNote')}</p> : null}

            {budget && budget.problems.length > 0 ? (
              <Alert tone="caution">
                {t('ta.budget.problems', { list: budget.problems.map(problem => t(BUDGET_PROBLEM_KEYS[problem])).join(', ') })}
              </Alert>
            ) : null}
            {budget?.capBelowHoursMin ? <Alert tone="caution">{t('ta.budget.capBelowMin')}</Alert> : null}

            {state === 'inputs_changed' && driver ? (
              <Alert
                tone="caution"
                icon={RefreshCw}
                action={
                  canEdit ? (
                    <Button variant="secondary" size="sm" loading={confirming} onClick={confirm}>
                      {t('ta.budget.recompute')}
                    </Button>
                  ) : undefined
                }
              >
                <span className="block">{t('ta.budget.recomputeHint')}</span>
                <span className="mt-1 block">
                  {t('ta.budget.current', {
                    min: euro(driver.planning_min_salary),
                    max: euro(driver.planning_max_salary),
                    rate: euro(driver.planning_hourly_rate),
                  })}
                </span>
              </Alert>
            ) : null}

            {canEdit ? (
              <form className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,14rem)_auto] sm:items-end" onSubmit={submit} noValidate>
                <Field
                  label={t('ta.budget.reserve')}
                  hint={t('ta.budget.reserveHint')}
                  error={submitted && hours === undefined ? t('ta.budget.reserveInvalid') : undefined}
                >
                  <Input inputMode="decimal" value={text} onChange={event => setText(event.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-2 pb-1">
                  <Button type="submit" variant="secondary" loading={saving}>
                    {t('ta.budget.saveReserve')}
                  </Button>
                  {state === 'not_confirmed' ? (
                    <Button loading={confirming} onClick={confirm} title={t('ta.budget.confirmHint')}>
                      <ShieldCheck aria-hidden />
                      {t('ta.budget.confirm')}
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : null}

            {log.length > 0 ? (
              <div className="grid gap-1">
                <h3 className="text-[13px] font-medium text-fg-muted">{t('ta.budget.log')}</h3>
                <ul className="grid gap-0.5 text-xs text-fg-subtle">
                  {log.map((entry, index) => (
                    <li key={`${entry.kind}-${entry.at}-${index}`}>
                      {entry.kind === 'recompute'
                        ? t('ta.budget.logRecompute', { date: formatBerlinDateTime(Date.parse(entry.at)) })
                        : t('ta.budget.logReserve', { date: formatBerlinDateTime(Date.parse(entry.at)) })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
