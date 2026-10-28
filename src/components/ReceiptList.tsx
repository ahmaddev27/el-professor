import React, { useState, useMemo } from 'react';
import { ArrowDown, ArrowUp, Calendar, ChevronsUpDown, Download, FileDown, Filter, Pencil, Receipt as ReceiptIcon, Search, Trash2, X } from 'lucide-react';
import { Receipt, Driver } from '../types/receipt';
import { format, getMonth, getYear } from 'date-fns';
import { getBusinessMonthRange, getBusinessWeeksForMonth, WeekOfMonth } from '../utils/weekCalculations';
import type { ReceiptExportFilters } from '../utils/belegeExport';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  clockTime,
  receiptAuthor,
  receiptFuelFigures,
  receiptFuelParts,
  receiptSourceParts,
  receiptStationCell,
  textOrNull,
} from '../utils/receiptDisplay';
import {
  sortReceipts,
  type MeasuredSortField,
  type ReceiptSortDirection,
  type ReceiptSortField,
} from '../utils/receiptSort';
import {
  Badge,
  Button,
  Card,
  CardContent,
  cn,
  DataTable,
  EmptyState,
  Field,
  formatDate,
  formatEuro,
  Input,
  KpiCard,
  NativeSelect,
  Tooltip,
  type DataTableColumn,
} from './ui';

interface ReceiptListProps {
  receipts: Receipt[];
  drivers: Driver[];
  onEdit: (receipt: Receipt) => void;
  onDelete: (id: string) => void;
  /**
   * Write the Excel file for the rows given, described by the filter that
   * produced them.
   *
   * This replaces `onExportFiltered`, which asked the parent to *remember* the
   * filtered rows so that a button in the page header could export them later.
   * Nothing ever called it, so the header's button exported the whole company
   * while the PDF button beside the filters exported the filtered list. The
   * export now takes its rows as an argument, like the PDF already did, so
   * there is no copy to fall out of step.
   */
  onExportExcel: (rows: Receipt[], filters: ReceiptExportFilters) => void;
  onDownloadPdf: (filteredReceipts: Receipt[], filterInfo: PdfFilterInfo) => void;
  canEdit: (receipt: Receipt) => boolean;
  canDelete: (receipt: Receipt) => boolean;
  userDisplayNames?: Map<string, string>;
  /**
   * The parent's read failed, so no file may be written: an empty list and a
   * total of 0,00 € are claims (CLAUDE.md, "A figure whose load failed is not
   * shown"). The parent owns the read, so it owns this.
   */
  exportDisabled?: boolean;
}

export interface PdfFilterInfo {
  selectedMonth: string;         // 'yyyy-MM' or ''
  selectedWeek: number | null;   // week number or null
  weekRange: { start: Date; end: Date } | null;
  driver: string;
  companyName: string;
}

type SortField = ReceiptSortField;
type SortDirection = ReceiptSortDirection;

// Values hold TranslationKeys: this map is module-level and t() is a hook value,
// so the table header resolves it at the call site.
//
// The five measured columns (owner, 27.10.2026) are here beside the four text
// ones so that "which columns offer the control" is one list rather than a grep
// of the column array. Their labels already existed in both dictionaries — they
// were the plain headers of those columns — so this slice adds no key.
const SORTABLE_COLUMN_LABELS: Record<
  'receiptNumber' | 'date' | 'driverName' | 'description' | MeasuredSortField,
  TranslationKey
> = {
  receiptNumber: 'rec.receiptNumber',
  date:          'common.date',
  driverName:    'common.driver',
  description:   'rec.bookingText',
  receiptTime:   'common.time',
  litres:        'rec.litres',
  pricePerLitre: 'rec.pricePerLitre',
  odometerKm:    'rec.odometer',
  rangeKm:       'rec.rangeLeft',
};

