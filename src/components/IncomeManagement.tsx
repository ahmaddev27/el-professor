import React, { useState, useEffect, useRef } from 'react';
import { TrendingUp, Plus, CreditCard as Edit2, Trash2, Save, X, DollarSign, Download, Calendar, RefreshCw, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Income, IncomeFormData, Driver, INCOME_TYPES } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, subMonths, getMonth, getYear } from 'date-fns';
import ConfirmationModal from './ConfirmationModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportIncomeToExcel } from '../utils/excelExport';
import { getWeeksOfMonth, getWeekNumberForDate, WeekOfMonth, getBusinessMonthRange, getBusinessWeekRange } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

interface IncomeManagementProps {
  drivers: Driver[];
}

type DatePreset = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';

type IncomeType = 'bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen';

// Values hold TranslationKeys: these maps are module-level and t() is a hook
// value, so every consumer resolves them at the call site.
const DATE_PRESET_LABELS: Record<DatePreset, TranslationKey> = {
  thisWeek:  'inc.preset.thisWeek',
  lastWeek:  'inc.preset.lastWeek',
  thisMonth: 'inc.preset.thisMonth',
  lastMonth: 'inc.preset.lastMonth',
  thisYear:  'inc.preset.thisYear',
  custom:    'inc.preset.custom',
};

// The keys of this map are the values persisted in `income.type` and compared on
// read — they are data, not labels, and never translate. The labels do: Bargeld,
// Umsatz and Aktionen render as Cash, Revenue and Promotions, matching
// overview.kpi.* in the English dictionary. Only Trinkgeld stays German, because
// it is the subject of the Trinkgeld-Quittung.
const INCOME_TYPE_LABELS: Record<IncomeType, TranslationKey> = {
  bargeld:   'inc.typeBargeld',
  umsatz:    'inc.typeUmsatz',
  aktionen:  'inc.typeAktionen',
  trinkgeld: 'inc.typeTrinkgeld',
};

const INCOME_TYPE_ORDER: IncomeType[] = ['bargeld', 'umsatz', 'aktionen', 'trinkgeld'];

