import React, { useState, useMemo } from 'react';
import { ArrowDown, ArrowUp, Calendar, ChevronsUpDown, FileDown, Filter, Pencil, Receipt as ReceiptIcon, Search, Trash2, X } from 'lucide-react';
import { Receipt, Driver } from '../types/receipt';
import { format, getMonth, getYear } from 'date-fns';
import { getBusinessMonthRange, getBusinessWeeksForMonth, WeekOfMonth } from '../utils/weekCalculations';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
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
  onExportFiltered: (filteredReceipts: Receipt[]) => void;
  onDownloadPdf: (filteredReceipts: Receipt[], filterInfo: PdfFilterInfo) => void;
  canEdit: (receipt: Receipt) => boolean;
  canDelete: (receipt: Receipt) => boolean;
  userDisplayNames?: Map<string, string>;
}

export interface PdfFilterInfo {
  selectedMonth: string;         // 'yyyy-MM' or ''
  selectedWeek: number | null;   // week number or null
  weekRange: { start: Date; end: Date } | null;
  driver: string;
  companyName: string;
}

type SortField = 'receiptNumber' | 'date' | 'description' | 'driverName' | 'income' | 'expense' | 'balance';
type SortDirection = 'asc' | 'desc';

// Values hold TranslationKeys: this map is module-level and t() is a hook value,
// so the table header resolves it at the call site.
const SORTABLE_COLUMN_LABELS: Record<'receiptNumber' | 'date' | 'driverName' | 'description', TranslationKey> = {
  receiptNumber: 'rec.receiptNumber',
  date:          'common.date',
  driverName:    'common.driver',
  description:   'rec.bookingText',
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
  onExportFiltered,
  onDownloadPdf,
  canEdit,
  canDelete,
  userDisplayNames = new Map(),
}) => {
  const { t, tPlural } = useTranslation();

  const resolveCreator = (createdBy: string | undefined): string => {
    if (!createdBy) return t('rec.unknownUser');
    return userDisplayNames.get(createdBy) ?? t('rec.unknownUser');
  };
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
        receipt.driverName.toLowerCase().includes(searchTerm.toLowerCase())
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

  const sortedReceipts = useMemo(() => {
    return [...filteredReceipts].sort((a, b) => {
      let aValue: any = a[sortField];
      let bValue: any = b[sortField];
      if (sortField === 'date') {
        aValue = new Date(aValue);
        bValue = new Date(bValue);
      }
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredReceipts, sortField, sortDirection]);

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

  const handlePdfClick = () => {
    const filterInfo: PdfFilterInfo = {
      selectedMonth: filters.selectedMonth,
      selectedWeek: filters.selectedWeek > 0 ? filters.selectedWeek : null,
      weekRange: activeWeek ? { start: activeWeek.firstDay, end: activeWeek.lastDay } : activeDateRange,
      driver: filters.driver,
      companyName: ''
    };
    onDownloadPdf(sortedReceipts, filterInfo);
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

  const paymentLabel = (receipt: Receipt) =>
    // PAYMENT_METHODS is a shared constant in types/receipt.ts that
    // utils/receiptPdf.ts also reads, so it is not translated in place; the
    // on-screen label is resolved here instead.
    t(receipt.paymentMethod === 'uberweisung' ? 'rec.payment.uberweisung' : 'rec.payment.bar');

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
          {/* A phone hides the date and driver columns; their values move here. */}
          <span className="text-[13px] text-fg-muted md:hidden">
            <span className="tabular-nums sm:hidden">{formatDate(receipt.date)} · </span>
            {receipt.driverName}
          </span>
          {receipt.city ? <span className="text-[13px] text-fg-muted">{receipt.city}</span> : null}
        </span>
      ),
      // At 375 px the Beleg, the amount and both row actions share the width;
      // 10rem left the table 12 px wider than the phone.
      className: 'min-w-[8rem] pl-3 pr-1 sm:min-w-[10rem] sm:px-3',
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
        <span className="text-fg-muted" title={receipt.createdBy || ''}>
          {resolveCreator(receipt.createdBy)}
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
      {/* Search, month, week, filters, PDF */}
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

        <Button
          variant="secondary"
          onClick={handlePdfClick}
          disabled={sortedReceipts.length === 0}
          title={sortedReceipts.length === 0 ? t('rec.noneForFilters') : t('rec.downloadSummaryPdf')}
        >
          <FileDown aria-hidden />
          {t('rec.summaryPdf')}
        </Button>
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