interface Filters {
  selectedMonth: string;    // 'yyyy-MM'
  selectedWeek: number | 0; // 0 = all weeks
  driver: string;
  customDateFrom: string;
  customDateTo: string;
}

const ReceiptList: React.FC<ReceiptListProps> = ({
  receipts,
  drivers,
  onEdit,
  onDelete,
  onExportExcel,
  onDownloadPdf,
  canEdit,
  canDelete,
  userDisplayNames = new Map(),
  exportDisabled = false,
}) => {
  const { t, tPlural } = useTranslation();

  // A Beleg from the driver app names the driver (owner, 13.10.2026): there is
  // no user behind it to resolve.
  const resolveCreator = (receipt: Receipt): string =>
    receiptAuthor(receipt, userDisplayNames, t('rec.unknownUser'));
  const now = new Date();
  const currentMonthStr = format(now, 'yyyy-MM');
  const currentMonth0 = getMonth(now);
  const currentYear = getYear(now);
  const businessMonthRange = getBusinessMonthRange(currentMonth0, currentYear);

  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    selectedMonth: currentMonthStr,
    selectedWeek: 0,
    driver: '',
    customDateFrom: '',
    customDateTo: ''
  });

  // Weeks for the currently selected month
  const weeksForMonth = useMemo((): WeekOfMonth[] => {
    if (!filters.selectedMonth) return [];
    const d = new Date(filters.selectedMonth + '-01');
    return getBusinessWeeksForMonth(getMonth(d), getYear(d));
  }, [filters.selectedMonth]);

  // Resolved date range from selected month/week (or custom override)
  const activeDateRange = useMemo((): { start: Date; end: Date } | null => {
    if (filters.customDateFrom && filters.customDateTo) {
      return {
        start: new Date(filters.customDateFrom),
        end: new Date(filters.customDateTo)
      };
    }
    if (!filters.selectedMonth) return null;

    const d = new Date(filters.selectedMonth + '-01');
    const month0 = getMonth(d);
    const year = getYear(d);

    if (filters.selectedWeek > 0) {
      const week = weeksForMonth.find(w => w.weekNumber === filters.selectedWeek);
      if (week) return { start: week.firstDay, end: week.lastDay };
    }

    return getBusinessMonthRange(month0, year);
  }, [filters.selectedMonth, filters.selectedWeek, filters.customDateFrom, filters.customDateTo, weeksForMonth]);

  /**
   * The same range as `activeDateRange`, as two `YYYY-MM-DD` keys, because the
   * comparison has to be made on calendar days and not on instants.
   *
   * The two paths above build Dates that mean different things, and that is what
   * dropped receipts. A custom range parses `YYYY-MM-DD` with `new Date(...)`,
   * which ECMAScript reads as **UTC** midnight; a week or business month comes
   * from `new Date(year, month, day)`, which is **local** midnight. A receipt's
   * `date` is a bare `YYYY-MM-DD` too, so it was a UTC midnight — later than a
   * local-midnight end bound in any zone east of UTC. In Berlin that is one or
   * two hours, and it was enough: **every receipt dated on the last day of the
   * selected week or business month failed `<= end`** and vanished from the list,
   * from the total, from the Excel export and from the summary PDF the
   * Steuerberater receives. Measured on production 27.09.2026: 93 of 915 receipts
   * fall on a Sunday — a business week's last day — and 31 on a month's last day.
   *
   * Each bound is read with the getters that match how it was built, so no
   * timezone is assumed: the custom bounds are already the strings the user
   * picked, and the week and month bounds are read with local getters.
   */
  const activeDateKeys = useMemo((): { start: string; end: string } | null => {
    if (filters.customDateFrom && filters.customDateTo) {
      return { start: filters.customDateFrom.slice(0, 10), end: filters.customDateTo.slice(0, 10) };
    }
    if (!activeDateRange) return null;
    const localKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: localKey(activeDateRange.start), end: localKey(activeDateRange.end) };
  }, [activeDateRange, filters.customDateFrom, filters.customDateTo]);

  const filteredReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      const matchesSearch = !searchTerm || (
        receipt.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        receipt.date.includes(searchTerm) ||
        receipt.receiptNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
        receipt.driverName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (receipt.merchantName ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        // The printed Bon number and the street travel with the Beleg since
        // 20261027150000; a reviewer holding the paper searches by exactly these.
        (receipt.printedReceiptNumber ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (receipt.street ?? '').toLowerCase().includes(searchTerm.toLowerCase())
      );

      let matchesDate = true;
      if (activeDateKeys) {
        // ISO dates compare lexicographically in calendar order, so this needs no
        // Date at all and both ends are inclusive.
        const day = receipt.date.slice(0, 10);
        matchesDate = day >= activeDateKeys.start && day <= activeDateKeys.end;
      }

      const matchesDriver = !filters.driver || receipt.driverName === filters.driver;

      return matchesSearch && matchesDate && matchesDriver;
    });
  }, [receipts, searchTerm, activeDateKeys, filters.driver]);

  // utils/receiptSort.ts, which carries the comparison that used to be here
  // unchanged for the seven older fields and the measured one for the five the
  // owner added. Its header states what each of those five stores and why an
  // empty sorts last in both directions.
  const sortedReceipts = useMemo(
    () => sortReceipts(filteredReceipts, sortField, sortDirection),
    [filteredReceipts, sortField, sortDirection],
  );

  const calculateVat19FromGross = (gross: number): number =>
    Math.round((gross * 19 / 119) * 100) / 100;

  const totalExpenses = sortedReceipts.reduce((sum, r) => sum + r.expense, 0);
  const totalVat19 = sortedReceipts.reduce((sum, r) => sum + calculateVat19FromGross(r.expense), 0);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleMonthChange = (month: string) => {
    setFilters(prev => ({ ...prev, selectedMonth: month, selectedWeek: 0, customDateFrom: '', customDateTo: '' }));
  };

  const handleWeekChange = (weekNum: number) => {
    setFilters(prev => ({ ...prev, selectedWeek: weekNum, customDateFrom: '', customDateTo: '' }));
  };

  const clearFilters = () => {
    const now2 = new Date();
    setFilters({
      selectedMonth: format(now2, 'yyyy-MM'),
      selectedWeek: 0,
      driver: '',
      customDateFrom: '',
      customDateTo: ''
    });
    setSearchTerm('');
  };

  const activeWeek = weeksForMonth.find(w => w.weekNumber === filters.selectedWeek) ?? null;

  const hasActiveFilters = !!(filters.driver || filters.customDateFrom || filters.customDateTo || filters.selectedWeek > 0);
  const activeFilterCount = [filters.driver, filters.customDateFrom, filters.customDateTo, filters.selectedWeek > 0 ? 'week' : ''].filter(Boolean).length;

  /**
   * THE ONE ROW SET BOTH EXPORT BUTTONS WRITE.
   *
   * Every export in this component reads this binding and nothing else. It is
   * the whole fix: the Excel button used to read a copy of the filtered list
   * that the parent held and that nothing kept current, so the two buttons on
   * this screen produced different files from one screen state — and the wrong
   * one was the file that left the building. Do not reintroduce a second
   * expression for "the rows the user is looking at"; add a term to the filter
   * memo instead, and add its field to `exportFilters` below.
   */
  const exportRows = sortedReceipts;

  /**
   * The same four terms `filteredReceipts` narrows by, as facts rather than as
   * words, so the workbook's filter band states the filter that was actually
   * applied instead of a fixed "Gefilterte Auswahl".
   *
   * `activeDateKeys` is the calendar-day range the list itself compares against,
   * so the band cannot name a period other than the one that was applied.
   */
  const exportFilters: ReceiptExportFilters = {
    dateRange: activeDateKeys,
    week: filters.selectedWeek > 0 ? filters.selectedWeek : null,
    driver: filters.driver,
    search: searchTerm,
  };

  const handlePdfClick = () => {
    const filterInfo: PdfFilterInfo = {
      selectedMonth: filters.selectedMonth,
      selectedWeek: filters.selectedWeek > 0 ? filters.selectedWeek : null,
      weekRange: activeWeek ? { start: activeWeek.firstDay, end: activeWeek.lastDay } : activeDateRange,
      driver: filters.driver,
      companyName: ''
    };
    onDownloadPdf(exportRows, filterInfo);
  };

  const handleExcelClick = () => {
    onExportExcel(exportRows, exportFilters);
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the list's logic: the filters, the business-week range,
  // the search, the sort order, the totals and the PDF's filter information. It
  // is unchanged, except that four pieces of look that sat inside it moved out:
  // the hover-row state, the inline input style object, the sort-arrow
  // component and `formatDE`, a display formatter (euro amounts now go through
  // utils/money.ts). Everything below only draws.

  // formatEuro refuses a value that is not a finite amount; a figure shows it as
  // it is rather than taking the screen down, as DataTable does for its cells.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  /** A column header that sorts through the list's own sort state, not DataTable's. */
  const sortHeader = (field: SortField, label: string) => {
    const active = sortField === field;
    const Icon = !active ? ChevronsUpDown : sortDirection === 'asc' ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onClick={() => handleSort(field)}
        className={cn(
          // As DataTable's own sort buttons: on a touch screen the button fills
          // the 40 px header row instead of hugging its text.
          'inline-flex items-center gap-1 whitespace-nowrap rounded-sm transition-colors hover:text-fg [@media(pointer:coarse)]:min-h-10',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          active && 'text-fg',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('size-3.5', !active && 'text-fg-subtle')} />
        {active ? (
          <span className="sr-only">
            {sortDirection === 'asc' ? t('rec.sortedAscending') : t('rec.sortedDescending')}
          </span>
        ) : null}
      </button>
    );
  };

  const sourceParts = (receipt: Receipt) => receiptSourceParts(receipt);
  const fuelParts = (receipt: Receipt) =>
    receiptFuelParts(receipt, { odometer: t('rec.odometer'), rangeLeft: t('rec.rangeLeft') });

  const paymentLabel = (receipt: Receipt) =>
    // PAYMENT_METHODS is a shared constant in types/receipt.ts that
    // utils/receiptPdf.ts also reads, so it is not translated in place; the
    // on-screen label is resolved here instead.
    t(receipt.paymentMethod === 'uberweisung' ? 'rec.payment.uberweisung' : 'rec.payment.bar');

  // The header carries no unit for a distance, so the cell does; an absent reading stays empty.
  const withKm = (figure: string | null) => (figure === null ? null : `${figure} km`);

  const columns: DataTableColumn<Receipt>[] = [
    {
      id: 'date',
      header: sortHeader('date', t(SORTABLE_COLUMN_LABELS.date)),
      kind: 'date',
      value: receipt => receipt.date,
      hideBelow: 'sm',
      className: 'px-3',
    },
    {
      id: 'description',
      header: (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {sortHeader('description', t(SORTABLE_COLUMN_LABELS.description))}
          {sortHeader('receiptNumber', t(SORTABLE_COLUMN_LABELS.receiptNumber))}
        </span>
      ),
      cell: receipt => (
        <span className="grid min-w-0 gap-0.5 py-2">
          <span className="font-medium text-fg">{receipt.description}</span>
          {/* Not nowrap: on a phone the number may break at its hyphens, or it
              alone pushes the table past the screen. */}
          <span className="text-xs tabular-nums text-fg-subtle">{receipt.receiptNumber}</span>
          {/* The number the till itself printed — a different number from the
              BEL- id above it, and shown apart on purpose. */}
          {textOrNull(receipt.printedReceiptNumber) ? (
            <span className="text-xs tabular-nums text-fg-muted">
              {t('rec.printedShort', { number: receipt.printedReceiptNumber as string })}
            </span>
          ) : null}
          {/* A phone hides the date and driver columns; their values move here. */}
          <span className="text-[13px] text-fg-muted md:hidden">
            <span className="tabular-nums sm:hidden">{formatDate(receipt.date)} · </span>
            {receipt.driverName}
          </span>
          {/* Below lg the merchant, place, time and fuel columns are hidden;
              their values move here, as the date and driver do. */}
          {sourceParts(receipt).length > 0 ? (
            <span className="text-[13px] text-fg-muted lg:hidden">{sourceParts(receipt).join(' · ')}</span>
          ) : null}
          {fuelParts(receipt).length > 0 ? (
            <span className="text-[13px] tabular-nums text-fg-muted lg:hidden">{fuelParts(receipt).join(' · ')}</span>
          ) : null}
        </span>
      ),
      // At 375 px the Beleg, the amount and both row actions share the width;
      // 10rem left the table 12 px wider than the phone.
      className: 'min-w-[8rem] pl-3 pr-1 sm:min-w-[10rem] sm:px-3',
    },
    // One column per datum a Beleg from the driver app carries. Always defined,
    // so the table's shape does not change with the filter; an absent value is an
    // empty cell, never a zero.
    {
      id: 'merchantName',
      header: t('rec.merchant'),
      // Stacked: the brand half when the header split (old rows keep the whole
      // name), the operator when the name line does not already carry it, and
      // the street beneath — "street under the station cell".
      cell: receipt => {
        const station = receiptStationCell(receipt);
        if (station.name === null && station.street === null) return null;
        return (
          <span className="grid min-w-0 gap-0.5 py-2">
            {station.name ? <span>{station.name}</span> : null}
            {station.operator ? <span className="text-xs text-fg-muted">{station.operator}</span> : null}
            {station.street ? <span className="text-xs text-fg-muted">{station.street}</span> : null}
          </span>
        );
      },
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'city',
      header: t('rec.place'),
      cell: receipt => textOrNull(receipt.city),
      hideBelow: 'lg',
      className: 'px-3',
    },
    // The five the owner marked on 27.10.2026. The cells are untouched — each
    // still prints the German-formatted figure, and an absent one is still an
    // empty cell — and only the header gained the control. All five are
    // `hideBelow: 'lg'`, so none of the new buttons is drawn on a phone and the
    // 375 px width the table already fits into cannot move.
    {
      id: 'receiptTime',
      header: sortHeader('receiptTime', t(SORTABLE_COLUMN_LABELS.receiptTime)),
      cell: receipt => clockTime(receipt.receiptTime),
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'litres',
      header: sortHeader('litres', t(SORTABLE_COLUMN_LABELS.litres)),
      kind: 'number',
      cell: receipt => receiptFuelFigures(receipt).litres,
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'pricePerLitre',
      header: sortHeader('pricePerLitre', t(SORTABLE_COLUMN_LABELS.pricePerLitre)),
      kind: 'number',
      cell: receipt => receiptFuelFigures(receipt).pricePerLitre,
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'odometerKm',
      header: sortHeader('odometerKm', t(SORTABLE_COLUMN_LABELS.odometerKm)),
      kind: 'number',
      cell: receipt => withKm(receiptFuelFigures(receipt).odometerKm),
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'rangeKm',
      header: sortHeader('rangeKm', t(SORTABLE_COLUMN_LABELS.rangeKm)),
      kind: 'number',
      cell: receipt => withKm(receiptFuelFigures(receipt).rangeKm),
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'driverName',
      header: sortHeader('driverName', t(SORTABLE_COLUMN_LABELS.driverName)),
      value: receipt => receipt.driverName,
      hideBelow: 'md',
      className: 'px-3',
    },
    {
      id: 'paymentMethod',
      header: t('rec.paymentType'),
      cell: receipt => <Badge tone={receipt.paymentMethod === 'uberweisung' ? 'brand' : 'neutral'}>{paymentLabel(receipt)}</Badge>,
      hideBelow: 'lg',
      className: 'px-3',
    },
    {
      id: 'expense',
      header: sortHeader('expense', t('common.expenses')),
      kind: 'currency',
      cell: receipt => (receipt.expense > 0 ? euro(receipt.expense) : null),
      className: 'pl-1 pr-2 sm:px-3',
    },
    {
      id: 'vat',
      header: t('rec.vat19'),
      kind: 'currency',
      cell: receipt => (receipt.expense > 0 ? euro(calculateVat19FromGross(receipt.expense)) : null),
      hideBelow: 'sm',
      className: 'px-3',
    },
    {
      id: 'createdBy',
      header: t('rec.createdBy'),
      cell: receipt => (
        <span className="text-fg-muted" title={receipt.submittedByName || receipt.createdBy || ''}>
          {resolveCreator(receipt)}
        </span>
      ),
      hideBelow: 'lg',
      className: 'px-3',
    },
  ];

  // A read context, or a role without the right, writes nothing (plan 3.4b):
  // the actions it may not use are not offered at all, rather than disabled.
  const anyRowWritable = sortedReceipts.some(receipt => canEdit(receipt) || canDelete(receipt));

  const rowActions = (receipt: Receipt) => (
    <>
      {canEdit(receipt) ? (
        <Tooltip content={t('common.edit')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('rec.editAria', { number: receipt.receiptNumber })}
            onClick={() => canEdit(receipt) && onEdit(receipt)}
          >
            <Pencil aria-hidden />
          </Button>
        </Tooltip>
      ) : null}
      {canDelete(receipt) ? (
        <Tooltip content={t('common.delete')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-critical"
            aria-label={t('rec.deleteAria', { number: receipt.receiptNumber })}
            onClick={() => canDelete(receipt) && onDelete(receipt.id)}
          >
            <Trash2 aria-hidden />
          </Button>
        </Tooltip>
      ) : null}
    </>
  );

  const filterPanelId = 'receipt-filter-panel';

  return (
    // grid-cols-1 is minmax(0, 1fr): a bare grid sizes its column to the widest
    // child's content, and the table alone would push the page past 375 px.
    <div className="grid grid-cols-1 gap-4">
      {/* Search, month, week, filters, and both exports — which sit here, next to
          the filters that decide what they hold. The Excel button used to be in
          the page header, two components away from the filter it was supposed to
          honour, which is how it came to honour none of them. The grid's five
          tracks are unchanged: the two export buttons share the last one and
          wrap inside it, so the row narrows instead of pushing the page wider. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_11rem_15rem_auto_auto] lg:items-end">
        <Field label={t('common.search')} className="sm:col-span-2 lg:col-span-1">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              type="text"
              placeholder={t('rec.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
        </Field>

        <Field label={t('common.month')}>
          <Input
            type="month"
            value={filters.selectedMonth}
            onChange={(e) => handleMonthChange(e.target.value)}
          />
        </Field>

        <Field label={t('common.week')}>
          <NativeSelect
            value={filters.selectedWeek}
            onChange={(e) => handleWeekChange(Number(e.target.value))}
          >
            <option value={0}>{t('rec.allWeeks')}</option>
            {weeksForMonth.map(w => (
              <option key={w.weekNumber} value={w.weekNumber}>
                {t('rec.weekOption', {
                  week: w.weekNumber,
                  from: format(w.firstDay, 'dd.MM.yyyy'),
                  to: format(w.lastDay, 'dd.MM.yyyy'),
                })}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Button
          variant="secondary"
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
          aria-controls={filterPanelId}
          className={cn(hasActiveFilters && 'border-brand/40 bg-brand-soft text-brand-text hover:bg-brand-soft')}
        >
          <Filter aria-hidden />
          {t('rec.filter')}
          {hasActiveFilters && (
            <Badge tone="brand" className="px-1.5 tabular-nums">
              {activeFilterCount}
            </Badge>
          )}
        </Button>

        {/* One cell, two files, one row set. flex-wrap is what keeps the row from
            growing: the cell's min-content is the wider button alone, so a narrow
            viewport puts them on two lines instead of pushing the page past its
            width — an `auto` grid track holding two unwrapped buttons would. */}
        <div className="flex flex-wrap items-end gap-3">
          <Button
            variant="secondary"
            onClick={handlePdfClick}
            disabled={exportRows.length === 0}
            title={exportRows.length === 0 ? t('rec.noneForFilters') : t('rec.downloadSummaryPdf')}
          >
            <FileDown aria-hidden />
            {t('rec.summaryPdf')}
          </Button>

          {/* Withheld on a failed read as well as on an empty selection: a
              workbook whose totals row says 0,00 € for a read that never landed
              is a claim, not a report. */}
          <Button
            variant="secondary"
            onClick={handleExcelClick}
            disabled={exportDisabled || exportRows.length === 0}
            aria-disabled={exportDisabled || exportRows.length === 0}
            title={exportDisabled
              ? t('belege.loadFailedTitle')
              : exportRows.length === 0 ? t('rec.noneForFilters') : t('common.exportExcelShort')}
          >
            <Download aria-hidden />
            {t('common.exportExcelShort')}
          </Button>
        </div>
      </div>

      {activeWeek && (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Calendar aria-hidden className="size-4 text-fg-subtle" />
          <span className="tabular-nums">
            {t('rec.activeWeek', {
              week: activeWeek.weekNumber,
              from: format(activeWeek.firstDay, 'dd.MM.yyyy'),
              to: format(activeWeek.lastDay, 'dd.MM.yyyy'),
            })}
          </span>
        </p>
      )}

      {showFilters && (
        <Card id={filterPanelId}>
          <CardContent className="grid gap-4 pt-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label={t('common.driver')}>
                <NativeSelect
                  value={filters.driver}
                  onChange={(e) => setFilters({ ...filters, driver: e.target.value })}
                >
                  <option value="">{t('common.allDrivers')}</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.name}>{d.name}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('rec.customFrom')}>
                <Input
                  type="date"
                  value={filters.customDateFrom}
                  onChange={(e) => setFilters({ ...filters, customDateFrom: e.target.value, selectedWeek: 0 })}
                />
              </Field>
              <Field label={t('rec.customTo')}>
                <Input
                  type="date"
                  value={filters.customDateTo}
                  onChange={(e) => setFilters({ ...filters, customDateTo: e.target.value, selectedWeek: 0 })}
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X aria-hidden />
                {t('rec.resetAllFilters')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard
          label={t('rec.totalExpenses')}
          value={euro(totalExpenses)}
          icon={ReceiptIcon}
          caption={tPlural({ one: 'rec.belegCount.one', other: 'rec.belegCount.other' }, sortedReceipts.length)}
        />
        <KpiCard label={t('rec.sumVat19')} value={euro(totalVat19)} caption={t('rec.vatIncluded')} />
      </div>

      <DataTable
        caption={t('rec.tableCaption')}
        columns={columns}
        rows={sortedReceipts}
        getRowId={receipt => receipt.id}
        rowActions={anyRowWritable ? rowActions : undefined}
        rowActionsLabel={t('rec.tableActions')}
        totals={{ date: '', description: t('ui.table.total'), expense: euro(totalExpenses), vat: euro(totalVat19) }}
        emptyState={
          <EmptyState
            size="sm"
            icon={ReceiptIcon}
            title={receipts.length === 0 ? t('rec.noneYet') : t('rec.noneForFilters')}
            action={
              receipts.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  <X aria-hidden />
                  {t('rec.resetFilters')}
                </Button>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
};

export default ReceiptList;
