import React, { useState, useEffect } from 'react';
import { Check, Download, Info, Pencil, Plus, RefreshCw, Save, Trash2, TrendingUp, Users, X } from 'lucide-react';
import { Income, IncomeFormData, Driver, INCOME_TYPES } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useToast } from '../contexts/ToastContext';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, subMonths, getMonth, getYear } from 'date-fns';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportIncomeToExcel } from '../utils/excelExport';
import { getWeeksOfMonth, getWeekNumberForDate, WeekOfMonth, getBusinessMonthRange, getBusinessWeekRange } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  ConfirmDialog,
  DataTable,
  EmptyState,
  formatDate,
  Field,
  formatEuro,
  Input,
  KpiCard,
  NativeSelect,
  PageHeader,
  Tooltip,
  type DataTableColumn,
} from './ui';

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
  const [loadFailed, setLoadFailed] = useState(false);
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

  const { user, profile } = useAuth();
  // The rights of the company the session is in — see BelegePage.
  const { canEdit, canDelete, canCreate } = useCompanyScope();
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
      setLoadFailed(false);
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
      setLoadFailed(true);
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

  const activeDrivers = drivers.filter(driver => driver.status !== 'inactive');

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, less three pieces
  // that only drew: the hover-row state, the inline input style object, and the
  // driver carousel's drag-to-scroll refs and handlers (they wrote the
  // carousel's cursor and scroll position, nothing else). The carousel is a
  // table now, and each of its rows is getWeeklyDataByDriver()'s answer for one
  // active driver, as each card was. Every amount on screen goes through
  // utils/money.ts; this block adds no arithmetic. Everything below only draws.
  //
  // One addition to the logic, and only the lines the rule allows (CLAUDE.md,
  // "A figure whose load failed is not shown"): a `loadFailed` state, cleared
  // where loadIncomes starts and set in its existing catch. A failed read of the
  // entries — the database reachable, so the page's isConnected check passes —
  // otherwise left 0,00 € and "no entries" on screen, or after a write the list
  // as it was before the write; now the total, the per-driver figures and the
  // export are withheld and the table says it could not load.

  // formatEuro refuses a value that is not a finite amount; a figure shows it as
  // it is rather than taking the screen down, as DataTable does for its cells.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  const INCOME_TYPE_TONE: Record<IncomeType, 'positive' | 'brand' | 'caution' | 'neutral'> = {
    bargeld: 'positive',
    umsatz: 'brand',
    aktionen: 'caution',
    trinkgeld: 'neutral',
  };

  const typeBadge = (income: Income) => (
    <Badge tone={INCOME_TYPE_TONE[income.type as IncomeType] ?? 'neutral'}>
      {t(INCOME_TYPE_LABELS[income.type] ?? INCOME_TYPE_LABELS.trinkgeld)}
    </Badge>
  );

  const weekText = (income: Income) => (income.week ? t('inc.weekLabel', { week: income.week }) : '-');

  // ── The row being edited. Each field is written once and placed twice: in its
  // own column from md up, stacked under the driver below it, so a phone edits
  // every field the old table offered.
  const editDate = () => (
    <Input
      type="date"
      value={formData.date}
      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
      aria-label={t('common.date')}
      size={1}
    />
  );
  const editWeek = () => (
    <NativeSelect
      value={formData.week || ''}
      onChange={(e) => setFormData({ ...formData, week: parseInt(e.target.value) })}
      aria-label={t('common.week')}
      // In its own column the table would squeeze it to its chevron.
      containerClassName="md:min-w-[5.5rem]"
    >
      <option value="">-</option>
      {availableWeeks.map(week => (
        <option key={week.weekNumber} value={week.weekNumber}>
          W{week.weekNumber}
        </option>
      ))}
    </NativeSelect>
  );
  const editDriver = () => (
    <NativeSelect
      value={formData.driver_name}
      onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
      aria-label={t('common.driver')}
    >
      {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
        <option key={driver.id} value={driver.name}>{driver.name}</option>
      ))}
    </NativeSelect>
  );
  const editType = () => (
    <NativeSelect
      value={formData.type}
      onChange={(e) => setFormData({ ...formData, type: e.target.value as IncomeType })}
      aria-label={t('inc.type')}
      containerClassName="md:min-w-[8.5rem]"
    >
      {/* The option value is the persisted `income.type`. */}
      {INCOME_TYPE_ORDER.map(type => (
        <option key={type} value={type}>{t(INCOME_TYPE_LABELS[type])}</option>
      ))}
    </NativeSelect>
  );
  const editDescription = () => (
    <Input
      type="text"
      value={formData.description}
      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
      aria-label={t('common.description')}
      size={1}
    />
  );
  const editAmount = () => (
    <Input
      type="number"
      step="0.01"
      value={formData.amount}
      onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
      aria-label={t('common.amount')}
      className="ml-auto w-[6.5rem] text-right sm:w-32"
    />
  );

  const columns: DataTableColumn<Income>[] = [
    {
      id: 'date',
      header: t('common.date'),
      kind: 'date',
      value: income => income.date,
      sortable: true,
      cell: income => (editingId === income.id ? editDate() : <span className="whitespace-nowrap tabular-nums">{formatDate(income.date)}</span>),
      hideBelow: 'md',
    },
    {
      id: 'week',
      header: t('common.week'),
      value: income => income.week ?? null,
      cell: income => (editingId === income.id ? editWeek() : <span className="whitespace-nowrap">{weekText(income)}</span>),
      hideBelow: 'md',
    },
    {
      id: 'driver',
      header: t('common.driver'),
      value: income => income.driver_name,
      sortable: true,
      cell: income =>
        editingId === income.id ? (
          <span className="grid gap-2 py-2 md:min-w-[11rem]">
            {editDriver()}
            {/* On a phone the amount comes along too: beside the stack it left
                no room for the save and cancel buttons. */}
            <span className="grid gap-2 md:hidden">
              {editDate()}
              {editWeek()}
              {editType()}
              {editDescription()}
              {editAmount()}
            </span>
          </span>
        ) : (
          <span className="grid min-w-0 gap-0.5 py-2">
            <span className="font-medium text-fg">{income.driver_name}</span>
            {/* A phone hides the date, week, type and description columns; their values move here. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-muted md:hidden">
              <span className="tabular-nums">{formatDate(income.date)}</span>
              {typeBadge(income)}
            </span>
            {income.description ? <span className="text-[13px] text-fg-subtle md:hidden">{income.description}</span> : null}
          </span>
        ),
      // At 375 px the driver, the amount and both row actions share the width.
      className: 'pl-3 pr-1 sm:px-4',
    },
    {
      id: 'type',
      header: t('inc.type'),
      value: income => income.type,
      sortable: true,
      cell: income => (editingId === income.id ? editType() : typeBadge(income)),
      hideBelow: 'md',
    },
    {
      id: 'description',
      header: t('common.description'),
      value: income => income.description,
      cell: income => (editingId === income.id ? editDescription() : income.description),
      hideBelow: 'md',
      className: 'min-w-[10rem]',
    },
    {
      id: 'amount',
      header: t('common.amount'),
      kind: 'currency',
      value: income => Number(income.amount),
      sortable: true,
      cell: income =>
        editingId === income.id ? (
          <span className="hidden md:block">{editAmount()}</span>
        ) : (
          <>
            {euro(Number(income.amount))}
            {/* Unreachable: 'nettofahrt' is not in IncomeType
                ('bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen'),
                so this suffix has never rendered. Left disabled
                rather than repointed — trip_count is populated on
                all four types in production, so the data does not
                say which one was meant, and guessing would switch
                on a suffix across 266 rows of a money screen.
                TS2367 marks it until someone decides. */}
            {income.type === 'nettofahrt' && income.trip_count != null && (
              <span className="ml-2 text-xs font-normal text-fg-subtle">
                {t('inc.tripsSuffix', { count: income.trip_count })}
              </span>
            )}
          </>
        ),
      className: 'pl-1 pr-2 sm:px-4',
    },
  ];

  // A read context, or a role without the right, writes nothing (plan 3.4b):
  // the actions it may not use are not offered at all.
  const anyRowWritable = filteredIncomes.some(income => canEdit(income.created_by) || canDelete(income.created_by));

  const rowActions = (income: Income) =>
    editingId === income.id ? (
      <>
        <Tooltip content={t('common.save')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-positive"
            aria-label={t('inc.saveEntryAria', { driver: income.driver_name })}
            onClick={() => handleUpdate(income.id)}
          >
            <Check aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip content={t('common.cancel')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('inc.cancelEditAria', { driver: income.driver_name })}
            onClick={cancelEdit}
          >
            <X aria-hidden />
          </Button>
        </Tooltip>
      </>
    ) : (
      <>
        {canEdit(income.created_by) && (
          <Tooltip content={t('common.edit')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('inc.editEntryAria', { driver: income.driver_name, date: formatDate(income.date) })}
              onClick={() => startEdit(income)}
            >
              <Pencil aria-hidden />
            </Button>
          </Tooltip>
        )}
        {canDelete(income.created_by) && (
          <Tooltip content={t('common.delete')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:text-critical"
              aria-label={t('inc.deleteEntryAria', { driver: income.driver_name, date: formatDate(income.date) })}
              onClick={() => confirmDelete(income.id)}
            >
              <Trash2 aria-hidden />
            </Button>
          </Tooltip>
        )}
      </>
    );

  // One row per active driver: getWeeklyDataByDriver() above, as each card was.
  const driverSummaries = activeDrivers.map(driver => ({ driver, ...getWeeklyDataByDriver(driver.name) }));
  type DriverSummary = (typeof driverSummaries)[number];

  const summaryColumns: DataTableColumn<DriverSummary>[] = [
    {
      id: 'driver',
      header: t('common.driver'),
      value: row => row.driver.name,
      sortable: true,
      cell: row => <span className="font-medium text-fg">{row.driver.name}</span>,
      className: 'pl-3 pr-1 sm:px-4',
    },
    { id: 'netto', header: t('inc.nettoFahrpreis'), kind: 'currency', value: row => row.nettoFahrpreis, sortable: true, className: 'px-2 sm:px-4' },
    { id: 'aktionen', header: t('inc.typeAktionen'), kind: 'currency', value: row => row.aktionen, sortable: true, hideBelow: 'md' },
    { id: 'trinkgeld', header: t('inc.typeTrinkgeld'), kind: 'currency', value: row => row.trinkgeld, sortable: true, hideBelow: 'md' },
    { id: 'bargeld', header: t('inc.typeBargeld'), kind: 'currency', value: row => row.bargeld, sortable: true, hideBelow: 'sm' },
    {
      id: 'summe',
      header: t('inc.sum'),
      kind: 'currency',
      value: row => row.summe,
      sortable: true,
      cell: row => <span className="font-semibold">{euro(row.summe)}</span>,
      className: 'pl-2 pr-3 sm:px-4',
    },
  ];

  const header = (actions?: React.ReactNode) => (
    <PageHeader title={t('nav.umsaetze')} description={t('inc.subtitle')} actions={actions} />
  );

  if (loading) {
    return (
      <div className="font-ui">
        {header()}
        <div className="grid grid-cols-1 gap-4">
          <KpiCard label={t('inc.totalFiltered')} value="" loading className="sm:max-w-sm" />
          <DataTable caption={t('inc.tableCaption')} columns={columns} rows={[]} getRowId={income => income.id} loading />
        </div>
      </div>
    );
  }

  const addButton = (size?: 'sm') =>
    canCreate && !isAdding ? (
      <Button size={size} onClick={() => setIsAdding(true)}>
        <Plus aria-hidden />
        {t('inc.addNew')}
      </Button>
    ) : undefined;

  const presetGroupLabelId = 'income-preset-label';

  return (
    <div className="font-ui">
      {header(
        <>
          <Button
            variant="secondary"
            onClick={handleExport}
            disabled={filteredIncomes.length === 0 || loadFailed}
            title={filteredIncomes.length === 0 ? t('inc.nothingToExport') : t('common.exportExcelShort')}
            aria-disabled={filteredIncomes.length === 0 || loadFailed}
          >
            <Download aria-hidden />
            {t('common.exportExcelShort')}
          </Button>
          {addButton()}
        </>,
      )}

      {/* grid-cols-1 is minmax(0, 1fr): a bare grid sizes its column to the
          widest child's content, and the tables alone would push the page past
          375 px. */}
      <div className="grid grid-cols-1 gap-4">
        {!loadFailed && (
          <KpiCard
            label={t('inc.totalFiltered')}
            value={euro(totalIncome)}
            icon={TrendingUp}
            caption={t('inc.entriesOf', { shown: filteredIncomes.length, total: incomes.length })}
            className="sm:max-w-sm"
          />
        )}

        {/* Date range and filters */}
        <Card>
          <CardContent className="grid gap-4 pt-5">
            <div role="group" aria-labelledby={presetGroupLabelId} className="grid gap-2">
              <p id={presetGroupLabelId} className="text-[13px] font-medium text-fg-muted">{t('inc.period')}</p>
              <div className="flex flex-wrap gap-1 rounded-control bg-sunken p-0.5">
                {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((preset) => {
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => handlePresetChange(preset)}
                      aria-pressed={datePreset === preset}
                      className={cn(
                        'h-8 whitespace-nowrap rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium transition-colors [@media(pointer:coarse)]:h-10',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
                        datePreset === preset ? 'bg-raised text-fg shadow-raised' : 'text-fg-muted hover:text-fg',
                      )}
                    >
                      {t(DATE_PRESET_LABELS[preset])}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
              <Field label={t('common.dateFrom')}>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value);
                    setDatePreset('custom');
                  }}
                />
              </Field>
              <Field label={t('common.dateTo')}>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setDatePreset('custom');
                  }}
                />
              </Field>
              <Field label={t('common.driver')}>
                <NativeSelect
                  value={selectedDriver}
                  onChange={(e) => setSelectedDriver(e.target.value)}
                >
                  <option value="">{t('common.allDrivers')}</option>
                  {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
                    <option key={driver.id} value={driver.name}>{driver.name}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('inc.type')}>
                <NativeSelect
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                >
                  {/* The option value is the persisted `income.type`; only the label translates. */}
                  <option value="">{t('inc.allTypes')}</option>
                  {INCOME_TYPE_ORDER.map(type => (
                    <option key={type} value={type}>{t(INCOME_TYPE_LABELS[type])}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Button variant="secondary" onClick={resetFilters} title={t('inc.resetFilters')}>
                <RefreshCw aria-hidden />
                {t('inc.reset')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {canCreate && isAdding && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t('inc.newEntry')}</CardTitle>
              <Button variant="ghost" size="icon-sm" onClick={cancelAdd} aria-label={t('common.close')}>
                <X aria-hidden />
              </Button>
            </CardHeader>
            <CardContent className="grid gap-5">
              {/* Shared fields: Fahrer, Datum, Woche, Beschreibung */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label={t('common.driver')} required>
                  <NativeSelect
                    value={batchForm.driver_name}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, driver_name: e.target.value }))}
                  >
                    <option value="">{t('inc.selectDriver')}</option>
                    {drivers.filter(d => d.status !== 'inactive').map(d => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </NativeSelect>
                </Field>

                <Field label={t('common.date')} required>
                  <Input
                    type="date"
                    value={batchForm.date}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, date: e.target.value }))}
                  />
                </Field>

                <Field label={t('common.week')}>
                  <NativeSelect
                    value={batchForm.week ?? ''}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, week: e.target.value ? parseInt(e.target.value) : undefined }))}
                  >
                    <option value="">{t('inc.selectWeek')}</option>
                    {availableWeeks.map(w => (
                      <option key={w.weekNumber} value={w.weekNumber}>{w.label}</option>
                    ))}
                  </NativeSelect>
                </Field>

                <Field label={<>{t('common.description')} <span className="font-normal text-fg-subtle">{t('inc.optional')}</span></>}>
                  <Input
                    type="text"
                    value={batchForm.description}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder={t('inc.descriptionPlaceholder')}
                  />
                </Field>
              </div>

              {/* Amount fields */}
              <fieldset className="grid gap-3 border-t border-line pt-4">
                <legend className="float-left w-full text-[13px] font-medium text-fg-muted">{t('inc.amountsHint')}</legend>
                <div className="clear-both grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {/* Netto-Fahrpreis → type umsatz */}
                  <Field label={t('inc.nettoFahrpreisEuro')}>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.nettoFahrpreis}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, nettoFahrpreis: e.target.value }))}
                      className={cn('tabular-nums', batchForm.nettoFahrpreis && parseBatchAmount(batchForm.nettoFahrpreis) && 'border-positive')}
                      placeholder="0,00"
                    />
                  </Field>

                  {/* Aktionen → type aktionen */}
                  <Field label={t('inc.aktionenEuro')}>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.aktionen}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, aktionen: e.target.value }))}
                      className={cn('tabular-nums', batchForm.aktionen && parseBatchAmount(batchForm.aktionen) && 'border-positive')}
                      placeholder="0,00"
                    />
                  </Field>

                  {/* Trinkgeld → type trinkgeld */}
                  <Field label={t('inc.trinkgeldEuro')}>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.trinkgeld}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, trinkgeld: e.target.value }))}
                      className={cn('tabular-nums', batchForm.trinkgeld && parseBatchAmount(batchForm.trinkgeld) && 'border-positive')}
                      placeholder="0,00"
                    />
                  </Field>

                  {/* Bargeld → type bargeld */}
                  <Field label={t('inc.bargeldEuro')}>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={batchForm.bargeld}
                      onChange={(e) => setBatchForm(prev => ({ ...prev, bargeld: e.target.value }))}
                      className={cn('tabular-nums', batchForm.bargeld && parseBatchAmount(batchForm.bargeld) && 'border-positive')}
                      placeholder="0,00"
                    />
                  </Field>
                </div>
              </fieldset>

              {/* Anzahl Fahrten */}
              <Field
                label={<>{t('inc.tripCount')} <span className="font-normal text-fg-subtle">{t('inc.optional')}</span></>}
                className="max-w-xs"
              >
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={batchForm.tripCount}
                  onChange={(e) => setBatchForm(prev => ({ ...prev, tripCount: e.target.value }))}
                  placeholder={t('inc.tripCountPlaceholder')}
                />
              </Field>

              {/* Summary + actions */}
              {(() => {
                const willCreate = [
                  batchForm.nettoFahrpreis,
                  batchForm.aktionen,
                  batchForm.trinkgeld,
                  batchForm.bargeld,
                ].filter(v => parseBatchAmount(v) !== null).length;
                return (
                  <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p role="status" className={cn('text-sm', willCreate > 0 ? 'font-medium text-positive' : 'text-fg-subtle')}>
                      {willCreate > 0
                        ? tPlural({ one: 'inc.willCreate.one', other: 'inc.willCreate.other' }, willCreate)
                        : t('inc.noAmounts')}
                    </p>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row">
                      <Button variant="secondary" onClick={cancelAdd}>
                        {t('common.cancel')}
                      </Button>
                      <Button onClick={handleBatchAdd} disabled={willCreate === 0}>
                        <Save aria-hidden />
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        )}

        {/* The period's figures per driver: Summe is Netto-Fahrpreis plus Aktionen. */}
        {activeDrivers.length > 0 && !loadFailed && (
          <section aria-labelledby="income-per-driver" className="grid gap-2">
            <h2 id="income-per-driver" className="text-[15px] font-semibold text-fg">
              {t('inc.perDriverTitle')}
              <span className="ml-2 text-[13px] font-normal text-fg-subtle">{t('inc.perDriverHint')}</span>
            </h2>
            <DataTable
              caption={t('inc.perDriverTitle')}
              columns={summaryColumns}
              rows={driverSummaries}
              getRowId={row => row.driver.id}
              density="compact"
            />
          </section>
        )}

        <DataTable
          caption={t('inc.tableCaption')}
          columns={columns}
          rows={filteredIncomes}
          getRowId={income => income.id}
          error={loadFailed}
          rowActions={anyRowWritable || editingId ? rowActions : undefined}
          rowActionsLabel={t('inc.tableActions')}
          emptyState={
            <EmptyState size="sm" icon={Users} title={t('inc.noEntries')} action={addButton('sm')} />
          }
        />

        <p className="flex items-start gap-2 text-[13px] text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <span>
            <span className="font-semibold text-fg">{t('inc.noteLabel')}</span> {t('inc.noteBody')}
          </span>
        </p>
      </div>

      <ConfirmDialog
        open={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title={t('inc.deleteTitle')}
        description={t('inc.deleteMessage')}
        confirmLabel={t('common.delete')}
        icon={Trash2}
      />
    </div>
  );
};

export default IncomeManagement;
