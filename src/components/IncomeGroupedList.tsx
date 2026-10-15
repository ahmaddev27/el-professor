import { useMemo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  groupIncome,
  type DayGroup,
  type GroupableIncome,
  type IncomeTotals,
  type MonthGroup,
  type WeekGroup,
} from '../utils/incomeGrouping';
import { Alert, formatDate, formatEuroCents } from './ui';

interface Props {
  rows: readonly GroupableIncome[];
}

const MONTH_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

/** 'Di.' / 'Tue', display only, from the ISO date so no time zone moves it. */
function weekdayShort(iso: string, language: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'de-DE', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y!, m! - 1, d!)));
}

const money = (cents: number) => <span className="tabular-nums">{formatEuroCents(cents)}</span>;

/**
 * Month → week → day → driver, every level but the driver folding. The figures
 * are the grouping's own cents, never recomputed here, so a level cannot
 * disagree with the one below it. The caller withholds this whole list when the
 * load failed; a group that could not be read says so instead of a total.
 */
export function IncomeGroupedList({ rows }: Props) {
  const { t, tPlural, language } = useTranslation();
  const grouped = useMemo(() => {
    try {
      return groupIncome(rows);
    } catch {
      return null;
    }
  }, [rows]);

  if (grouped === null) {
    return <Alert tone="critical" title={t('inc.group.unreadableTitle')}>{t('inc.group.unreadable')}</Alert>;
  }

  const figures = (totals: IncomeTotals) => (
    <span className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-0.5 text-[13px] text-fg-muted">
      <span className="hidden md:inline">{t('inc.nettoFahrpreis')} {money(totals.umsatzCents)}</span>
      <span className="hidden md:inline">{t('inc.typeAktionen')} {money(totals.aktionenCents)}</span>
      <span className="hidden lg:inline">{t('inc.typeTrinkgeld')} {money(totals.trinkgeldCents)}</span>
      <span className="hidden lg:inline">{t('inc.typeBargeld')} {money(totals.bargeldCents)}</span>
      <span className="text-sm font-semibold text-fg">{t('inc.sum')} {money(totals.sumCents)}</span>
    </span>
  );

  const fold = (title: ReactNode, totals: IncomeTotals, children: ReactNode, open: boolean, level: 0 | 1 | 2) => (
    <details open={open} className="group rounded-control border border-border bg-raised">
      <summary
        className={
          'flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 '
          + '[&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11 '
          + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus'
        }
      >
        <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90" />
        <span className={level === 0 ? 'font-semibold text-fg' : level === 1 ? 'font-medium text-fg' : 'text-sm font-medium text-fg'}>
          {title}
        </span>
        <span className="text-xs text-fg-subtle">
          {tPlural({ one: 'inc.group.entries.one', other: 'inc.group.entries.other' }, totals.rowCount)}
        </span>
        <span className="ml-auto">{figures(totals)}</span>
      </summary>
      <div className="grid grid-cols-1 gap-2 border-t border-border p-2">{children}</div>
    </details>
  );

  const dayView = (day: DayGroup) => fold(
    day.date === null ? (
      <span title={t('inc.group.weekLevelHint')}>{t('inc.group.weekLevel')}</span>
    ) : (
      <span className="tabular-nums">{`${weekdayShort(day.date, language)} ${formatDate(day.date)}`}</span>
    ),
    day.totals,
    <ul className="grid grid-cols-1 gap-1">
      {day.drivers.map(driver => (
        <li key={driver.driverName} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
          <span className="text-sm text-fg">{driver.driverName}</span>
          <span className="ml-auto">{figures(driver.totals)}</span>
        </li>
      ))}
    </ul>,
    false,
    2,
  );

  const weekView = (week: WeekGroup, open: boolean) => fold(
    `${t('inc.weekLabel', { week: week.weekNumber })} · ${formatDate(week.monday)}`,
    week.totals,
    week.days.map(day => <div key={`${week.monday}-${day.date ?? 'week'}`}>{dayView(day)}</div>),
    open,
    1,
  );

  const monthView = (month: MonthGroup, open: boolean) => fold(
    `${t(MONTH_KEYS[month.month - 1]!)} ${month.year}`,
    month.totals,
    month.weeks.map((week, i) => <div key={week.monday}>{weekView(week, open && i === 0)}</div>),
    open,
    0,
  );

  return (
    <div className="grid grid-cols-1 gap-3">
      {grouped.map((month, i) => <div key={`${month.year}-${month.month}`}>{monthView(month, i === 0)}</div>)}
    </div>
  );
}

export default IncomeGroupedList;