const IncomeManagement: React.FC<IncomeManagementProps> = ({ drivers }) => {
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [filteredIncomes, setFilteredIncomes] = useState<Income[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // ── Batch add form state ───────────────────────────────────────────────────
  const [batchForm, setBatchForm] = useState({
    driver_name: '',
    date: format(new Date(), 'yyyy-MM-dd'),
    week: undefined as number | undefined,
    description: '',
    nettoFahrpreis: '',
    aktionen: '',
    trinkgeld: '',
    bargeld: '',
    tripCount: '',
  });

  // Single-row edit form (keeps existing edit-in-table flow)
  const [formData, setFormData] = useState<IncomeFormData>({
    description: '',
    amount: '',
    type: 'umsatz',
    driver_name: '',
    date: format(new Date(), 'yyyy-MM-dd'),
    week: undefined
  });

  const [availableWeeks, setAvailableWeeks] = useState<WeekOfMonth[]>([]);

  // Date range filter state - using business month
  const currentBusinessMonth = getMonth(new Date());
  const currentBusinessYear = getYear(new Date());
  const initialBusinessRange = getBusinessMonthRange(currentBusinessMonth, currentBusinessYear);

  const [datePreset, setDatePreset] = useState<DatePreset>('thisMonth');
  const [fromDate, setFromDate] = useState(format(initialBusinessRange.start, 'yyyy-MM-dd'));
  const [toDate, setToDate] = useState(format(initialBusinessRange.end, 'yyyy-MM-dd'));
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const { user, profile, canEdit, canDelete, canCreate } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { success, error: showError, warning } = useToast();
  const { t, tPlural } = useTranslation();
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: string | null }>({ isOpen: false, id: null });

  useEffect(() => {
    loadIncomes();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [incomes, fromDate, toDate, searchTerm, selectedDriver, selectedType]);

  useEffect(() => {
    const dateStr = editingId ? formData.date : batchForm.date;
    if (dateStr) {
      const selectedDate = new Date(dateStr);
      const weeks = getWeeksOfMonth(selectedDate);
      setAvailableWeeks(weeks);
      const weekNumber = getWeekNumberForDate(selectedDate);
      if (editingId) {
        setFormData(prev => ({ ...prev, week: weekNumber }));
      } else {
        setBatchForm(prev => ({ ...prev, week: weekNumber }));
      }
    }
  }, [formData.date, batchForm.date, editingId]);

  const loadIncomes = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('income')
        .select('*')
        .eq('company_id', companyId)
        .order('date', { ascending: false });

      if (error) throw error;
      setIncomes(data || []);
    } catch (err: any) {
      console.error('Error loading incomes:', err);
      showError(t('common.errorLoad'), handleDatabaseError(err));
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...incomes];

    // Date range filter
    if (fromDate) {
      filtered = filtered.filter(income => income.date >= fromDate);
    }
    if (toDate) {
      filtered = filtered.filter(income => income.date <= toDate);
    }

    // Search filter
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      filtered = filtered.filter(income =>
        (income.description || '').toLowerCase().includes(search) ||
        income.driver_name.toLowerCase().includes(search)
      );
    }

    // Driver filter
    if (selectedDriver) {
      filtered = filtered.filter(income => income.driver_name === selectedDriver);
    }

    // Type filter
    if (selectedType) {
      filtered = filtered.filter(income => income.type === selectedType);
    }

    setFilteredIncomes(filtered);
  };

  const handlePresetChange = (preset: DatePreset) => {
    setDatePreset(preset);
    const now = new Date();

    switch (preset) {
      case 'thisWeek':
        const thisWeekRange = getBusinessWeekRange(now);
        setFromDate(format(thisWeekRange.monday, 'yyyy-MM-dd'));
        setToDate(format(thisWeekRange.sunday, 'yyyy-MM-dd'));
        break;
      case 'lastWeek':
        const lastWeekDate = new Date(now);
        lastWeekDate.setDate(now.getDate() - 7);
        const lastWeekRange = getBusinessWeekRange(lastWeekDate);
        setFromDate(format(lastWeekRange.monday, 'yyyy-MM-dd'));
        setToDate(format(lastWeekRange.sunday, 'yyyy-MM-dd'));
        break;
      case 'thisMonth':
        const thisMonthRange = getBusinessMonthRange(getMonth(now), getYear(now));
        setFromDate(format(thisMonthRange.start, 'yyyy-MM-dd'));
        setToDate(format(thisMonthRange.end, 'yyyy-MM-dd'));
        break;
      case 'lastMonth':
        const lastMonth = subMonths(now, 1);
        const lastMonthRange = getBusinessMonthRange(getMonth(lastMonth), getYear(lastMonth));
        setFromDate(format(lastMonthRange.start, 'yyyy-MM-dd'));
        setToDate(format(lastMonthRange.end, 'yyyy-MM-dd'));
        break;
      case 'thisYear':
        setFromDate(format(startOfYear(now), 'yyyy-MM-dd'));
        setToDate(format(endOfYear(now), 'yyyy-MM-dd'));
        break;
      case 'custom':
        // Keep current dates
        break;
    }
  };

  const resetFilters = () => {
    setDatePreset('thisMonth');
    const now = new Date();
    const businessRange = getBusinessMonthRange(getMonth(now), getYear(now));
    setFromDate(format(businessRange.start, 'yyyy-MM-dd'));
    setToDate(format(businessRange.end, 'yyyy-MM-dd'));
    setSearchTerm('');
    setSelectedDriver('');
    setSelectedType('');
  };

  const handleExport = () => {
    if (filteredIncomes.length === 0) {
      warning(t('inc.noData'), t('inc.noDataToExport'));
      return;
    }
    // exportIncomeToExcel hard-codes its headers inside excelExport.ts rather
    // than taking them from here, so this workbook does not follow the UI
    // language. Nothing to pass; nothing to translate at this call site.
    exportIncomeToExcel(filteredIncomes, fromDate, toDate);
    success(t('inc.exportSuccess'), t('inc.exportSuccessBody'));
  };

  const parseBatchAmount = (val: string) => {
    // Accept both comma and dot as decimal separator
    const normalized = val.trim().replace(',', '.');
    const n = parseFloat(normalized);
    return isNaN(n) || n <= 0 ? null : n;
  };

  const handleBatchAdd = async () => {
    if (!canCreate) {
      showError(t('common.noPermission'), t('inc.noPermissionAdd'));
      return;
    }
    if (!batchForm.driver_name) {
      warning(t('inc.missingFields'), t('inc.selectDriverFirst'));
      return;
    }

    const amounts: { type: IncomeType; amount: number }[] = [];
    const netto = parseBatchAmount(batchForm.nettoFahrpreis);
    const akt   = parseBatchAmount(batchForm.aktionen);
    const tkg   = parseBatchAmount(batchForm.trinkgeld);
    const bar   = parseBatchAmount(batchForm.bargeld);

    if (netto) amounts.push({ type: 'umsatz',    amount: netto });
    if (akt)   amounts.push({ type: 'aktionen',  amount: akt });
    if (tkg)   amounts.push({ type: 'trinkgeld', amount: tkg });
    if (bar)   amounts.push({ type: 'bargeld',   amount: bar });

    if (amounts.length === 0) {
      warning(t('inc.missingFields'), t('inc.amountRequired'));
      return;
    }

    const rawTripCount = batchForm.tripCount.trim();
    let tripCount: number | null = null;
    if (rawTripCount !== '') {
      const tc = parseInt(rawTripCount, 10);
      if (isNaN(tc) || tc < 0) {
        warning(t('inc.invalidInput'), t('inc.tripCountInvalid'));
        return;
      }
      tripCount = tc;
    }

    if (!profile?.id) {
      showError(t('common.error'), t('inc.profileNotLoaded'));
      return;
    }

    // The `Woche N` prefix is written into `income.description` and matched again
    // on edit (`includes` below, and a regex in handleUpdate). It is stored data,
    // not a label, so it stays German in both UI languages.
    let description = batchForm.description.trim();
    if (batchForm.week && description && !description.includes(`Woche ${batchForm.week}`)) {
      description = `Woche ${batchForm.week} - ${description}`;
    } else if (batchForm.week && !description) {
      description = `Woche ${batchForm.week}`;
    }

    const rows = amounts.map(({ type, amount }) => {
      const rowDescription = description || '';
      return {
        description: rowDescription,
        amount,
        type,
        driver_name: batchForm.driver_name,
        date: batchForm.date,
        week: batchForm.week,
        trip_count: tripCount,
        created_by: parseInt(profile.id),
        company_id: companyId,
      };
    });

    try {
      const { error } = await supabase.from('income').insert(rows);
      if (error) throw error;

      const savedDate = batchForm.date;
      const savedDriver = batchForm.driver_name;

      // Keep driver + date for quick re-entry
      setBatchForm(prev => ({
        ...prev,
        nettoFahrpreis: '',
        aktionen: '',
        trinkgeld: '',
        bargeld: '',
        tripCount: '',
        description: '',
      }));
      setIsAdding(false);
      await loadIncomes();

      // Check if saved rows are visible under current filters
      const hiddenByFilter =
        (fromDate && savedDate < fromDate) ||
        (toDate && savedDate > toDate) ||
        (selectedDriver && selectedDriver !== savedDriver) ||
        (selectedType !== '');

      if (hiddenByFilter) {
        warning(
          t('inc.savedTitle'),
          tPlural(
            { one: 'inc.savedHiddenBody.one', other: 'inc.savedHiddenBody.other' },
            rows.length,
          ),
        );
      } else {
        success(
          t('inc.createdTitle'),
          tPlural({ one: 'inc.createdBody.one', other: 'inc.createdBody.other' }, rows.length),
        );
      }
    } catch (err: any) {
      console.error('Error adding incomes:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdate = async (id: string) => {
    if (!formData.amount || !formData.driver_name) {
      warning(t('inc.missingFields'), t('inc.amountAndDriverRequired'));
      return;
    }

    try {
      // `Woche N` is stored in `income.description` and matched here — data, not
      // a label. See handleBatchAdd.
      let description = formData.description.trim();
      if (formData.week && description && !description.includes(`Woche ${formData.week}`)) {
        description = description.replace(/Woche \d+/i, `Woche ${formData.week}`);
        if (!description.includes(`Woche ${formData.week}`)) {
          description = `Woche ${formData.week} - ${description}`;
        }
      } else if (formData.week && !description) {
        description = `Woche ${formData.week}`;
      }

      const { error } = await supabase
        .from('income')
        .update({
          description: description,
          amount: parseFloat(formData.amount),
          type: formData.type,
          driver_name: formData.driver_name,
          date: formData.date,
          week: formData.week
        })
        .eq('id', id);

      if (error) throw error;

      setEditingId(null);
      setFormData({
        description: '',
        amount: '',
        type: 'umsatz',
        driver_name: '',
        date: format(new Date(), 'yyyy-MM-dd'),
        week: undefined
      });
      await loadIncomes();
      success(t('inc.updated'), t('inc.updatedBody'));
    } catch (err: any) {
      console.error('Error updating income:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from('income')
        .delete()
        .eq('id', id);

      if (error) throw error;
      await loadIncomes();
      success(t('inc.deleted'), t('inc.deletedBody'));
      setDeleteConfirm({ isOpen: false, id: null });
    } catch (err: any) {
      console.error('Error deleting income:', err);
      showError(t('common.errorDelete'), handleDatabaseError(err));
    }
  };

  const confirmDelete = (id: string) => {
    setDeleteConfirm({ isOpen: true, id });
  };

  const startEdit = (income: Income) => {
    setEditingId(income.id);
    setFormData({
      description: income.description,
      amount: income.amount.toString(),
      type: income.type,
      driver_name: income.driver_name,
      date: income.date,
      week: income.week
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormData({
      description: '',
      amount: '',
      type: 'umsatz',
      driver_name: '',
      date: format(new Date(), 'yyyy-MM-dd')
    });
  };

  const cancelAdd = () => {
    setIsAdding(false);
    setBatchForm(prev => ({
      ...prev,
      nettoFahrpreis: '',
      aktionen: '',
      trinkgeld: '',
      bargeld: '',
      tripCount: '',
      description: '',
    }));
  };

  // Online revenue = Umsatz + Aktionen
  const totalIncome = filteredIncomes
    .filter(income => income.type === 'umsatz' || income.type === 'aktionen')
    .reduce((sum, income) => sum + Number(income.amount), 0);

  const getWeeklyDataByDriver = (driverName: string) => {
    const weeklyIncomes = filteredIncomes.filter(income => income.driver_name === driverName);

    const bargeld = weeklyIncomes
      .filter(income => income.type === 'bargeld')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    const nettoFahrpreis = weeklyIncomes
      .filter(income => income.type === 'umsatz')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    const trinkgeld = weeklyIncomes
      .filter(income => income.type === 'trinkgeld')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    const aktionen = weeklyIncomes
      .filter(income => income.type === 'aktionen')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    // Summe = Netto-Fahrpreis + Aktionen
    const summe = nettoFahrpreis + aktionen;

    return { bargeld, nettoFahrpreis, trinkgeld, aktionen, summe };
  };

  const carouselRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const scrollStartX = useRef(0);

  const scrollCarousel = (direction: 'left' | 'right') => {
    if (!carouselRef.current) return;
    const cardWidth = carouselRef.current.querySelector('[data-card]')?.clientWidth ?? 280;
    const gap = 16;
    carouselRef.current.scrollBy({ left: direction === 'left' ? -(cardWidth + gap) : (cardWidth + gap), behavior: 'smooth' });
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!carouselRef.current) return;
    isDragging.current = true;
    dragStartX.current = e.pageX;
    scrollStartX.current = carouselRef.current.scrollLeft;
    carouselRef.current.style.cursor = 'grabbing';
    carouselRef.current.style.userSelect = 'none';
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging.current || !carouselRef.current) return;
    const delta = e.pageX - dragStartX.current;
    carouselRef.current.scrollLeft = scrollStartX.current - delta;
  };

  const onMouseUp = () => {
    isDragging.current = false;
    if (carouselRef.current) {
      carouselRef.current.style.cursor = 'grab';
      carouselRef.current.style.userSelect = '';
    }
  };

  const activeDrivers = drivers.filter(driver => driver.status !== 'inactive');

  const inputStyle = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--success)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-green-600 to-green-800 rounded-xl shadow-lg p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-white bg-opacity-20 rounded-lg p-2">
              <TrendingUp className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold">{t('inc.title')}</h1>
              <p className="text-green-100 mt-1">{t('inc.subtitle')}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-green-100">{t('inc.totalFiltered')}</p>
            <p className="text-3xl font-bold">{totalIncome.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            <p className="text-xs text-green-200 mt-1">{t('inc.entriesOf', { shown: filteredIncomes.length, total: incomes.length })}</p>
          </div>
        </div>
      </div>

      {/* Date Range Filter Controls */}
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
      >
        <div className="space-y-4">
          {/* Preset Buttons */}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((preset) => {
              return (
                <button
                  key={preset}
                  onClick={() => handlePresetChange(preset)}
                  className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={
                    datePreset === preset
                      ? { background: 'var(--success-solid)', color: 'white' }
                      : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }
                  }
                >
                  {t(DATE_PRESET_LABELS[preset])}
                </button>
              );
            })}
          </div>

          {/* Date Range Inputs and Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label htmlFor="from-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {t('common.dateFrom')}
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
                <input
                  id="from-date"
                  type="date"
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value);
                    setDatePreset('custom');
                  }}
                  className="w-full pl-10 pr-3"
                  style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.25rem' }}
                  aria-label={t('common.dateFrom')}
                />
              </div>
            </div>

            <div>
              <label htmlFor="to-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {t('common.dateTo')}
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
                <input
                  id="to-date"
                  type="date"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setDatePreset('custom');
                  }}
                  className="w-full pl-10 pr-3"
                  style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.25rem' }}
                  aria-label={t('common.dateTo')}
                />
              </div>
            </div>

            <div>
              <label htmlFor="driver-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {t('common.driver')}
              </label>
              <select
                id="driver-filter"
                value={selectedDriver}
                onChange={(e) => setSelectedDriver(e.target.value)}
                className="w-full"
                style={inputStyle}
              >
                <option value="">{t('common.allDrivers')}</option>
                {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
                  <option key={driver.id} value={driver.name}>{driver.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="type-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {t('inc.type')}
              </label>
              <select
                id="type-filter"
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="w-full"
                style={inputStyle}
              >
                {/* The option value is the persisted `income.type`; only the label translates. */}
                <option value="">{t('inc.allTypes')}</option>
                {INCOME_TYPE_ORDER.map(type => (
                  <option key={type} value={type}>{t(INCOME_TYPE_LABELS[type])}</option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-2">
              <button
                onClick={resetFilters}
                className="flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                title={t('inc.resetFilters')}
              >
                <RefreshCw size={16} />
                <span className="hidden sm:inline">{t('inc.reset')}</span>
              </button>
              <button
                onClick={handleExport}
                disabled={filteredIncomes.length === 0}
                className="flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                style={
                  filteredIncomes.length === 0
                    ? { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }
                    : { background: 'var(--success-solid)', color: 'white' }
                }
                title={filteredIncomes.length === 0 ? t('inc.nothingToExport') : t('common.exportExcelShort')}
                aria-disabled={filteredIncomes.length === 0}
              >
                <Download size={16} />
                <span className="hidden sm:inline">Excel</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Weekly Summary by Driver — Carousel */}
      {activeDrivers.length > 0 && (
        <div className="relative">
          {activeDrivers.length > 1 && (
            <>
              <button
                onClick={() => scrollCarousel('left')}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 z-10 rounded-full p-1.5 transition-all"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}
                aria-label={t('inc.scrollLeft')}
              >
                <ChevronLeft size={18} style={{ color: 'var(--text-secondary)' }} />
              </button>
              <button
                onClick={() => scrollCarousel('right')}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 rounded-full p-1.5 transition-all"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}
                aria-label={t('inc.scrollRight')}
              >
                <ChevronRight size={18} style={{ color: 'var(--text-secondary)' }} />
              </button>
            </>
          )}
          <div
            ref={carouselRef}
            className="flex gap-4 overflow-x-auto scroll-smooth pb-2 cursor-grab select-none"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            {activeDrivers.map(driver => {
              const { nettoFahrpreis, aktionen, trinkgeld, bargeld, summe } = getWeeklyDataByDriver(driver.name);
              return (
                <div
                  key={driver.id}
                  data-card
                  className="rounded-lg p-4 flex-shrink-0 w-64 sm:w-72"
                  style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
                >
                  <div className="mb-3">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('inc.filteredPeriod')}</p>
                    <p className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>{driver.name}</p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('inc.nettoFahrpreis')}:</span>
                      <span className="font-semibold" style={{ color: 'var(--accent-text)' }}>{nettoFahrpreis.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('inc.typeAktionen')}:</span>
                      <span className="font-semibold" style={{ color: 'var(--warning)' }}>{aktionen.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('inc.typeTrinkgeld')}:</span>
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{trinkgeld.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('inc.typeBargeld')}:</span>
                      <span className="font-semibold" style={{ color: 'var(--success)' }}>{bargeld.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                      <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('inc.sum')}:</span>
                      <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{summe.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {canCreate && (
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
        >
          {!isAdding ? (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-white rounded-lg transition-colors"
              style={{ background: 'var(--success-solid)' }}
            >
              <Plus size={20} />
              {t('inc.addNew')}
            </button>
          ) : (
            <div className="space-y-5">
              {/* Form header */}
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('inc.newEntry')}</h3>
                <button onClick={cancelAdd} style={{ color: 'var(--text-tertiary)' }} title={t('common.close')}>
                  <X size={20} />
                </button>
              </div>

              {/* Shared fields: Fahrer, Datum, Woche, Beschreibung */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')} *</label>
                  <select
                    value={batchForm.driver_name}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, driver_name: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                  >
                    <option value="">{t('inc.selectDriver')}</option>
                    {drivers.filter(d => d.status !== 'inactive').map(d => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.date')} *</label>
                  <input
                    type="date"
                    value={batchForm.date}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.week')}</label>
                  <select
                    value={batchForm.week ?? ''}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, week: e.target.value ? parseInt(e.target.value) : undefined }))}
                    className="w-full"
                    style={inputStyle}
                  >
                    <option value="">{t('inc.selectWeek')}</option>
                    {availableWeeks.map(w => (
                      <option key={w.weekNumber} value={w.weekNumber}>{w.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('common.description')} <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('inc.optional')}</span>
                  </label>
                  <input
                    type="text"
                    value={batchForm.description}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                    placeholder={t('inc.descriptionPlaceholder')}
                  />
                </div>
              </div>

              {/* Divider */}
              <div style={{ borderTop: '1px solid var(--border)' }} />

              {/* Amount fields */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-tertiary)' }}>
                  {t('inc.amountsHint')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Netto-Fahrpreis → type umsatz */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('inc.nettoFahrpreisEuro')}
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.nettoFahrpreis}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, nettoFahrpreis: e.target.value }))}
                      className="w-full"
                      style={{ ...inputStyle, borderColor: batchForm.nettoFahrpreis && parseBatchAmount(batchForm.nettoFahrpreis) ? 'var(--success)' : undefined }}
                      placeholder="0,00"
                    />
                  </div>

                  {/* Aktionen → type aktionen */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('inc.aktionenEuro')}
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.aktionen}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, aktionen: e.target.value }))}
                      className="w-full"
                      style={{ ...inputStyle, borderColor: batchForm.aktionen && parseBatchAmount(batchForm.aktionen) ? 'var(--success)' : undefined }}
                      placeholder="0,00"
                    />
                  </div>

                  {/* Trinkgeld → type trinkgeld */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('inc.trinkgeldEuro')}
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.trinkgeld}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, trinkgeld: e.target.value }))}
                      className="w-full"
                      style={{ ...inputStyle, borderColor: batchForm.trinkgeld && parseBatchAmount(batchForm.trinkgeld) ? 'var(--success)' : undefined }}
                      placeholder="0,00"
                    />
                  </div>

                  {/* Bargeld → type bargeld */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('inc.bargeldEuro')}
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.bargeld}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, bargeld: e.target.value }))}
                      className="w-full"
                      style={{ ...inputStyle, borderColor: batchForm.bargeld && parseBatchAmount(batchForm.bargeld) ? 'var(--success)' : undefined }}
                      placeholder="0,00"
                    />
                  </div>
                </div>
              </div>

              {/* Anzahl Fahrten */}
              <div className="max-w-xs">
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('inc.tripCount')} <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('inc.optional')}</span>
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={batchForm.tripCount}
                  onChange={(e) => setBatchForm(prev => ({ ...prev, tripCount: e.target.value }))}
                  className="w-full"
                  style={inputStyle}
                  placeholder={t('inc.tripCountPlaceholder')}
                />
              </div>

              {/* Summary + actions */}
              {(() => {
                const willCreate = [
                  batchForm.nettoFahrpreis,
                  batchForm.aktionen,
                  batchForm.trinkgeld,
                  batchForm.bargeld,
                ].filter(v => parseBatchAmount(v) !== null).length;
                return (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1">
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                      style={{
                        background: willCreate > 0 ? 'var(--success-subtle)' : 'var(--bg-muted)',
                        color: willCreate > 0 ? 'var(--success)' : 'var(--text-tertiary)',
                        border: `1px solid ${willCreate > 0 ? 'rgba(5,150,105,0.25)' : 'var(--border)'}`,
                      }}
                    >
                      <DollarSign size={14} />
                      {willCreate > 0
                        ? tPlural({ one: 'inc.willCreate.one', other: 'inc.willCreate.other' }, willCreate)
                        : t('inc.noAmounts')}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelAdd}
                        className="px-4 py-2 rounded-lg text-sm transition-colors"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        onClick={handleBatchAdd}
                        disabled={willCreate === 0}
                        className="flex items-center gap-2 px-5 py-2 text-white rounded-lg text-sm font-semibold transition-opacity"
                        style={{ background: 'var(--success-solid)', opacity: willCreate === 0 ? 0.5 : 1, cursor: willCreate === 0 ? 'not-allowed' : 'pointer' }}
                      >
                        <Save size={15} />
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Income Table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--bg-subtle)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.date')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.week')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.driver')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('inc.type')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.description')}</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.amount')}</th>
                {/* Column header = "Actions". Not the `aktionen` income type, which
                    keeps its German name — see INCOME_TYPE_LABELS. */}
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('inc.tableActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredIncomes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    {t('inc.noEntries')}
                  </td>
                </tr>
              ) : (
                filteredIncomes.map((income) => (
                  <tr
                    key={income.id}
                    style={{
                      background: hoveredRow === income.id ? 'var(--bg-subtle)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                      transition: 'background 0.15s'
                    }}
                    onMouseEnter={() => setHoveredRow(income.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                  >
                    {editingId === income.id ? (
                      <>
                        <td className="px-6 py-4">
                          <input
                            type="date"
                            value={formData.date}
                            onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <select
                            value={formData.week || ''}
                            onChange={(e) => setFormData({ ...formData, week: parseInt(e.target.value) })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          >
                            <option value="">-</option>
                            {availableWeeks.map(week => (
                              <option key={week.weekNumber} value={week.weekNumber}>
                                W{week.weekNumber}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-6 py-4">
                          <select
                            value={formData.driver_name}
                            onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          >
                            {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
                              <option key={driver.id} value={driver.name}>{driver.name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-6 py-4">
                          <select
                            value={formData.type}
                            onChange={(e) => setFormData({ ...formData, type: e.target.value as IncomeType })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          >
                            {/* The option value is the persisted `income.type`. */}
                            {INCOME_TYPE_ORDER.map(type => (
                              <option key={type} value={type}>{t(INCOME_TYPE_LABELS[type])}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-6 py-4">
                          <input
                            type="text"
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <input
                            type="number"
                            step="0.01"
                            value={formData.amount}
                            onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                            className="w-full px-2 py-1 text-right"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem', textAlign: 'right' }}
                          />
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => handleUpdate(income.id)}
                              style={{ color: 'var(--success)' }}
                              title={t('common.save')}
                            >
                              <Check size={18} />
                            </button>
                            <button
                              onClick={cancelEdit}
                              style={{ color: 'var(--text-secondary)' }}
                              title={t('common.cancel')}
                            >
                              <X size={18} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                          {format(new Date(income.date), 'dd.MM.yyyy')}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                          {income.week ? t('inc.weekLabel', { week: income.week }) : '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                          {income.driver_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span
                            className="px-2 py-1 rounded-full text-xs font-medium"
                            style={
                              income.type === 'bargeld' ? { background: 'var(--success-subtle)', color: 'var(--success)' } :
                              income.type === 'umsatz' ? { background: 'var(--accent-subtle)', color: 'var(--accent-text)' } :
                              income.type === 'aktionen' ? { background: 'var(--warning-subtle)', color: 'var(--warning)' } :
                              { background: 'var(--bg-muted)', color: 'var(--text-secondary)' }
                            }
                          >
                            {t(INCOME_TYPE_LABELS[income.type] ?? INCOME_TYPE_LABELS.trinkgeld)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {income.description}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold" style={{ color: 'var(--success)' }}>
                          {Number(income.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          {/* Unreachable: 'nettofahrt' is not in IncomeType
                              ('bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen'),
                              so this suffix has never rendered. Left disabled
                              rather than repointed — trip_count is populated on
                              all four types in production, so the data does not
                              say which one was meant, and guessing would switch
                              on a suffix across 266 rows of a money screen.
                              TS2367 marks it until someone decides. */}
                          {income.type === 'nettofahrt' && income.trip_count != null && (
                            <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-tertiary)' }}>
                              {t('inc.tripsSuffix', { count: income.trip_count })}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          <div className="flex justify-end gap-2">
                            {canEdit(income.created_by) && (
                              <button
                                onClick={() => startEdit(income)}
                                style={{ color: 'var(--accent)' }}
                                title={t('common.edit')}
                              >
                                <Edit2 size={18} />
                              </button>
                            )}
                            {canDelete(income.created_by) && (
                              <button
                                onClick={() => confirmDelete(income.id)}
                                style={{ color: 'var(--danger)' }}
                                title={t('common.delete')}
                              >
                                <Trash2 size={18} />
                              </button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}
      >
        <p className="text-sm" style={{ color: 'var(--accent-text)' }}>
          <strong>{t('inc.noteLabel')}</strong> {t('inc.noteBody')}
        </p>
      </div>

      <ConfirmationModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title={t('inc.deleteTitle')}
        message={t('inc.deleteMessage')}
        type="confirm"
      />
    </div>
  );
};

export default IncomeManagement;
