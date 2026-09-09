import React, { useState, useEffect } from 'react';
import { DollarSign, Download, Calendar, RefreshCw, CheckCircle, XCircle, Eye, FileText } from 'lucide-react';
import { Driver, Income, Salary, SalaryCalculation } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { format, getMonth, getYear } from 'date-fns';
import ConfirmationModal from './ConfirmationModal';
import SalaryDetailsModal from './SalaryDetailsModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import { exportSalariesToExcel } from '../utils/excelExport';
import { getBusinessMonthRange } from '../utils/weekCalculations';
import { generateDriverSalaryPdf } from '../utils/driverSalaryPdf';

interface SalariesManagementProps {
  drivers: Driver[];
}

const SalariesManagement: React.FC<SalariesManagementProps> = ({ drivers }) => {
  const [salaries, setSalaries] = useState<Salary[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [calculations, setCalculations] = useState<SalaryCalculation[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters - using business month
  const now = new Date();
  const currentBusinessMonth = getMonth(now);
  const currentBusinessYear = getYear(now);
  const initialBusinessRange = getBusinessMonthRange(currentBusinessMonth, currentBusinessYear);

  const [selectedMonth, setSelectedMonth] = useState(format(now, 'yyyy-MM'));
  const [periodStart, setPeriodStart] = useState(format(initialBusinessRange.start, 'yyyy-MM-dd'));
  const [periodEnd, setPeriodEnd] = useState(format(initialBusinessRange.end, 'yyyy-MM-dd'));
  const [selectedDriver, setSelectedDriver] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'paid' | 'unpaid'>('all');

  const { user, isAdmin, companyId } = useAuth();
  const { success, error: showError, warning } = useToast();
  const { settings } = useCompanySettings();

  const [statusModal, setStatusModal] = useState<{
    isOpen: boolean;
    salary: SalaryCalculation | null;
    newStatus: 'paid' | 'unpaid';
  }>({ isOpen: false, salary: null, newStatus: 'unpaid' });

  const [detailsModal, setDetailsModal] = useState<{
    isOpen: boolean;
    driverName: string;
    transactions: Income[];
  }>({ isOpen: false, driverName: '', transactions: [] });

  const [salaryDetailsModal, setSalaryDetailsModal] = useState<{
    isOpen: boolean;
    salary: SalaryCalculation | null;
  }>({ isOpen: false, salary: null });

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    calculateSalaries();
  }, [salaries, incomes, periodStart, periodEnd, selectedDriver, selectedStatus, drivers]);

  const loadData = async () => {
    try {
      setLoading(true);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 10000)
      );

      // Both tables are paginated: PostgREST caps a response at 1000 rows without
      // reporting it, and a truncated income set understates a driver's revenue —
      // a figure this screen then writes into the salaries table.
      const dataPromises = Promise.all([
        fetchAllPaginated<any>(
          (from, to) => supabase
            .from('salaries')
            .select('*')
            .eq('company_id', companyId)
            .order('period_start', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
          { label: 'Gehälter' },
        ),
        fetchAllPaginated<any>(
          (from, to) => supabase
            .from('income')
            .select('*')
            .eq('company_id', companyId)
            .order('date', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
          { label: 'Umsätze' },
        ),
      ]);

      const [salariesRows, incomeRows] = await Promise.race([dataPromises, timeoutPromise]) as [any[], any[]];

      setSalaries(salariesRows);
      setIncomes(incomeRows);

      return { salaries: salariesRows, incomes: incomeRows };
    } catch (err: any) {
      console.error('Error loading data:', err);
      showError('Fehler beim Laden', handleDatabaseError(err));
      setSalaries([]);
      setIncomes([]);
      return { salaries: [], incomes: [] };
    } finally {
      setLoading(false);
    }
  };

  const calculateSalaries = () => {
    const activeDrivers = drivers.filter(d => d.status !== 'inactive');
    const driversToCalculate = selectedDriver
      ? activeDrivers.filter(d => d.id === selectedDriver)
      : activeDrivers;

    const calculated: SalaryCalculation[] = driversToCalculate.map(driver => {
      const driverIncomes = incomes.filter(
        income =>
          income.driver_name === driver.name &&
          income.date >= periodStart &&
          income.date <= periodEnd
      );

      // Online revenue = Umsatz + Aktionen
      const revenue = driverIncomes
        .filter(i => i.type === 'umsatz' || i.type === 'aktionen')
        .reduce((sum, i) => sum + Number(i.amount), 0);

      // Tips belong 100% to driver
      const tips = driverIncomes
        .filter(i => i.type === 'trinkgeld')
        .reduce((sum, i) => sum + Number(i.amount), 0);

      const salaryRatio = driver.salary_ratio ?? 0.5;
      const revenueShare = revenue * salaryRatio;
      const amountDue = revenueShare + tips;

      const existingSalary = salaries.find(
        s =>
          s.driver_id === driver.id &&
          s.period_start === periodStart &&
          s.period_end === periodEnd
      );

      // Use netto_salary if available (manual adjustments), otherwise use calculated amount_due
      const totalSalary = Number(existingSalary?.netto_salary || amountDue);
      const totalPaidAmount = Number(existingSalary?.total_paid || 0);
      const remainingAmount = Math.max(0, totalSalary - totalPaidAmount);

      // Calculate payment status based on actual payments
      const calculatedPaymentStatus = totalPaidAmount === 0
        ? 'unpaid'
        : totalPaidAmount >= totalSalary
        ? 'paid'
        : 'partially_paid';

      return {
        driver_id: driver.id,
        driver_name: driver.name,
        salary_ratio: salaryRatio,
        revenue,
        tips,
        revenue_share: revenueShare,
        amount_due: amountDue,
        netto_salary: existingSalary?.netto_salary ? Number(existingSalary.netto_salary) : undefined,
        status: existingSalary?.status || 'unpaid',
        paid_at: existingSalary?.paid_at,
        salary_id: existingSalary?.id,
        total_paid: totalPaidAmount,
        remaining_balance: remainingAmount,
        payment_status: existingSalary?.payment_status || calculatedPaymentStatus,
        period_start: periodStart,
        period_end: periodEnd
      };
    });

    const filtered = calculated.filter(calc => {
      if (selectedStatus === 'all') return true;
      return calc.status === selectedStatus;
    });

    setCalculations(filtered);
  };

  const handleMonthChange = (month: string) => {
    setSelectedMonth(month);
    const date = new Date(month + '-01');
    const selectedMonth = getMonth(date);
    const selectedYear = getYear(date);
    const businessRange = getBusinessMonthRange(selectedMonth, selectedYear);
    setPeriodStart(format(businessRange.start, 'yyyy-MM-dd'));
    setPeriodEnd(format(businessRange.end, 'yyyy-MM-dd'));
  };

  const resetFilters = () => {
    const now = new Date();
    const businessMonth = getMonth(now);
    const businessYear = getYear(now);
    const businessRange = getBusinessMonthRange(businessMonth, businessYear);
    setSelectedMonth(format(now, 'yyyy-MM'));
    setPeriodStart(format(businessRange.start, 'yyyy-MM-dd'));
    setPeriodEnd(format(businessRange.end, 'yyyy-MM-dd'));
    setSelectedDriver('');
    setSelectedStatus('all');
  };

  const handleExport = () => {
    if (calculations.length === 0) {
      warning('Keine Daten', 'Es gibt keine Daten zum Exportieren');
      return;
    }
    exportSalariesToExcel(calculations, periodStart, periodEnd);
    success('Export erfolgreich', 'Die Gehaltsdaten wurden als Excel-Datei exportiert');
  };

  const openStatusModal = (salary: SalaryCalculation, newStatus: 'paid' | 'unpaid') => {
    setStatusModal({ isOpen: true, salary, newStatus });
  };


  const handleStatusChange = async () => {
    if (!statusModal.salary) return;

    if (!isAdmin) {
      showError('Keine Berechtigung', 'Nur Administratoren können den Status ändern');
      return;
    }

    try {
      const { salary, newStatus } = statusModal;

      if (salary.salary_id) {
        const { error } = await supabase
          .from('salaries')
          .update({
            status: newStatus,
            paid_at: newStatus === 'paid' ? new Date().toISOString() : null
          })
          .eq('id', salary.salary_id);

        if (error) throw error;
      } else {
        const { error } = await supabase.from('salaries').insert({
          driver_id: salary.driver_id,
          period_start: periodStart,
          period_end: periodEnd,
          calc_revenue: salary.revenue,
          calc_tips: salary.tips,
          amount_due: salary.amount_due,
          status: newStatus,
          paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
          created_by: user?.id || '',
          company_id: companyId
        });

        if (error) throw error;
      }

      await loadData();
      setStatusModal({ isOpen: false, salary: null, newStatus: 'unpaid' });
      success(
        newStatus === 'paid' ? 'Als bezahlt markiert' : 'Als unbezahlt markiert',
        `Gehalt für ${salary.driver_name} wurde aktualisiert`
      );
    } catch (err: any) {
      console.error('Error updating status:', err);
      showError('Fehler beim Aktualisieren', handleDatabaseError(err));
    }
  };

  const showDriverDetails = (driverName: string) => {
    const driverTransactions = incomes.filter(
      income =>
        income.driver_name === driverName &&
        income.date >= periodStart &&
        income.date <= periodEnd &&
        (income.type === 'umsatz' || income.type === 'aktionen' || income.type === 'trinkgeld')
    );

    setDetailsModal({
      isOpen: true,
      driverName,
      transactions: driverTransactions
    });
  };

  const totalDue = calculations.reduce((sum, c) => sum + c.amount_due, 0);
  const totalTips = calculations.reduce((sum, c) => sum + c.tips, 0);
  const totalRevenueShare = calculations.reduce((sum, c) => sum + c.revenue_share, 0);
  const paidCount = calculations.filter(c => c.status === 'paid').length;
  const unpaidCount = calculations.filter(c => c.status === 'unpaid').length;

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 rounded-xl shadow-lg p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-white bg-opacity-20 rounded-lg p-2">
              <DollarSign className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Gehaltsabrechnung</h1>
              <p className="text-blue-100 mt-1">Monatliche Gehälter pro Fahrer verwalten</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-blue-100">Gesamt Fällig</p>
            <p className="text-3xl font-bold">
              {totalDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
            </p>
            <p className="text-xs text-blue-200 mt-1">
              {paidCount} bezahlt / {unpaidCount} unbezahlt
            </p>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Gesamt Fällig</p>
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-text)' }}>
            {totalDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Trinkgeld</p>
          <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {totalTips.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Umsatzanteil</p>
          <p className="text-2xl font-bold" style={{ color: 'var(--success)' }}>
            {totalRevenueShare.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Status</p>
          <div className="flex items-center gap-4 mt-1">
            <div className="flex items-center gap-1">
              <CheckCircle size={16} style={{ color: 'var(--success)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>{paidCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <XCircle size={16} style={{ color: 'var(--danger)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>{unpaidCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label htmlFor="month-selector" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Monat
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
              <input
                id="month-selector"
                type="month"
                value={selectedMonth}
                onChange={e => handleMonthChange(e.target.value)}
                className="w-full pl-10 pr-3"
                style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.25rem' }}
              />
            </div>
          </div>

          <div>
            <label htmlFor="from-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Von
            </label>
            <input
              id="from-date"
              type="date"
              value={periodStart}
              onChange={e => setPeriodStart(e.target.value)}
              className="w-full"
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="to-date" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Bis
            </label>
            <input
              id="to-date"
              type="date"
              value={periodEnd}
              onChange={e => setPeriodEnd(e.target.value)}
              className="w-full"
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="driver-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Fahrer
            </label>
            <select
              id="driver-filter"
              value={selectedDriver}
              onChange={e => setSelectedDriver(e.target.value)}
              className="w-full"
              style={inputStyle}
            >
              <option value="">Alle Fahrer</option>
              {drivers.filter(driver => driver.status !== 'inactive').map(driver => (
                <option key={driver.id} value={driver.id}>
                  {driver.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="status-filter" className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Status
            </label>
            <select
              id="status-filter"
              value={selectedStatus}
              onChange={e => setSelectedStatus(e.target.value as 'all' | 'paid' | 'unpaid')}
              className="w-full"
              style={inputStyle}
            >
              <option value="all">Alle</option>
              <option value="paid">Bezahlt</option>
              <option value="unpaid">Unbezahlt</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={resetFilters}
            className="px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
          >
            <RefreshCw size={16} />
            Zurücksetzen
          </button>
          <button
            onClick={handleExport}
            disabled={calculations.length === 0}
            className="px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
            style={
              calculations.length === 0
                ? { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }
                : { background: 'var(--accent)', color: 'white' }
            }
            title={calculations.length === 0 ? 'Keine Daten zum Exportieren' : 'Als Excel exportieren'}
            aria-disabled={calculations.length === 0}
          >
            <Download size={16} />
            Excel exportieren
          </button>
        </div>
      </div>

      {/* Salaries Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--bg-subtle)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Fahrer
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Umsatz (€)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Anteil (%)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Umsatzanteil (€)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Trinkgeld (€)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Gesamtgehalt (€)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Bezahlt (€)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Restbetrag (€)
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Aktionen
                </th>
              </tr>
            </thead>
            <tbody>
              {calculations.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    Keine Gehaltsdaten für den ausgewählten Zeitraum
                  </td>
                </tr>
              ) : (
                calculations.map(calc => (
                  <tr
                    key={calc.driver_id}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {calc.driver_name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                      {calc.revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                      {(calc.salary_ratio * 100).toFixed(1)}%
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold" style={{ color: 'var(--success)' }}>
                      {calc.revenue_share.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {calc.tips.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-bold" style={{ color: 'var(--accent-text)' }}>
                      <div className="flex items-center justify-end gap-1">
                        {(calc.netto_salary || calc.amount_due).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {calc.netto_salary && calc.netto_salary !== calc.amount_due && (
                          <span className="text-xs" style={{ color: 'var(--accent)' }} title="Manuell angepasst">*</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      {calc.total_paid ? (
                        <span className="font-semibold" style={{ color: 'var(--success)' }}>
                          {calc.total_paid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>0.00</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span className="font-semibold" style={{ color: calc.remaining_balance > 0 ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                        {calc.remaining_balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {calc.payment_status === 'paid' ? (
                        <span className="px-2 py-1 rounded-full text-xs font-medium flex items-center gap-1 w-fit" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          <CheckCircle size={12} />
                          Bezahlt
                        </span>
                      ) : calc.payment_status === 'partially_paid' ? (
                        <span className="px-2 py-1 rounded-full text-xs font-medium flex items-center gap-1 w-fit" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                          <DollarSign size={12} />
                          Teilweise
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-xs font-medium flex items-center gap-1 w-fit" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                          <XCircle size={12} />
                          Unbezahlt
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => showDriverDetails(calc.driver_name)}
                          style={{ color: 'var(--accent)' }}
                          title="Umsatzdetails anzeigen"
                        >
                          <Eye size={18} />
                        </button>
                        <button
                          onClick={() => generateDriverSalaryPdf({ salary: calc, settings, showNote: false })}
                          style={{ color: 'var(--text-secondary)', cursor: 'pointer' }}
                          title="Zusammenfassung für Fahrer (PDF)"
                        >
                          <FileText size={18} />
                        </button>
                        <button
                          onClick={() => setSalaryDetailsModal({ isOpen: true, salary: calc })}
                          disabled={!isAdmin}
                          style={isAdmin ? { color: 'var(--success)', cursor: 'pointer' } : { color: 'var(--text-tertiary)', cursor: 'not-allowed' }}
                          title={isAdmin ? 'Zahlungen verwalten' : 'Nur Admin'}
                        >
                          <DollarSign size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status Confirmation Modal */}
      <ConfirmationModal
        isOpen={statusModal.isOpen}
        onClose={() => setStatusModal({ isOpen: false, salary: null, newStatus: 'unpaid' })}
        onConfirm={handleStatusChange}
        title={statusModal.newStatus === 'paid' ? 'Als bezahlt markieren' : 'Als unbezahlt markieren'}
        message={
          statusModal.salary
            ? `Möchten Sie das Gehalt von ${statusModal.salary.driver_name} wirklich als ${
                statusModal.newStatus === 'paid' ? 'bezahlt' : 'unbezahlt'
              } markieren?\n\nBetrag: ${statusModal.salary.amount_due.toFixed(2)} €`
            : ''
        }
        type={statusModal.newStatus === 'paid' ? 'success' : 'warning'}
      />

      {/* Driver Details Modal */}
      {detailsModal.isOpen && (() => {
        const transactions = detailsModal.transactions;
        const umsatzTotal = transactions.filter(t => t.type === 'umsatz').reduce((sum, t) => sum + Number(t.amount), 0);
        const aktionenTotal = transactions.filter(t => t.type === 'aktionen').reduce((sum, t) => sum + Number(t.amount), 0);
        const trinkgeldTotal = transactions.filter(t => t.type === 'trinkgeld').reduce((sum, t) => sum + Number(t.amount), 0);
        const bargeldTotal = transactions.filter(t => t.type === 'bargeld').reduce((sum, t) => sum + Number(t.amount), 0);
        const totalIncome = umsatzTotal + aktionenTotal + trinkgeldTotal + bargeldTotal;

        const getTypeStyle = (type: string): React.CSSProperties => {
          switch (type) {
            case 'umsatz': return { background: 'var(--success-subtle)', color: 'var(--success)' };
            case 'aktionen': return { background: 'var(--warning-subtle)', color: 'var(--warning)' };
            case 'trinkgeld': return { background: 'var(--success-subtle)', color: 'var(--success)' };
            case 'bargeld': return { background: 'var(--danger-subtle)', color: 'var(--danger)' };
            default: return { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' };
          }
        };

        const getTypeLabel = (type: string) => {
          switch (type) {
            case 'umsatz': return 'Umsatz';
            case 'aktionen': return 'Aktionen';
            case 'trinkgeld': return 'Trinkgeld';
            case 'bargeld': return 'Bargeld';
            default: return type;
          }
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="rounded-lg max-w-4xl w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}>
              {/* Header */}
              <div className="p-6" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    Transaktionen: {detailsModal.driverName}
                  </h3>
                  <button
                    onClick={() => setDetailsModal({ isOpen: false, driverName: '', transactions: [] })}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <XCircle size={24} />
                  </button>
                </div>
              </div>

              {/* Summary Section */}
              <div className="p-6" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                <h4 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>Zusammenfassung</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                    <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>Umsatz</div>
                    <div className="text-lg font-bold" style={{ color: 'var(--success)' }}>
                      {umsatzTotal.toFixed(2)} €
                    </div>
                  </div>
                  {aktionenTotal > 0 && (
                    <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                      <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>Aktionen</div>
                      <div className="text-lg font-bold" style={{ color: 'var(--warning)' }}>
                        {aktionenTotal.toFixed(2)} €
                      </div>
                    </div>
                  )}
                  <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                    <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>Trinkgeld</div>
                    <div className="text-lg font-bold" style={{ color: 'var(--success)' }}>
                      {trinkgeldTotal.toFixed(2)} €
                    </div>
                  </div>
                  <div className="rounded-lg p-4" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}>
                    <div className="text-xs mb-1 font-medium" style={{ color: 'var(--accent-text)' }}>Gesamt</div>
                    <div className="text-lg font-bold" style={{ color: 'var(--accent-text)' }}>
                      {totalIncome.toFixed(2)} €
                    </div>
                  </div>
                </div>
              </div>

              {/* Transaction List */}
              <div className="flex-1 overflow-y-auto p-6">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>Datum</th>
                        <th className="px-4 py-2 text-left text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>Typ</th>
                        <th className="px-4 py-2 text-left text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>
                          Beschreibung
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>Betrag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                            Keine Transaktionen
                          </td>
                        </tr>
                      ) : (
                        transactions.map(transaction => (
                          <tr
                            key={transaction.id}
                            style={{ borderBottom: '1px solid var(--border)' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                          >
                            <td className="px-4 py-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                              {format(new Date(transaction.date), 'dd.MM.yyyy')}
                            </td>
                            <td className="px-4 py-2 text-sm">
                              <span className="px-2 py-1 rounded-full text-xs font-medium" style={getTypeStyle(transaction.type)}>
                                {getTypeLabel(transaction.type)}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-sm" style={{ color: 'var(--text-primary)' }}>{transaction.description}</td>
                            <td className="px-4 py-2 text-sm text-right font-semibold" style={{ color: transaction.type === 'bargeld' ? 'var(--danger)' : 'var(--success)' }}>
                              {Number(transaction.amount).toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                              })}{' '}
                              €
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        );
      })()}


      {/* Salary Details and Payments Modal */}
      {salaryDetailsModal.isOpen && salaryDetailsModal.salary && (
        <SalaryDetailsModal
          isOpen={salaryDetailsModal.isOpen}
          onClose={() => setSalaryDetailsModal({ isOpen: false, salary: null })}
          salary={salaryDetailsModal.salary}
          onUpdate={loadData}
        />
      )}
    </div>
  );
};

export default SalariesManagement;
