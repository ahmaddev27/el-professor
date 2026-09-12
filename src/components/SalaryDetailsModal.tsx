import React, { useState, useEffect } from 'react';
import { X, Plus, CreditCard as Edit2, Trash2, DollarSign, AlertCircle, FileText, CheckSquare, Square, Building2, Banknote, LayoutDashboard, Zap } from 'lucide-react';
import { SalaryPayment, SalaryCalculation } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { format } from 'date-fns';
import SalaryPaymentModal from './SalaryPaymentModal';
import ConfirmationModal from './ConfirmationModal';
import { generateDriverSalaryPdf } from '../utils/driverSalaryPdf';
import DriverSalarySummaryCard from './DriverSalarySummaryCard';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

interface SalaryDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  salary: SalaryCalculation;
  onUpdate: () => void;
}

interface PayrollData {
  payroll_gross_amount: number | null;
  payroll_net_amount: number | null;
  tax_review_confirmed: boolean;
}

const SalaryDetailsModal: React.FC<SalaryDetailsModalProps> = ({
  isOpen,
  onClose,
  salary,
  onUpdate,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'details' | 'summary'>('details');
  const [payments, setPayments] = useState<SalaryPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingPayroll, setSavingPayroll] = useState(false);
  const [loadingWeekly, setLoadingWeekly] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<SalaryPayment | undefined>();
  const [paymentToDelete, setPaymentToDelete] = useState<SalaryPayment | null>(null);
  const [payrollData, setPayrollData] = useState<PayrollData>({
    payroll_gross_amount: null,
    payroll_net_amount: null,
    tax_review_confirmed: false,
  });

  const { showToast } = useToast();
  const { user } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { settings } = useCompanySettings();

  // The system-calculated total salary
  const calculatedSalaryTotal = salary.netto_salary ?? salary.amount_due ?? 0;

  // Derived payroll split values
  const payrollGross = payrollData.payroll_gross_amount ?? 0;
  const payrollNet = payrollData.payroll_net_amount ?? 0;
  const cashSalary = calculatedSalaryTotal - payrollGross;
  const bankSalary = payrollNet;
  const totalNetPayout = cashSalary + bankSalary;

  const hasPayrollData = payrollData.payroll_gross_amount != null || payrollData.payroll_net_amount != null;
  const grossExceedsTotal = payrollGross > calculatedSalaryTotal + 0.01;
  const cashIsNegative = cashSalary < -0.01;

  // Payment tracking
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const remainingBalance = Math.max(0, calculatedSalaryTotal - totalPaid);
  const paymentStatus = totalPaid === 0 ? 'unpaid' : totalPaid >= calculatedSalaryTotal ? 'paid' : 'partially_paid';

  useEffect(() => {
    if (isOpen && salary.salary_id) {
      fetchPayments();
      fetchPayrollData();
    } else if (isOpen && !salary.salary_id) {
      ensureSalaryExists();
    }
  }, [isOpen, salary.salary_id]);

  const ensureSalaryExists = async () => {
    if (salary.salary_id) return;
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) throw new Error(t('sal.notSignedIn'));
      if (!salary.period_start || !salary.period_end) throw new Error(t('sal.periodMissing'));

      const { data: existing } = await supabase
        .from('salaries')
        .select('id')
        .eq('driver_id', salary.driver_id)
        .eq('period_start', salary.period_start)
        .eq('period_end', salary.period_end)
        .maybeSingle();

      if (existing) {
        salary.salary_id = existing.id;
        await onUpdate();
        return;
      }

      const { data, error } = await supabase.from('salaries').insert({
        driver_id: salary.driver_id,
        period_start: salary.period_start,
        period_end: salary.period_end,
        calc_revenue: salary.revenue,
        calc_tips: salary.tips,
        amount_due: salary.amount_due,
        status: 'unpaid',
        created_by: authUser.id,
        company_id: companyId,
      }).select().single();

      if (error) throw error;
      salary.salary_id = data.id;
      await onUpdate();
    } catch (error: any) {
      console.error('Error creating salary record:', error);
      showToast('error', t('sal.error.createSalary'));
    }
  };

  const fetchPayments = async () => {
    if (!salary.salary_id) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('salary_payments')
        .select('*')
        .eq('salary_id', salary.salary_id)
        .order('payment_date', { ascending: false });
      if (error) throw error;
      setPayments(data || []);
    } catch {
      showToast('error', t('sal.error.loadPayments'));
    } finally {
      setLoading(false);
    }
  };

  const fetchPayrollData = async () => {
    if (!salary.salary_id) return;
    const { data } = await supabase
      .from('salaries')
      .select('payroll_gross_amount,payroll_net_amount,tax_review_confirmed')
      .eq('id', salary.salary_id)
      .maybeSingle();

    if (data) {
      setPayrollData({
        payroll_gross_amount: data.payroll_gross_amount ?? null,
        payroll_net_amount: data.payroll_net_amount ?? null,
        tax_review_confirmed: data.tax_review_confirmed ?? false,
      });
    }
  };

  const savePayrollData = async () => {
    if (!salary.salary_id) return;
    setSavingPayroll(true);
    try {
      // Compute and persist the derived values alongside the inputs
      const grossVal = payrollData.payroll_gross_amount;
      const netVal = payrollData.payroll_net_amount;
      const computedCash = grossVal != null ? calculatedSalaryTotal - grossVal : null;
      const computedBank = netVal;
      const computedTotal = computedCash != null && computedBank != null ? computedCash + computedBank : null;

      const updates: Record<string, unknown> = {
        payroll_gross_amount: grossVal,
        payroll_net_amount: netVal,
        cash_salary_amount: computedCash,
        bank_salary_amount: computedBank,
        total_net_payout: computedTotal,
        tax_review_confirmed: payrollData.tax_review_confirmed,
      };

      if (payrollData.tax_review_confirmed) {
        updates.tax_review_confirmed_at = new Date().toISOString();
        updates.tax_review_confirmed_by = user?.id ?? null;
      }

      const { error } = await supabase
        .from('salaries')
        .update(updates)
        .eq('id', salary.salary_id);

      if (error) throw error;
      showToast('success', t('sal.payroll.saved'));
    } catch {
      showToast('error', t('sal.error.save'));
    } finally {
      setSavingPayroll(false);
    }
  };

  const handleWeeklyCashPayment = async () => {
    if (!salary.period_start || !salary.period_end) {
      showToast('warning', t('sal.weekly.selectFirst'));
      return;
    }

    setLoadingWeekly(true);
    try {
      // Derive year/month from period_start (business month: month of the period start)
      const periodDate = new Date(salary.period_start);
      const year = periodDate.getFullYear();
      const month = periodDate.getMonth() + 1; // 1-based

      // Fetch weekly Abrechnung for this driver and month
      const { data: weeklyRows, error: rpcErr } = await supabase.rpc('get_weekly_abrechnung', {
        p_year: year,
        p_month: month,
      });

      if (rpcErr) throw new Error(rpcErr.message);

      // Filter rows for this driver only
      const driverRows = (weeklyRows || []).filter(
        (r: { driver_name: string }) => r.driver_name === salary.driver_name
      );

      if (driverRows.length === 0) {
        showToast('warning', t('sal.weekly.notFound'));
        return;
      }

      // Pick the row with the highest week_number (= last week of the month)
      const lastWeekRow = driverRows.reduce(
        (prev: { week_number: number }, cur: { week_number: number }) =>
          cur.week_number > prev.week_number ? cur : prev
      );

      const difference: number = Number(lastWeekRow.bar_zuruck ?? 0);
      const weekNumber: number = lastWeekRow.week_number;

      if (difference < 0.01) {
        if (difference < -0.01) {
          showToast('warning', t('sal.weekly.noCashOpenDiff'));
        } else {
          showToast('info', t('sal.weekly.noPositiveDiff'));
        }
        return;
      }

      // Build a stable source reference: driverId_year_month_weekNumber
      const sourceReference = `${salary.driver_id}_${year}_${month}_${weekNumber}`;

      // Ensure salary record exists first
      if (!salary.salary_id) {
        await ensureSalaryExists();
        // After ensureSalaryExists salary.salary_id may be set — wait briefly for state update
        await new Promise(r => setTimeout(r, 100));
      }

      const salaryId = salary.salary_id;
      if (!salaryId) {
        showToast('error', t('sal.error.createPayroll'));
        return;
      }

      // Duplicate check: same salary + source_reference
      const { data: existing } = await supabase
        .from('salary_payments')
        .select('id')
        .eq('salary_id', salaryId)
        .eq('source_type', 'weekly_cash_difference')
        .eq('source_reference', sourceReference)
        .maybeSingle();

      if (existing) {
        showToast('warning', t('sal.weekly.alreadyImported'));
        return;
      }

      // Determine the week date range using the RPC result week_number + business calendar
      // We use period_end as the payment_date (last day of the week or period)
      // The last week's end date is the last day of the period
      const paymentDate = salary.period_end;

      const { data: authData } = await supabase.auth.getUser();
      const userId = authData.user?.id;
      if (!userId) throw new Error(t('sal.notSignedIn'));

      const { error: insertErr } = await supabase.from('salary_payments').insert({
        salary_id: salaryId,
        payment_type: 'cash',
        amount: Math.round(difference * 100) / 100,
        payment_date: paymentDate,
        // `description` and `payment_category` are persisted to salary_payments and
        // read back as stored data, so they stay German in both languages.
        description: 'Automatisch aus letzter Wochenabrechnung übernommen',
        payment_category: 'Bargehalt',
        source_type: 'weekly_cash_difference',
        source_reference: sourceReference,
        week_start: salary.period_start,
        week_end: salary.period_end,
        created_by: userId,
        company_id: companyId,
      });

      if (insertErr) {
        // Postgres unique constraint violation
        if (insertErr.code === '23505') {
          showToast('warning', t('sal.weekly.alreadyImported'));
          return;
        }
        throw new Error(insertErr.message);
      }

      await fetchPayments();
      await onUpdate();
      showToast('success', t('sal.weekly.created', { amount: difference.toLocaleString('de-DE', { minimumFractionDigits: 2 }) }));
    } catch (err: any) {
      showToast('error', err.message || t('sal.weekly.errorCreate'));
    } finally {
      setLoadingWeekly(false);
    }
  };

  const handleSavePayment = async (paymentData: Omit<SalaryPayment, 'id' | 'created_by' | 'created_at' | 'updated_at'>) => {
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) throw new Error(t('sal.notSignedIn'));

      if (selectedPayment) {
        const { error } = await supabase
          .from('salary_payments')
          .update({
            payment_type: paymentData.payment_type,
            amount: paymentData.amount,
            payment_date: paymentData.payment_date,
            description: paymentData.description,
          })
          .eq('id', selectedPayment.id);
        if (error) throw error;
        showToast('success', t('sal.payment.updated'));
      } else {
        const { error } = await supabase
          .from('salary_payments')
          .insert({ ...paymentData, created_by: authUser.id, company_id: companyId });
        if (error) throw error;
        showToast('success', t('sal.payment.added'));
      }

      await fetchPayments();
      setIsPaymentModalOpen(false);
      setSelectedPayment(undefined);
      await onUpdate();
    } catch (error: any) {
      throw error;
    }
  };

  const handleDeletePayment = async () => {
    if (!paymentToDelete) return;
    try {
      const { error } = await supabase.from('salary_payments').delete().eq('id', paymentToDelete.id);
      if (error) throw error;
      showToast('success', t('sal.payment.deleted'));
      await fetchPayments();
      await onUpdate();
    } catch (error: any) {
      showToast('error', error.message || t('common.errorDelete'));
    } finally {
      setPaymentToDelete(null);
    }
  };

  const handleExportPdf = () => {
    // Only figures cross into the PDF here; its own labels live in driverSalaryPdf.ts
    // and stay German because the document goes to the Steuerberater.
    generateDriverSalaryPdf({
      salary,
      settings,
      payrollGrossAmount: payrollData.payroll_gross_amount,
      payrollNetAmount: payrollData.payroll_net_amount,
      cashSalaryAmount: hasPayrollData ? cashSalary : undefined,
      bankSalaryAmount: hasPayrollData ? bankSalary : undefined,
      totalNetPayout: hasPayrollData ? totalNetPayout : undefined,
    });
  };

  // `status` is the derived payment status; only the badge text is translated.
  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'paid':
        return <span style={{ background: 'var(--success-subtle)', color: 'var(--success)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.fullyPaid')}</span>;
      case 'partially_paid':
        return <span style={{ background: 'var(--warning-subtle)', color: 'var(--warning)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.partiallyPaid')}</span>;
      default:
        return <span style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.unpaid')}</span>;
    }
  };

  const handleClose = async () => {
    await onUpdate();
    onClose();
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '0.375rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.375rem 0.625rem',
    outline: 'none',
    width: '100%',
  };

  const readonlyRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    borderBottom: '1px solid var(--border)',
  };

  const fmtEur = (n: number) =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)' }} className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">

          {/* Header */}
          <div style={{ borderBottom: '1px solid var(--border)' }} className="px-6 pt-6 pb-0">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold">
                  {t('sal.details.title', { name: salary.driver_name })}
                </h2>
                <p style={{ color: 'var(--text-secondary)' }} className="text-sm mt-1">
                  {salary.period_start && salary.period_end
                    ? `${format(new Date(salary.period_start), 'dd.MM.yyyy')} – ${format(new Date(salary.period_end), 'dd.MM.yyyy')}`
                    : format(new Date(salary.paid_at || new Date()), 'dd.MM.yyyy')}
                </p>
              </div>
              <button
                onClick={handleClose}
                style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
              >
                <X size={24} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex gap-1" style={{ marginBottom: '-1px' }}>
              {([
                { key: 'details', label: t('sal.tab.details'), icon: <DollarSign size={15} /> },
                { key: 'summary', label: t('common.summary'), icon: <LayoutDashboard size={15} /> },
              ] as const).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors"
                  style={{
                    background: activeTab === tab.key ? 'var(--bg-surface)' : 'transparent',
                    color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-tertiary)',
                    border: activeTab === tab.key ? '1px solid var(--border)' : '1px solid transparent',
                    borderBottom: activeTab === tab.key ? '1px solid var(--bg-surface)' : '1px solid transparent',
                    cursor: 'pointer',
                  }}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6 space-y-6 overflow-y-auto flex-1">

            {/* ── Summary tab ── */}
            {activeTab === 'summary' && (
              <DriverSalarySummaryCard
                driverName={salary.driver_name}
                periodStart={salary.period_start || new Date().toISOString().slice(0, 10)}
                periodEnd={salary.period_end || new Date().toISOString().slice(0, 10)}
                totalRevenue={salary.revenue}
                salaryRatio={salary.salary_ratio}
                driverPartAmount={salary.revenue_share}
                tips={salary.tips}
                alreadyPaidSalary={totalPaid}
                remainingSalary={remainingBalance}
                brutto={payrollData.payroll_gross_amount}
                nettoBank={payrollData.payroll_net_amount}
                cashSalary={hasPayrollData ? cashSalary : null}
                companyName={settings?.company_name}
              />
            )}

            {/* ── Details tab ── */}
            {activeTab === 'details' && (<>

            {/* KPI summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div style={{ background: 'var(--accent-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: 'var(--accent)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  {t('sal.calculatedDriverSalary')}
                  {salary.netto_salary && salary.netto_salary !== salary.amount_due && (
                    <span style={{ fontSize: '0.75rem', opacity: 0.8 }}> {t('sal.adjustedSuffix')}</span>
                  )}
                </div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(calculatedSalaryTotal)}
                </div>
              </div>

              <div style={{ background: 'var(--success-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: 'var(--success)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>{t('sal.alreadyPaid')}</div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(totalPaid)}
                </div>
              </div>

              <div style={{ background: remainingBalance > 0 ? 'var(--danger-subtle)' : 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: remainingBalance > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  {t('sal.remaining')}
                </div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(remainingBalance)}
                </div>
              </div>
            </div>

            {/* ——— Lohnabrechnung & Auszahlung ——— */}
            <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
              <div style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', padding: '0.875rem 1.25rem' }} className="flex items-center justify-between">
                <h3 style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('sal.payroll.sectionTitle')}</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{t('sal.payroll.internalOnly')}</span>
              </div>

              <div className="p-5 space-y-5">

                {/* Read-only: system total */}
                <div style={readonlyRowStyle}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{t('sal.calculatedDriverSalary')}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{fmtEur(calculatedSalaryTotal)}</span>
                </div>

                {/* Editable inputs */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('sal.payroll.grossLabel')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={payrollData.payroll_gross_amount ?? ''}
                      onChange={e => setPayrollData(prev => ({
                        ...prev,
                        payroll_gross_amount: e.target.value === '' ? null : Number(e.target.value),
                      }))}
                      style={inputStyle}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                      {t('sal.payroll.grossHint')}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('sal.payroll.netLabel')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={payrollData.payroll_net_amount ?? ''}
                      onChange={e => setPayrollData(prev => ({
                        ...prev,
                        payroll_net_amount: e.target.value === '' ? null : Number(e.target.value),
                      }))}
                      style={inputStyle}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                      {t('sal.payroll.netHint')}
                    </p>
                  </div>
                </div>

                {/* Warning: gross > calculated total */}
                {grossExceedsTotal && (
                  <div style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', borderRadius: '0.375rem', padding: '0.625rem 0.875rem' }} className="flex items-center gap-2">
                    <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.875rem', color: 'var(--danger)' }}>
                      {t('sal.payroll.grossExceedsWarning')}
                    </span>
                  </div>
                )}

                {/* Computed breakdown — shown once at least one field is filled */}
                {hasPayrollData && (
                  <div style={{ background: 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem', border: '1px solid var(--border)' }} className="space-y-0">
                    <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {t('sal.payroll.computedPayout')}
                    </p>

                    {/* Bargehalt */}
                    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <Banknote size={15} style={{ color: 'var(--success)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('sal.payroll.cashSalary')}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          ({fmtEur(calculatedSalaryTotal)} − {fmtEur(payrollGross)})
                        </span>
                      </div>
                      <span style={{
                        fontWeight: 700,
                        color: cashIsNegative ? 'var(--danger)' : 'var(--text-primary)',
                      }}>
                        {fmtEur(cashSalary)}
                        {cashIsNegative && <span style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>⚠</span>}
                      </span>
                    </div>

                    {/* Bankgehalt */}
                    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <Building2 size={15} style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('sal.payroll.bankSalary')}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{fmtEur(bankSalary)}</span>
                    </div>

                    {/* Total net payout */}
                    <div className="flex items-center justify-between pt-2">
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {t('sal.payroll.totalNetPayout')}
                      </span>
                      <span style={{
                        fontSize: '1.125rem',
                        fontWeight: 700,
                        color: cashIsNegative ? 'var(--warning)' : 'var(--success)',
                      }}>
                        {fmtEur(totalNetPayout)}
                        {cashIsNegative && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--warning)', marginLeft: '0.5rem', fontWeight: 400 }}>
                            {t('sal.payroll.cashNegative')}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                )}

                {/* Tax confirmation */}
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setPayrollData(prev => ({ ...prev, tax_review_confirmed: !prev.tax_review_confirmed }))}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {payrollData.tax_review_confirmed
                      ? <CheckSquare size={16} style={{ color: 'var(--success)' }} />
                      : <Square size={16} style={{ color: 'var(--text-tertiary)' }} />}
                    {t('sal.payroll.taxReviewed')}
                  </button>
                </div>

                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                  {t('sal.payroll.taxDisclaimer')}
                </p>

                <div className="flex justify-end">
                  <button
                    onClick={savePayrollData}
                    disabled={savingPayroll}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--accent-text)',
                      border: 'none',
                      cursor: savingPayroll ? 'not-allowed' : 'pointer',
                      opacity: savingPayroll ? 0.7 : 1,
                    }}
                    onMouseEnter={e => { if (!savingPayroll) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                  >
                    {savingPayroll ? t('common.saving') : t('sal.payroll.save')}
                  </button>
                </div>
              </div>
            </div>

            {/* Payment status + add buttons */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold">{t('sal.paymentStatus')}</h3>
                <div className="mt-2">{getStatusBadge(paymentStatus)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleWeeklyCashPayment}
                  disabled={loadingWeekly}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
                  style={{
                    background: 'var(--success-subtle)',
                    color: 'var(--success)',
                    border: '1px solid var(--success)',
                    cursor: loadingWeekly ? 'not-allowed' : 'pointer',
                    opacity: loadingWeekly ? 0.7 : 1,
                  }}
                  onMouseEnter={e => { if (!loadingWeekly) { e.currentTarget.style.background = 'var(--success)'; e.currentTarget.style.color = '#fff'; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--success-subtle)'; e.currentTarget.style.color = 'var(--success)'; }}
                  title={t('sal.weekly.buttonTitle')}
                >
                  <Zap size={16} />
                  <span>{t('sal.weekly.button')}</span>
                </button>
                <button
                  onClick={() => { setSelectedPayment(undefined); setIsPaymentModalOpen(true); }}
                  disabled={remainingBalance <= 0}
                  style={{ background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none' }}
                  onMouseEnter={e => { if (remainingBalance > 0) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                  className="flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={20} />
                  <span>{t('sal.payment.add')}</span>
                </button>
              </div>
            </div>

            {/* Payment history */}
            <div>
              <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold mb-4">{t('sal.paymentHistory')}</h3>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div style={{ borderColor: 'var(--accent)' }} className="animate-spin rounded-full h-8 w-8 border-b-2"></div>
                </div>
              ) : payments.length === 0 ? (
                <div style={{ color: 'var(--text-tertiary)' }} className="text-center py-8">{t('sal.noPayments')}</div>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
                  <table className="w-full">
                    <thead style={{ background: 'var(--bg-subtle)' }}>
                      <tr>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.date')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('sal.payment.type')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.amount')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.description')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 600 }}>{t('sal.col.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment, idx) => (
                        <tr
                          key={payment.id}
                          style={{ borderTop: idx > 0 ? '1px solid var(--border)' : undefined }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ color: 'var(--text-primary)', padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            {format(new Date(payment.payment_date), 'dd.MM.yyyy')}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            <div className="flex flex-col gap-1">
                              <span style={{
                                background: payment.payment_type === 'cash' ? 'var(--success-subtle)' : 'var(--accent-subtle)',
                                color: payment.payment_type === 'cash' ? 'var(--success)' : 'var(--accent)',
                                borderRadius: '0.25rem',
                                padding: '0.125rem 0.5rem',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                width: 'fit-content',
                              }}>
                                {payment.payment_type === 'cash'
                                  ? <><Banknote size={12} />{t('sal.payment.cashBadge')}</>
                                  : <><Building2 size={12} />{t('sal.payment.bankBadge')}</>}
                              </span>
                              {payment.source_type === 'weekly_cash_difference' && (
                                <span style={{
                                  background: 'var(--warning-subtle)',
                                  color: 'var(--warning)',
                                  borderRadius: '0.25rem',
                                  padding: '0.125rem 0.375rem',
                                  fontSize: '0.6875rem',
                                  fontWeight: 500,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  width: 'fit-content',
                                }}>
                                  <Zap size={10} />{t('sal.weekly.badge')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ color: 'var(--text-primary)', padding: '0.75rem 1rem', fontSize: '0.875rem', textAlign: 'right', fontWeight: 600 }}>
                            {Number(payment.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </td>
                          <td style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            {payment.description || '-'}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={() => { setSelectedPayment(payment); setIsPaymentModalOpen(true); }}
                                style={{ color: 'var(--accent)', borderRadius: '0.25rem', padding: '0.25rem' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                title={t('common.edit')}
                              >
                                <Edit2 size={16} />
                              </button>
                              <button
                                onClick={() => setPaymentToDelete(payment)}
                                style={{ color: 'var(--danger)', borderRadius: '0.25rem', padding: '0.25rem' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--danger-subtle)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                title={t('common.delete')}
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
              )}
            </div>
            </>)}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)', padding: '1.5rem' }} className="flex justify-end">
            <button
              onClick={handleClose}
              style={{ background: 'var(--bg-muted)', color: 'var(--text-primary)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>

      <SalaryPaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => { setIsPaymentModalOpen(false); setSelectedPayment(undefined); }}
        onSave={handleSavePayment}
        salaryId={salary.salary_id!}
        remainingBalance={remainingBalance}
        payment={selectedPayment}
      />

      <ConfirmationModal
        isOpen={!!paymentToDelete}
        onClose={() => setPaymentToDelete(null)}
        onConfirm={handleDeletePayment}
        type="confirm"
        title={t('sal.payment.deleteTitle')}
        message={t('sal.payment.deleteConfirm')}
        confirmText={t('common.delete')}
      />
    </>
  );
};

export default SalaryDetailsModal;
