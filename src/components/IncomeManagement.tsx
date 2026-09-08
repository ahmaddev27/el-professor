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

interface IncomeManagementProps {
  drivers: Driver[];
}

type DatePreset = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';

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

  const { user, profile, canEdit, canDelete, canCreate, companyId } = useAuth();
  const { success, error: showError, warning } = useToast();
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
      showError('Fehler beim Laden', handleDatabaseError(err));
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
      warning('Keine Daten', 'Es gibt keine Daten zum Exportieren');
      return;
    }
    exportIncomeToExcel(filteredIncomes, fromDate, toDate);
    success('Export erfolgreich', 'Die Daten wurden als Excel-Datei exportiert');
  };

  const parseBatchAmount = (val: string) => {
    // Accept both comma and dot as decimal separator
    const normalized = val.trim().replace(',', '.');
    const n = parseFloat(normalized);
    return isNaN(n) || n <= 0 ? null : n;
  };

  const handleBatchAdd = async () => {
    if (!canCreate) {
      showError('Keine Berechtigung', 'Nur Administratoren und Ersteller können Einnahmen hinzufügen');
      return;
    }
    if (!batchForm.driver_name) {
      warning('Fehlende Angaben', 'Bitte wählen Sie einen Fahrer aus');
      return;
    }

    const amounts: { type: 'umsatz' | 'aktionen' | 'trinkgeld' | 'bargeld'; amount: number }[] = [];
    const netto = parseBatchAmount(batchForm.nettoFahrpreis);
    const akt   = parseBatchAmount(batchForm.aktionen);
    const tkg   = parseBatchAmount(batchForm.trinkgeld);
    const bar   = parseBatchAmount(batchForm.bargeld);

    if (netto) amounts.push({ type: 'umsatz',    amount: netto });
    if (akt)   amounts.push({ type: 'aktionen',  amount: akt });
    if (tkg)   amounts.push({ type: 'trinkgeld', amount: tkg });
    if (bar)   amounts.push({ type: 'bargeld',   amount: bar });

    if (amounts.length === 0) {
      warning('Fehlende Angaben', 'Mindestens ein Betrag muss größer als 0 sein');
      return;
    }

    const rawTripCount = batchForm.tripCount.trim();
    let tripCount: number | null = null;
    if (rawTripCount !== '') {
      const tc = parseInt(rawTripCount, 10);
      if (isNaN(tc) || tc < 0) {
        warning('Ungültige Eingabe', 'Anzahl Fahrten muss eine nicht-negative ganze Zahl sein');
        return;
      }
      tripCount = tc;
    }

    if (!profile?.id) {
      showError('Fehler', 'Benutzerprofil nicht geladen');
      return;
    }

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
          'Einnahmen gespeichert',
          `${rows.length} Einträge wurden gespeichert, sind aber durch die aktuellen Filter nicht sichtbar.`
        );
      } else {
        success('Einnahmen erstellt', `${rows.length} Einträge erfolgreich gespeichert`);
      }
    } catch (err: any) {
      console.error('Error adding incomes:', err);
      showError('Fehler beim Erstellen', handleDatabaseError(err));
    }
  };

  const handleUpdate = async (id: string) => {
    if (!formData.amount || !formData.driver_name) {
      warning('Fehlende Angaben', 'Bitte füllen Sie Betrag und Fahrer aus');
      return;
    }

    try {
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
      success('Einnahme aktualisiert', 'Die Einnahme wurde erfolgreich geändert');
    } catch (err: any) {
      console.error('Error updating income:', err);
      showError('Fehler beim Aktualisieren', handleDatabaseError(err));
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
      success('Einnahme gelöscht', 'Die Einnahme wurde erfolgreich entfernt');
      setDeleteConfirm({ isOpen: false, id: null });
    } catch (err: any) {
      console.error('Error deleting income:', err);
      showError('Fehler beim Löschen', handleDatabaseError(err));
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
              <h1 className="text-3xl font-bold">Umsätze hinzufügen</h1>
              <p className="text-green-100 mt-1">Wöchentliche Einnahmen pro Fahrer verwalten</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-green-100">Gesamteinnahmen (gefiltert)</p>
            <p className="text-3xl font-bold">{totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            <p className="text-xs text-green-200 mt-1">{filteredIncomes.length} von {incomes.length} Einträgen</p>
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
            {(['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'custom'] as DatePreset[]).map((preset) => {
              const labels: Record<DatePreset, string> = {
                thisWeek: 'Diese Woche',
                lastWeek: 'Letzte Woche',
                thisMonth: 'Dieser Monat',
                lastMonth: 'Letzter Monat',
                thisYear: 'Dieses Jahr',
                custom: 'Benutzerdefiniert'
              };
              return (
                <button
                  key={preset}
                  onClick={() => handlePresetChange(preset)}
                  className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={
                    datePreset === preset
                      ? { background: 'var(--success)', color: 'white' }
                      : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }
                  }
                >
                  {labels[preset]}
                </button>
              );
            })}
          </div>

          {/* Date Range Inputs and Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label htmlFor="from-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Von Datum
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
                  aria-label="Von Datum"
                />
              </div>
            </div>

            <div>
              <label htmlFor="to-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Bis Datum
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
                  aria-label="Bis Datum"
                />
              </div>
            </div>

            <div>
              <label htmlFor="driver-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Fahrer
              </label>
              <select
                id="driver-filter"
                value={selectedDriver}
                onChange={(e) => setSelectedDriver(e.target.value)}
                className="w-full"
                style={inputStyle}
              >
                <option value="">Alle Fahrer</option>
                {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
                  <option key={driver.id} value={driver.name}>{driver.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="type-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Typ
              </label>
              <select
                id="type-filter"
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="w-full"
                style={inputStyle}
              >
                <option value="">Alle Typen</option>
                <option value="bargeld">Bargeld</option>
                <option value="umsatz">Umsatz</option>
                <option value="aktionen">Aktionen</option>
                <option value="trinkgeld">Trinkgeld</option>
              </select>
            </div>

            <div className="flex items-end gap-2">
              <button
                onClick={resetFilters}
                className="flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                title="Filter zurücksetzen"
              >
                <RefreshCw size={16} />
                <span className="hidden sm:inline">Zurücksetzen</span>
              </button>
              <button
                onClick={handleExport}
                disabled={filteredIncomes.length === 0}
                className="flex-1 px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                style={
                  filteredIncomes.length === 0
                    ? { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }
                    : { background: 'var(--success)', color: 'white' }
                }
                title={filteredIncomes.length === 0 ? 'Keine Daten zum Exportieren' : 'Als Excel exportieren'}
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
                aria-label="Nach links scrollen"
              >
                <ChevronLeft size={18} style={{ color: 'var(--text-secondary)' }} />
              </button>
              <button
                onClick={() => scrollCarousel('right')}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 rounded-full p-1.5 transition-all"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}
                aria-label="Nach rechts scrollen"
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
                    <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Gefilterte Periode</p>
                    <p className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>{driver.name}</p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Netto-Fahrpreis:</span>
                      <span className="font-semibold" style={{ color: 'var(--accent-text)' }}>{nettoFahrpreis.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Aktionen:</span>
                      <span className="font-semibold" style={{ color: 'var(--warning)' }}>{aktionen.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Trinkgeld:</span>
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{trinkgeld.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Bargeld:</span>
                      <span className="font-semibold" style={{ color: 'var(--success)' }}>{bargeld.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </div>
                    <div className="flex justify-between items-center pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                      <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Summe:</span>
                      <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{summe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
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
              style={{ background: 'var(--success)' }}
            >
              <Plus size={20} />
              Neue Einnahme hinzufügen
            </button>
          ) : (
            <div className="space-y-5">
              {/* Form header */}
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Neue Einnahme</h3>
                <button onClick={cancelAdd} style={{ color: 'var(--text-tertiary)' }} title="Schließen">
                  <X size={20} />
                </button>
              </div>

              {/* Shared fields: Fahrer, Datum, Woche, Beschreibung */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Fahrer *</label>
                  <select
                    value={batchForm.driver_name}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, driver_name: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                  >
                    <option value="">Fahrer auswählen</option>
                    {drivers.filter(d => d.status !== 'inactive').map(d => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Datum *</label>
                  <input
                    type="date"
                    value={batchForm.date}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Woche</label>
                  <select
                    value={batchForm.week ?? ''}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, week: e.target.value ? parseInt(e.target.value) : undefined }))}
                    className="w-full"
                    style={inputStyle}
                  >
                    <option value="">Woche auswählen</option>
                    {availableWeeks.map(w => (
                      <option key={w.weekNumber} value={w.weekNumber}>{w.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Beschreibung <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={batchForm.description}
                    onChange={(e) => setBatchForm(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full"
                    style={inputStyle}
                    placeholder="z.B. Wocheneinnahmen"
                  />
                </div>
              </div>

              {/* Divider */}
              <div style={{ borderTop: '1px solid var(--border)' }} />

              {/* Amount fields */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-tertiary)' }}>
                  Beträge — nur ausgefüllte Felder werden gespeichert
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Netto-Fahrpreis → type umsatz */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      Netto-Fahrpreis (€)
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
                      Aktionen (€)
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
                      Trinkgeld (€)
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
                      Bargeld (€)
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
                  Anzahl Fahrten <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>(optional)</span>
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={batchForm.tripCount}
                  onChange={(e) => setBatchForm(prev => ({ ...prev, tripCount: e.target.value }))}
                  className="w-full"
                  style={inputStyle}
                  placeholder="z.B. 12"
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
                        ? `Es werden ${willCreate} ${willCreate === 1 ? 'Eintrag' : 'Einträge'} erstellt.`
                        : 'Keine Beträge eingegeben.'}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelAdd}
                        className="px-4 py-2 rounded-lg text-sm transition-colors"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                      >
                        Abbrechen
                      </button>
                      <button
                        onClick={handleBatchAdd}
                        disabled={willCreate === 0}
                        className="flex items-center gap-2 px-5 py-2 text-white rounded-lg text-sm font-semibold transition-opacity"
                        style={{ background: 'var(--success)', opacity: willCreate === 0 ? 0.5 : 1, cursor: willCreate === 0 ? 'not-allowed' : 'pointer' }}
                      >
                        <Save size={15} />
                        Speichern
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
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Datum</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Woche</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Fahrer</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Typ</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Beschreibung</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Betrag</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {filteredIncomes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    Keine Einträge für den ausgewählten Zeitraum
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
                            onChange={(e) => setFormData({ ...formData, type: e.target.value as 'bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen' })}
                            className="w-full px-2 py-1"
                            style={{ ...inputStyle, padding: '0.25rem 0.5rem' }}
                          >
                            <option value="bargeld">Bargeld</option>
                            <option value="umsatz">Umsatz</option>
                            <option value="aktionen">Aktionen</option>
                            <option value="trinkgeld">Trinkgeld</option>
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
                              title="Speichern"
                            >
                              <Check size={18} />
                            </button>
                            <button
                              onClick={cancelEdit}
                              style={{ color: 'var(--text-secondary)' }}
                              title="Abbrechen"
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
                          {income.week ? `Woche ${income.week}` : '-'}
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
                            {income.type === 'bargeld' ? 'Bargeld' :
                             income.type === 'umsatz' ? 'Umsatz' :
                             income.type === 'aktionen' ? 'Aktionen' :
                             'Trinkgeld'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {income.description}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold" style={{ color: 'var(--success)' }}>
                          {Number(income.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          {income.type === 'nettofahrt' && income.trip_count != null && (
                            <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-tertiary)' }}>
                              ({income.trip_count} Fahrten)
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          <div className="flex justify-end gap-2">
                            {canEdit(income.created_by) && (
                              <button
                                onClick={() => startEdit(income)}
                                style={{ color: 'var(--accent)' }}
                                title="Bearbeiten"
                              >
                                <Edit2 size={18} />
                              </button>
                            )}
                            {canDelete(income.created_by) && (
                              <button
                                onClick={() => confirmDelete(income.id)}
                                style={{ color: 'var(--danger)' }}
                                title="Löschen"
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
          <strong>Hinweis:</strong> Einnahmen werden wöchentlich pro Fahrer erfasst. Die Typen sind: Bargeld (Cash), Umsatz (Revenue) und Trinkgeld (Tips).
        </p>
      </div>

      <ConfirmationModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title="Einnahme löschen"
        message="Möchten Sie diese Einnahme wirklich löschen?"
        type="warning"
      />
    </div>
  );
};

export default IncomeManagement;
