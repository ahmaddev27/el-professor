import React, { useState, useMemo } from 'react';
import { CreditCard as Edit, Trash2, Search, Import as SortAsc, Dessert as SortDesc, Receipt as ReceiptIcon, User, Filter, X, Calendar, FileDown } from 'lucide-react';
import { Receipt, Driver } from '../types/receipt';
import { format, getMonth, getYear } from 'date-fns';
import { getBusinessMonthRange, getBusinessWeeksForMonth, WeekOfMonth } from '../utils/weekCalculations';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

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
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

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

  const filteredReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      const matchesSearch = !searchTerm || (
        receipt.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        receipt.date.includes(searchTerm) ||
        receipt.receiptNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
        receipt.driverName.toLowerCase().includes(searchTerm.toLowerCase())
      );

      const receiptDate = new Date(receipt.date);
      let matchesDate = true;
      if (activeDateRange) {
        matchesDate =
          receiptDate >= activeDateRange.start &&
          receiptDate <= activeDateRange.end;
      }

      const matchesDriver = !filters.driver || receipt.driverName === filters.driver;

      return matchesSearch && matchesDate && matchesDriver;
    });
  }, [receipts, searchTerm, activeDateRange, filters.driver]);

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

  const formatDE = (n: number): string =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <SortAsc className="opacity-30" size={16} />;
    return sortDirection === 'asc' ? <SortAsc size={16} /> : <SortDesc size={16} />;
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

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none'
  };

  return (
    <div className="space-y-4">
      {/* Search and top controls */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={20} />
            <input
              type="text"
              placeholder={t('rec.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4"
              style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.5rem' }}
            />
          </div>

          {/* Month picker */}
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-md"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
          >
            <Calendar size={18} style={{ color: 'var(--text-tertiary)' }} />
            <input
              type="month"
              value={filters.selectedMonth}
              onChange={(e) => handleMonthChange(e.target.value)}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontWeight: '500', fontSize: '0.875rem' }}
            />
          </div>

          {/* Week picker */}
          <div style={{ minWidth: '200px' }}>
            <select
              value={filters.selectedWeek}
              onChange={(e) => handleWeekChange(Number(e.target.value))}
              style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}
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
            </select>
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="px-4 py-2 rounded-md border transition-colors flex items-center space-x-2"
            style={
              showFilters || hasActiveFilters
                ? { background: 'var(--accent-subtle)', borderColor: 'var(--accent)', color: 'var(--accent-text)' }
                : { background: 'var(--bg-surface)', borderColor: 'var(--border)', color: 'var(--text-primary)' }
            }
          >
            <Filter size={16} />
            <span>{t('rec.filter')}</span>
            {hasActiveFilters && (
              <span className="text-xs rounded-full px-2 py-0.5" style={{ background: 'var(--accent)', color: 'white' }}>
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* PDF button */}
          <button
            onClick={handlePdfClick}
            disabled={sortedReceipts.length === 0}
            className="px-4 py-2 rounded-md flex items-center gap-2 transition-all"
            style={{
              background: sortedReceipts.length === 0 ? 'var(--bg-muted)' : '#1e3a5f',
              color: sortedReceipts.length === 0 ? 'var(--text-tertiary)' : '#93c5fd',
              border: '1px solid',
              borderColor: sortedReceipts.length === 0 ? 'var(--border)' : '#1e40af',
              cursor: sortedReceipts.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: '500'
            }}
            title={sortedReceipts.length === 0 ? t('rec.noneForFilters') : t('rec.downloadSummaryPdf')}
          >
            <FileDown size={16} />
            <span className="hidden sm:inline">{t('rec.summaryPdf')}</span>
          </button>
        </div>

        {/* Active week label */}
        {activeWeek && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Calendar size={14} />
            <span>
              {t('rec.activeWeek', {
                week: activeWeek.weekNumber,
                from: format(activeWeek.firstDay, 'dd.MM.yyyy'),
                to: format(activeWeek.lastDay, 'dd.MM.yyyy'),
              })}
            </span>
          </div>
        )}

        {/* Filter Panel */}
        {showFilters && (
          <div className="p-4 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
                <select
                  value={filters.driver}
                  onChange={(e) => setFilters({ ...filters, driver: e.target.value })}
                  className="w-full"
                  style={inputStyle}
                >
                  <option value="">{t('common.allDrivers')}</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('rec.customFrom')}</label>
                <input
                  type="date"
                  value={filters.customDateFrom}
                  onChange={(e) => setFilters({ ...filters, customDateFrom: e.target.value, selectedWeek: 0 })}
                  className="w-full"
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('rec.customTo')}</label>
                <input
                  type="date"
                  value={filters.customDateTo}
                  onChange={(e) => setFilters({ ...filters, customDateTo: e.target.value, selectedWeek: 0 })}
                  className="w-full"
                  style={inputStyle}
                />
              </div>
            </div>
            <div className="flex justify-end mt-3">
              <button
                onClick={clearFilters}
                className="px-3 py-1 text-sm flex items-center space-x-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X size={14} />
                <span>{t('rec.resetAllFilters')}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Summary bar */}
      <div className="rounded-lg p-4" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>{t('rec.totalExpenses')}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--danger)' }}>
              {tPlural({ one: 'rec.belegCount.one', other: 'rec.belegCount.other' }, sortedReceipts.length)}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 sm:items-end text-right">
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--danger)', opacity: 0.75 }}>{t('rec.sumExpensesEuro')}</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--danger)' }}>
                {formatDE(totalExpenses)} €
              </p>
            </div>
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--danger)', opacity: 0.75 }}>{t('rec.sumVat19')}</p>
              <p className="text-xl font-semibold" style={{ color: 'var(--danger)' }}>
                {formatDE(totalVat19)} €
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop Table */}
      <div className="hidden md:block overflow-x-auto rounded-lg" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
        <table className="w-full">
          <thead style={{ background: 'var(--bg-subtle)' }}>
            <tr>
              {(Object.keys(SORTABLE_COLUMN_LABELS) as (keyof typeof SORTABLE_COLUMN_LABELS)[]).map((field) => {
                return (
                  <th
                    key={field}
                    className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider cursor-pointer"
                    style={{ color: 'var(--text-tertiary)' }}
                    onClick={() => handleSort(field)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-muted)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div className="flex items-center space-x-1">
                      <span>{t(SORTABLE_COLUMN_LABELS[field])}</span>
                      <SortIcon field={field} />
                    </div>
                  </th>
                );
              })}
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('rec.city')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('rec.paymentType')}</th>
              <th
                className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider cursor-pointer"
                style={{ color: 'var(--text-tertiary)' }}
                onClick={() => handleSort('expense')}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div className="flex items-center justify-end space-x-1">
                  <span>{t('rec.expensesEuro')}</span>
                  <SortIcon field="expense" />
                </div>
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('rec.vat19')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('rec.createdBy')}</th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('rec.tableActions')}</th>
            </tr>
          </thead>
          <tbody style={{ background: 'var(--bg-surface)' }}>
            {sortedReceipts.map((receipt) => (
              <tr
                key={receipt.id}
                style={{
                  background: hoveredRow === receipt.id ? 'var(--bg-subtle)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={() => setHoveredRow(receipt.id)}
                onMouseLeave={() => setHoveredRow(null)}
              >
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  <div className="flex items-center space-x-2">
                    <ReceiptIcon size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>{receipt.receiptNumber}</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                  {format(new Date(receipt.date), 'dd.MM.yyyy')}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                  <div className="flex items-center space-x-2">
                    <User size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>{receipt.driverName}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>{receipt.description}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>{receipt.city || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                  <span
                    className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                    style={receipt.paymentMethod === 'uberweisung'
                      ? { background: 'var(--accent-subtle)', color: 'var(--accent-text)' }
                      : { background: 'var(--success-subtle)', color: 'var(--success)' }}
                  >
                    {/* PAYMENT_METHODS is a shared constant in types/receipt.ts that
                        utils/receiptPdf.ts also reads, so it is not translated in
                        place; the on-screen badge is resolved here instead. */}
                    {t(receipt.paymentMethod === 'uberweisung' ? 'rec.payment.uberweisung' : 'rec.payment.bar')}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                  {receipt.expense > 0 && (
                    <span className="font-medium" style={{ color: 'var(--danger)' }}>
                      {formatDE(receipt.expense)}
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                  {receipt.expense > 0 && (
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                      {formatDE(calculateVat19FromGross(receipt.expense))}
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-tertiary)' }}
                  title={receipt.createdBy || ''}>
                  {resolveCreator(receipt.createdBy)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end space-x-2">
                    <button
                      onClick={() => canEdit(receipt) && onEdit(receipt)}
                      disabled={!canEdit(receipt)}
                      style={{ color: canEdit(receipt) ? 'var(--accent)' : 'var(--text-tertiary)', cursor: canEdit(receipt) ? 'pointer' : 'not-allowed', opacity: canEdit(receipt) ? 1 : 0.5 }}
                      title={canEdit(receipt) ? t('common.edit') : t('rec.onlyAdminOrCreator')}
                    >
                      <Edit size={16} />
                    </button>
                    <button
                      onClick={() => canDelete(receipt) && onDelete(receipt.id)}
                      disabled={!canDelete(receipt)}
                      style={{ color: canDelete(receipt) ? 'var(--danger)' : 'var(--text-tertiary)', cursor: canDelete(receipt) ? 'pointer' : 'not-allowed', opacity: canDelete(receipt) ? 1 : 0.5 }}
                      title={canDelete(receipt) ? t('common.delete') : t('rec.onlyAdminOrCreator')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-4">
        {sortedReceipts.map((receipt) => (
          <div key={receipt.id} className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
            <div className="flex justify-between items-start mb-3">
              <div>
                <div className="text-sm font-medium flex items-center space-x-1" style={{ color: 'var(--text-tertiary)' }}>
                  <ReceiptIcon size={14} />
                  <span>{receipt.receiptNumber}</span>
                </div>
                <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{receipt.description}</div>
                <div className="text-sm flex items-center space-x-1 mt-1" style={{ color: 'var(--text-secondary)' }}>
                  <User size={14} />
                  <span>{receipt.driverName}</span>
                </div>
                {receipt.city && <div className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{t('rec.city')}: {receipt.city}</div>}
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => canEdit(receipt) && onEdit(receipt)}
                  disabled={!canEdit(receipt)}
                  className="p-2 rounded"
                  style={{ color: canEdit(receipt) ? 'var(--accent)' : 'var(--text-tertiary)', opacity: canEdit(receipt) ? 1 : 0.5 }}
                >
                  <Edit size={16} />
                </button>
                <button
                  onClick={() => canDelete(receipt) && onDelete(receipt.id)}
                  disabled={!canDelete(receipt)}
                  className="p-2 rounded"
                  style={{ color: canDelete(receipt) ? 'var(--danger)' : 'var(--text-tertiary)', opacity: canDelete(receipt) ? 1 : 0.5 }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('common.date')}:</span>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{format(new Date(receipt.date), 'dd.MM.yyyy')}</div>
              </div>
              {receipt.expense > 0 && (
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('common.expenses')}:</span>
                  <div className="font-medium" style={{ color: 'var(--danger)' }}>{formatDE(receipt.expense)} €</div>
                </div>
              )}
              {receipt.expense > 0 && (
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('rec.vat19')}:</span>
                  <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{formatDE(calculateVat19FromGross(receipt.expense))} €</div>
                </div>
              )}
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('rec.paymentType')}:</span>
                <div className="font-medium">
                  <span
                    className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                    style={receipt.paymentMethod === 'uberweisung'
                      ? { background: 'var(--accent-subtle)', color: 'var(--accent-text)' }
                      : { background: 'var(--success-subtle)', color: 'var(--success)' }}
                  >
                    {t(receipt.paymentMethod === 'uberweisung' ? 'rec.payment.uberweisung' : 'rec.payment.bar')}
                  </span>
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('rec.createdBy')}:</span>
                <div className="font-medium" style={{ color: 'var(--text-secondary)' }} title={receipt.createdBy || ''}>
                  {resolveCreator(receipt.createdBy)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {sortedReceipts.length === 0 && (
        <div className="text-center py-12 rounded-lg" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <p className="text-lg" style={{ color: 'var(--text-secondary)' }}>
            {receipts.length === 0 ? t('rec.noneYet') : t('rec.noneForFilters')}
          </p>
          {receipts.length > 0 && (
            <button onClick={clearFilters} className="mt-2 text-sm" style={{ color: 'var(--accent)' }}>
              {t('rec.resetFilters')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ReceiptList;
