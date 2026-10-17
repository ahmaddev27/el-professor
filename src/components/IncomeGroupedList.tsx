import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  driversOfMonth,
  driversOfWeek,
  flattenDays,
  flattenWeeks,
  groupIncome,
  weekEndOf,
  type DriverGroup,
  type GroupableIncome,
  type IncomeTotals,
} from '../utils/incomeGrouping';
import { Alert, formatDate, formatEuroCents } from './ui';

export type IncomeLevel = 'day' | 'week' | 'month';

const LEVEL_KEY = {
  day: 'inc.group.viewDay',
  week: 'inc.group.viewWeek',
  month: 'inc.group.viewMonth',
} as const satisfies Record<IncomeLevel, TranslationKey>;

interface Props {
  rows: readonly GroupableIncome[];
  level: IncomeLevel;
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

/** One list entry: what the row is called, and the drivers behind it. */
interface Entry {
  key: string;
  title: ReactNode;
  subtitle: ReactNode;
  totals: IncomeTotals;
  drivers: DriverGroup[];
}

// Summe is always a column; the four parts are columns from lg up and sit
// under the name below it, so a phone never scrolls sideways.
const CELL = 'px-3 py-2 text-right align-middle tabular-nums whitespace-nowrap';
const PART_CELL = `${CELL} hidden text-fg-muted lg:table-cell`;

/**
 * The Umsätze list at one level: day, week or month. The figures are the
 * grouping's own cents (`groupIncome`, and `sumTotals` for the driver rows of
 * a week or month), never added up here, so a level cannot disagree with the
 * one below it. The caller withholds this whole list when the load failed; a
 * group that could not be read says so instead of a total.
 */
export function IncomeGroupedList({ rows, level }: Props) {
  const { t, tPlural, language } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const grouped = useMemo(() => {
    try {
      return groupIncome(rows);
    } catch {
      return null;
    }
  }, [rows]);

  const entries = useMemo<Entry[]>(() => {
    if (grouped === null) return [];
    const weekTitle = (week: { weekNumber: number }) => t('inc.weekLabel', { week: week.weekNumber });
    const weekRange = (monday: string) => `${formatDate(monday)} – ${formatDate(weekEndOf(monday))}`;
    if (level === 'month') {
      return grouped.map(month => ({
        key: `m-${month.year}-${month.month}`,
        title: `${t(MONTH_KEYS[month.month - 1]!)} ${month.year}`,
        subtitle: null,
        totals: month.totals,
        drivers: driversOfMonth(month),
      }));
    }
    if (level === 'week') {
      return flattenWeeks(grouped).map(week => ({
        key: `w-${week.monday}`,
        title: weekTitle(week),
        subtitle: <span className="tabular-nums">{weekRange(week.monday)}</span>,
        totals: week.totals,
        drivers: driversOfWeek(week),
      }));
    }
    return flattenDays(grouped).map(({ day, week }) => ({
      key: `d-${week.monday}-${day.date ?? 'week'}`,
      title: day.date === null ? (
        <span title={t('inc.group.weekLevelHint')}>{t('inc.group.weekLevel')}</span>
      ) : (
        <span className="tabular-nums">{`${weekdayShort(day.date, language)} ${formatDate(day.date)}`}</span>
      ),
      subtitle: day.date === null
        ? <span className="tabular-nums">{`${weekTitle(week)} · ${weekRange(week.monday)}`}</span>
        : weekTitle(week),
      totals: day.totals,
      drivers: day.drivers,
    }));
  }, [grouped, level, t, language]);

  if (grouped === null) {
    return <Alert tone="critical" title={t('inc.group.unreadableTitle')}>{t('inc.group.unreadable')}</Alert>;
  }

  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const parts = (totals: IncomeTotals) => (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted lg:hidden">
      <span>{t('inc.nettoFahrpreis')} {money(totals.umsatzCents)}</span>
      <span>{t('inc.typeAktionen')} {money(totals.aktionenCents)}</span>
      <span>{t('inc.typeTrinkgeld')} {money(totals.trinkgeldCents)}</span>
      <span>{t('inc.typeBargeld')} {money(totals.bargeldCents)}</span>
    </span>
  );

  const figureCells = (totals: IncomeTotals, strong: boolean) => (
    <>
      <td className={PART_CELL}>{formatEuroCents(totals.umsatzCents)}</td>
      <td className={PART_CELL}>{formatEuroCents(totals.aktionenCents)}</td>
      <td className={PART_CELL}>{formatEuroCents(totals.trinkgeldCents)}</td>
      <td className={PART_CELL}>{formatEuroCents(totals.bargeldCents)}</td>
      <td className={`${CELL} ${strong ? 'text-[15px] font-semibold text-fg' : 'text-fg'}`}>
        {formatEuroCents(totals.sumCents)}
      </td>
    </>
  );

  const entryRows = (entry: Entry) => {
    const isOpen = open.has(entry.key);
    const panelId = `inc-${entry.key}`;
    return (
      <tbody key={entry.key} className="border-t border-border">
        <tr className={isOpen ? 'bg-sunken' : undefined}>
          <th scope="row" className="p-0 text-left font-normal">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggle(entry.key)}
              className={
                'flex min-h-12 w-full items-start gap-2 px-3 py-2 text-left [@media(pointer:coarse)]:min-h-14 '
                + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus'
              }
            >
              <ChevronRight
                aria-hidden
                className={`mt-1 size-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-fg">{entry.title}</span>
                <span className="text-xs text-fg-muted">
                  {entry.subtitle}
                  {entry.subtitle ? ' · ' : ''}
                  {tPlural({ one: 'inc.group.entries.one', other: 'inc.group.entries.other' }, entry.totals.rowCount)}
                </span>
                {isOpen && parts(entry.totals)}
              </span>
            </button>
          </th>
          {figureCells(entry.totals, true)}
        </tr>
        {isOpen && entry.drivers.map((driver, i) => (
          <tr key={driver.driverName} id={i === 0 ? panelId : undefined} className="bg-sunken">
            <td className="py-2 pl-9 pr-3 align-top">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-fg">{driver.driverName}</span>
                {parts(driver.totals)}
              </span>
            </td>
            {figureCells(driver.totals, false)}
          </tr>
        ))}
      </tbody>
    );
  };

  return (
    <div className="overflow-hidden rounded-control border border-border bg-raised">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('inc.group.viewLabel')}</caption>
        <thead>
          <tr className="text-xs text-fg-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">{t(LEVEL_KEY[level])}</th>
            <th scope="col" className={`${PART_CELL} font-medium`}>{t('inc.nettoFahrpreis')}</th>
            <th scope="col" className={`${PART_CELL} font-medium`}>{t('inc.typeAktionen')}</th>
            <th scope="col" className={`${PART_CELL} font-medium`}>{t('inc.typeTrinkgeld')}</th>
            <th scope="col" className={`${PART_CELL} font-medium`}>{t('inc.typeBargeld')}</th>
            <th scope="col" className={`${CELL} font-medium`}>{t('inc.sum')}</th>
          </tr>
        </thead>
        {entries.map(entryRows)}
      </table>
    </div>
  );
}

export default IncomeGroupedList;
