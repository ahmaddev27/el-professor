import React, { useState, useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Coins,
  DollarSign,
  Download,
  RefreshCw,
  RotateCw,
  TrendingUp,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { Driver, Income, Salary, SalaryCalculation } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { format, getMonth, getYear } from 'date-fns';
import ConfirmationModal from './ConfirmationModal';
import SalaryDetailsModal from './SalaryDetailsModal';
import SalaryPeriodsModal from './SalaryPeriodsModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import { buildSalarySheets, salaryExportFilename } from '../utils/listExportSheets';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { getBusinessMonthRange } from '../utils/weekCalculations';
import { findOverlappingSalaryPeriods, groupSalaryPeriodsByDriver } from '../utils/salaryPeriodOverlap';
import { formatSalaryDue, formatStoredDate, salaryRowWriteRefusal } from '../utils/salaryRowEdit';
import { calcSalaryFromIncome, salaryBase, salaryDueState, sumIncomeAmount } from '../utils/salaryDue';
import { receiptScope } from '../utils/salaryCashReceiptFlow';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { driverNameWithStatus, selectableDrivers } from '../utils/driverStatus';
import {
  Alert,
  Badge,
  badgeVariants,
  Button,
  Card,
  cn,
  DataTable,
  EmptyState,
  Field,
  formatEuro,
  formatPercent,
  Input,
  KpiCard,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type DataTableColumn,
} from './ui';

interface SalariesManagementProps {
  drivers: Driver[];
}

const SalariesManagement: React.FC<SalariesManagementProps> = ({ drivers }) => {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const [salaries, setSalaries] = useState<Salary[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [calculations, setCalculations] = useState<SalaryCalculation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

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

  const { user, isAdmin, companyId: ownCompanyId, can } = useAuth();
  const { effectiveCompanyId: companyId, isViewingAsCompany } = useSuperAdmin();
  const { success, error: showError, warning } = useToast();

  /**
   * Why this caller may not edit or delete a salary row, or null when they may.
   *
   * `salaries_update` and `salaries_delete` (20260917130000) are both
   * `company_id = get_active_company_id() AND current_role_permits('salaries', true)`,
   * so the two terms asked here are the two the database asks. The scope term is
   * not redundant with `can()`: `AuthContext.can` returns true for every
   * platform account, while `get_active_company_id()` is NULL for one — so
   * asking the role alone would draw buttons the database silently throws away.
   */
  const writeRefusal = salaryRowWriteRefusal(
    receiptScope({ companyId: ownCompanyId, effectiveCompanyId: companyId, isViewingAsCompany }),
    can('salaries', 'edit'),
  );

  const [statusModal, setStatusModal] = useState<{
    isOpen: boolean;
    salary: SalaryCalculation | null;
    newStatus: 'paid' | 'unpaid';
  }>({ isOpen: false, salary: null, newStatus: 'unpaid' });

  const [salaryDetailsModal, setSalaryDetailsModal] = useState<{
    isOpen: boolean;
    salary: SalaryCalculation | null;
  }>({ isOpen: false, salary: null });

  // The driver whose salary periods are being merged, by id: the dialog reads
  // that driver's rows out of `salaries`, so it must not hold a copy that the
  // reload after a write would leave stale.
  const [periodsDriverId, setPeriodsDriverId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    calculateSalaries();
  }, [salaries, incomes, periodStart, periodEnd, selectedDriver, selectedStatus, drivers]);

  const loadData = async () => {
    try {
      setLoading(true);
      setLoadFailed(false);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 10000)
      );

      // Both tables are paginated: PostgREST caps a response at 1000 rows without
      // reporting it, and a truncated income set understates a driver's revenue —
      // a figure this screen then writes into the salaries table.
      // The `label` values below are interpolated into fetchAllPaginated's error
      // template; a caller's label arrives already translated, and the sentence
      // around it carries its own key (engine.fetch.*).
      const dataPromises = Promise.all([
        fetchAllPaginated<any>(
          (from, to) => supabase
            .from('salaries')
            .select('*')
            .eq('company_id', companyId)
            .order('period_start', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
          { label: t('overview.load.gehaelter') },
        ),
        fetchAllPaginated<any>(
          (from, to) => supabase
            .from('income')
            .select('*')
            .eq('company_id', companyId)
            .order('date', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
          { label: t('overview.load.umsaetze') },
        ),
      ]);

      const [salariesRows, incomeRows] = await Promise.race([dataPromises, timeoutPromise]) as [any[], any[]];

      setSalaries(salariesRows);
      setIncomes(incomeRows);

      return { salaries: salariesRows, incomes: incomeRows };
    } catch (err: any) {
      console.error('Error loading data:', err);
      showError(t('common.errorLoad'), handleDatabaseError(err));
      setLoadFailed(true);
      setSalaries([]);
      setIncomes([]);
      return { salaries: [], incomes: [] };
    } finally {
      setLoading(false);
    }
  };

  const calculateSalaries = () => {
    const activeDrivers = selectableDrivers(drivers);
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
      const revenue = sumIncomeAmount(driverIncomes, ['umsatz', 'aktionen']);

      // Tips belong 100% to driver
      const tips = sumIncomeAmount(driverIncomes, ['trinkgeld']);

      // (Umsatz + Aktionen) × salary_ratio + Trinkgeld × 100%, and the default
      // ratio for a driver who has none — utils/salaryDue.ts holds the rule.
      const { salaryRatio, revenueShare, amountDue, unrecovered } = calcSalaryFromIncome({
        revenue,
        tips,
        salaryRatio: driver.salary_ratio,
      });

      const existingSalary = salaries.find(
        s =>
          s.driver_id === driver.id &&
          s.period_start === periodStart &&
          s.period_end === periodEnd
      );

      /**
       * The base is COALESCE(netto_salary, the amount recomputed just above) —
       * a manual adjustment wins, otherwise this period's live figure.
       *
       * The status and the remaining balance are then **derived from that base**
       * rather than read off the row. The stored `payment_status` was computed
       * against whatever the base was when the last payment was entered, and it
       * is set on every row, so `existingSalary?.payment_status || derived` meant
       * the derivation never ran: measured on staging 28.09.2026, 28 of 53 rows
       * hold a drifted `amount_due` and 5 read "bezahlt" while money is owed.
       *
       * Display only. Nothing here is written back — an issued Gehaltsquittung's
       * base is frozen by design, and two production receipts hang off drifted
       * rows.
       */
      const due = salaryDueState(
        { netto_salary: existingSalary?.netto_salary, amount_due: amountDue },
        existingSalary?.total_paid,
      );

      return {
        driver_id: driver.id,
        driver_name: driver.name,
        salary_ratio: salaryRatio,
        revenue,
        tips,
        revenue_share: revenueShare,
        amount_due: amountDue,
        unrecovered,
        // `!= null` and not truthiness: an adjustment to zero is a decision.
        netto_salary: existingSalary?.netto_salary != null ? Number(existingSalary.netto_salary) : undefined,
        status: existingSalary?.status || 'unpaid',
        paid_at: existingSalary?.paid_at,
        salary_id: existingSalary?.id,
        total_paid: due.totalPaid,
        remaining_balance: due.remaining,
        payment_status: due.paymentStatus,
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

  /**
   * Per driver, the other salary rows whose period overlaps the one on screen.
   *
   * `confirm_salary_cash_payment` refuses such a salary (`overlapping_salary`)
   * until the owner has merged the rows by hand, and `unique_driver_period` is
   * only `UNIQUE (driver_id, period_start)`, so nothing else makes the pair
   * visible — the screen shows one period at a time. Folded out of the rows
   * already loaded, so no query is added.
   *
   * A driver with no stored row for the selected period is checked too: the
   * period is the one `ensureSalaryExists` would write the moment the payments
   * dialog is opened, so the warning arrives before the second row exists.
   */
  /**
   * The company's salary rows indexed by driver — every period, not only the
   * one on screen. The overlap markers below and the dialog that merges the
   * rows both read it, so neither adds a query and the two can never disagree
   * about what a driver holds.
   */
  const rowsByDriver = useMemo(() => groupSalaryPeriodsByDriver(salaries), [salaries]);

  // The full `drivers` list, not `selectableDrivers`: the periods dialog is
  // reached from a salary that already exists, so a driver who has left must
  // still resolve to a name — marked, so the operator can tell which it is.
  const periodsDriverName = useMemo(() => {
    const found = drivers.find(driver => driver.id === periodsDriverId);
    return found ? driverNameWithStatus(found, t) : '';
  }, [drivers, periodsDriverId, t]);

  const overlapsByDriver = useMemo(() => {
    const found = new Map<string, Salary[]>();
    for (const calc of calculations) {
      const driverRows = rowsByDriver.get(calc.driver_id);
      if (!driverRows || driverRows.length === 0) continue;
      const overlapping = findOverlappingSalaryPeriods(
        { period_start: calc.period_start, period_end: calc.period_end },
        driverRows,
        calc.salary_id ?? null,
      );
      if (overlapping.length > 0) found.set(calc.driver_id, overlapping);
    }
    return found;
  }, [calculations, rowsByDriver]);

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
      warning(t('sal.export.noDataTitle'), t('sal.export.noDataMessage'));
      return;
    }
    exportPicker.sheets(
      'salaries',
      salaryExportFilename(periodStart, periodEnd),
      buildSalarySheets(calculations, periodStart, periodEnd),
      // The toast waits for the file: the chooser can still be cancelled.
      () => success(t('sal.export.successTitle'), t('sal.export.successMessage')),
    );
  };

  const openStatusModal = (salary: SalaryCalculation, newStatus: 'paid' | 'unpaid') => {
    setStatusModal({ isOpen: true, salary, newStatus });
  };


  const handleStatusChange = async () => {
    if (!statusModal.salary) return;

    if (!isAdmin) {
      showError(t('common.noPermission'), t('sal.adminOnlyStatus'));
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
        newStatus === 'paid' ? t('sal.markedPaid') : t('sal.markedUnpaid'),
        t('sal.salaryUpdated', { name: salary.driver_name })
      );
    } catch (err: any) {
      console.error('Error updating status:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  // The base, not the calculated amount: the `total` column below shows
  // COALESCE(netto_salary, amount_due), so summing amount_due made the KPI
  // disagree with the column under it wherever an adjustment exists (1 staging
  // row, by 558,80 €).
  const totalDue = calculations.reduce((sum, c) => sum + salaryBase(c), 0);
  const totalTips = calculations.reduce((sum, c) => sum + c.tips, 0);
  const totalRevenueShare = calculations.reduce((sum, c) => sum + c.revenue_share, 0);
  const unrecoveredRows = calculations.filter(c => (c.unrecovered ?? 0) > 0);
  const paidCount = calculations.filter(c => c.status === 'paid').length;
  const unpaidCount = calculations.filter(c => c.status === 'unpaid').length;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for the three
  // `loadFailed` lines; everything below only draws it. The figures are the
  // sums calculateSalaries and the lines above produce, formatted through
  // utils/money.ts (formatEuro): this block adds no arithmetic. Where the old
  // markup computed something inline — the overlap hint, the transaction
  // dialog's sums — the expressions are carried over verbatim, and
  // design-harness/prove-batch2.mjs checks that they are.

  // formatEuro refuses a value that is not a finite amount. A figure shows such
  // a value as it is rather than taking the screen down, as DataTable does.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  /** The Radix select cannot hold '', which is what "all drivers" is in state. */
  const ALL_DRIVERS = 'all-drivers';

  const overlapFor = (calc: SalaryCalculation) => {
    const overlaps = overlapsByDriver.get(calc.driver_id);
    // One line per overlapping row, so the owner can go straight to
    // the period he has to merge instead of hunting for it.
    const overlapHint = overlaps
      ? [
          t('sal.overlap.tooltip'),
          ...overlaps.map(other =>
            t('sal.overlap.entry', {
              period: `${formatStoredDate(other.period_start)} – ${formatStoredDate(other.period_end)}`,
              amount: formatSalaryDue(other),
            }),
          ),
        ].join('\n')
      : '';
    return { overlaps, overlapHint };
  };

  const statusBadge = (calc: SalaryCalculation) =>
    calc.payment_status === 'paid' ? (
      <Badge tone="positive">
        <CheckCircle aria-hidden />
        {t('sal.status.paid')}
      </Badge>
    ) : calc.payment_status === 'partially_paid' ? (
      <Badge tone="caution">
        <DollarSign aria-hidden />
        {t('sal.status.partiallyShort')}
      </Badge>
    ) : (
      <Badge tone="critical">
        <XCircle aria-hidden />
        {t('sal.status.unpaid')}
      </Badge>
    );

  const columns: DataTableColumn<SalaryCalculation>[] = [
    {
      id: 'driver',
      header: t('common.driver'),
      value: calc => calc.driver_name,
      sortable: true,
      className: 'pr-2 sm:pr-4',
      cell: calc => {
        const { overlaps, overlapHint } = overlapFor(calc);
        return (
          <div className="flex flex-col items-start gap-1 py-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <span className="font-medium">{calc.driver_name}</span>
            {overlaps && (
              // The badge opens the dialog that resolves what it
              // reports: the overlapping row is usually outside the
              // selected period, so there is nowhere else to reach it.
              <button
                type="button"
                onClick={() => setPeriodsDriverId(calc.driver_id)}
                className={cn(
                  badgeVariants({ tone: 'caution' }),
                  'cursor-pointer hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  '[@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-1.5',
                )}
                title={`${overlapHint}\n\n${t('sal.periods.openHint')}`}
                aria-label={`${overlapHint}\n\n${t('sal.periods.openHint')}`}
              >
                <AlertTriangle aria-hidden />
                {t('sal.overlap.badge')}
              </button>
            )}
            {/* On a phone the total and status columns are hidden, and both move
                here: the name, the four actions and the salary do not fit a
                375 px screen side by side. */}
            <span className="inline-flex items-center gap-1 font-semibold tabular-nums sm:hidden">
              {euro(salaryBase(calc))}
              {calc.netto_salary != null && calc.netto_salary !== calc.amount_due && (
                <span className="text-brand-text" title={t('sal.manuallyAdjusted')}>
                  *<span className="sr-only"> {t('sal.manuallyAdjusted')}</span>
                </span>
              )}
            </span>
            <span className="sm:hidden">{statusBadge(calc)}</span>
          </div>
        );
      },
    },
    { id: 'revenue', header: t('sal.col.revenue'), kind: 'currency', value: calc => calc.revenue, sortable: true, hideBelow: 'lg' },
    {
      id: 'ratio',
      header: t('sal.col.ratio'),
      kind: 'number',
      value: calc => calc.salary_ratio,
      cell: calc => formatPercent(calc.salary_ratio, 1),
      hideBelow: 'lg',
    },
    { id: 'revenueShare', header: t('sal.col.revenueShare'), kind: 'currency', value: calc => calc.revenue_share, hideBelow: 'md' },
    { id: 'tips', header: t('sal.col.tips'), kind: 'currency', value: calc => calc.tips, hideBelow: 'md' },
    {
      id: 'total',
      header: t('sal.col.totalSalary'),
      kind: 'currency',
      hideBelow: 'sm',
      value: calc => salaryBase(calc),
      sortable: true,
      cell: calc => (
        <span className="inline-flex items-center justify-end gap-1 font-semibold">
          {euro(salaryBase(calc))}
          {(calc.unrecovered ?? 0) > 0 && (
            <span className="text-caution" title={t('sal.unrecovered.cellHint')}>
              ↓<span className="sr-only"> {t('sal.unrecovered.cellHint')}</span>
            </span>
          )}
          {calc.netto_salary != null && calc.netto_salary !== calc.amount_due && (
            <span className="text-brand-text" title={t('sal.manuallyAdjusted')}>
              *<span className="sr-only"> {t('sal.manuallyAdjusted')}</span>
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'paid',
      header: t('sal.col.paid'),
      kind: 'currency',
      hideBelow: 'sm',
      value: calc => calc.total_paid,
      cell: calc =>
        calc.total_paid ? (
          <span className="font-semibold text-positive">{euro(calc.total_paid)}</span>
        ) : (
          <span className="text-fg-subtle">{euro(0)}</span>
        ),
    },
    {
      id: 'remaining',
      header: t('sal.col.remaining'),
      kind: 'currency',
      hideBelow: 'sm',
      value: calc => calc.remaining_balance,
      sortable: true,
      cell: calc => (
        <span className={cn('font-semibold', calc.remaining_balance > 0 ? 'text-critical' : 'text-fg-subtle')}>
          {euro(Number(calc.remaining_balance))}
        </span>
      ),
    },
    { id: 'status', header: t('common.status'), hideBelow: 'sm', cell: calc => statusBadge(calc) },
  ];

  const header = (actions?: React.ReactNode) => (
    <PageHeader title={t('sal.title')} description={t('sal.subtitle')} actions={actions} />
  );

  // While loadData runs, the old screen rendered a bare spinner and nothing
  // else, which unmounts the payment dialogs below and mounts them afresh once
  // the rows are back — after every payment, since SalaryDetailsModal reloads
  // this list through onUpdate. The loading state keeps that: it returns early,
  // with no dialog and nothing to click.
  if (loading) {
    return (
      <div className="font-ui">
        {header()}
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map(index => (
              <KpiCard key={index} label="" value="" loading />
            ))}
          </div>
          <DataTable caption={t('sal.caption')} columns={columns} rows={[]} getRowId={calc => calc.driver_id} loading />
        </div>
      </div>
    );
  }

  return (
    <div className="font-ui">
      {header(
        <Button
          variant="secondary"
          onClick={handleExport}
          disabled={calculations.length === 0 || loadFailed}
          title={calculations.length === 0 ? t('sal.export.noDataTooltip') : t('common.exportExcelShort')}
        >
          <Download aria-hidden />
          {t('sal.exportExcel')}
        </Button>,
      )}

      <div className="grid grid-cols-1 gap-4">
        {loadFailed ? (
          // Every driver would read as 0,00 € here: the rows the salaries are
          // computed from are what failed to load.
          <Alert
            tone="critical"
            title={t('salaries.loadFailed')}
            action={
              <Button variant="secondary" size="sm" onClick={() => loadData()}>
                <RotateCw aria-hidden />
                {t('ui.table.retry')}
              </Button>
            }
          >
            {t('sal.loadFailedBody')}
          </Alert>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label={t('sal.totalDue')}
              value={euro(totalDue)}
              icon={Wallet}
              caption={t('sal.paidUnpaidCount', { paid: paidCount, unpaid: unpaidCount })}
            />
            <KpiCard label={t('sal.tips')} value={euro(totalTips)} icon={Coins} />
            <KpiCard label={t('sal.revenueShare')} value={euro(totalRevenueShare)} icon={TrendingUp} />
            <KpiCard
              label={t('common.status')}
              value={
                <span className="inline-flex items-center gap-5 text-2xl">
                  <span className="inline-flex items-center gap-1.5 text-positive">
                    <CheckCircle aria-hidden className="size-5" />
                    {paidCount}
                    <span className="sr-only">{t('sal.status.paid')}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-critical">
                    <XCircle aria-hidden className="size-5" />
                    {unpaidCount}
                    <span className="sr-only">{t('sal.status.unpaid')}</span>
                  </span>
                </span>
              }
            />
          </div>
        )}

        {!loadFailed && unrecoveredRows.length > 0 && (
          // A period whose clawbacks (negative Uber figures) exceed what it earned
          // pays no negative wage; this is the amount that could not be taken off.
          // A figure to act on, not a carry-forward.
          <Alert tone="caution" title={t('sal.unrecovered.title')}>
            <p>{t('sal.unrecovered.body')}</p>
            <ul className="mt-2 list-disc pl-5">
              {unrecoveredRows.map(calc => (
                <li key={calc.driver_id}>
                  {t('sal.unrecovered.item', {
                    name: calc.driver_name,
                    amount: euro(calc.unrecovered ?? 0),
                    period: `${formatStoredDate(periodStart)} – ${formatStoredDate(periodEnd)}`,
                  })}
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {!loadFailed && (
          <Card className="grid grid-cols-1 gap-4 p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label={t('common.month')}>
                <Input type="month" value={selectedMonth} onChange={e => handleMonthChange(e.target.value)} />
              </Field>
              <Field label={t('sal.from')}>
                <Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
              </Field>
              <Field label={t('sal.to')}>
                <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
              </Field>
              <Field label={t('common.driver')}>
                <Select
                  value={selectedDriver || ALL_DRIVERS}
                  onValueChange={value => setSelectedDriver(value === ALL_DRIVERS ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_DRIVERS}>{t('common.allDrivers')}</SelectItem>
                    {selectableDrivers(drivers).map(driver => (
                      <SelectItem key={driver.id} value={driver.id}>
                        {driver.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('common.status')}>
                <Select value={selectedStatus} onValueChange={value => setSelectedStatus(value as 'all' | 'paid' | 'unpaid')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* The `value`s are the stored salary status, only the labels translate. */}
                    <SelectItem value="all">{t('common.all')}</SelectItem>
                    <SelectItem value="paid">{t('sal.status.paid')}</SelectItem>
                    <SelectItem value="unpaid">{t('sal.status.unpaid')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                <RefreshCw aria-hidden />
                {t('sal.resetFilters')}
              </Button>
            </div>
          </Card>
        )}

        <DataTable
          caption={t('sal.caption')}
          columns={columns}
          rows={calculations}
          getRowId={calc => calc.driver_id}
          error={loadFailed}
          onRetry={() => loadData()}
          // One action per row, and it is the former $ button's: open the
          // salary's payments. Administrators only, as that button was.
          onRowClick={isAdmin ? calc => setSalaryDetailsModal({ isOpen: true, salary: calc }) : undefined}
          emptyState={<EmptyState size="sm" icon={Users} title={t('sal.noData')} />}
        />
      </div>

      {/* Status Confirmation Modal — still the legacy dialog: nothing opens it
          (openStatusModal has no caller), so there is no state of it to draw. */}
      <ConfirmationModal
        isOpen={statusModal.isOpen}
        onClose={() => setStatusModal({ isOpen: false, salary: null, newStatus: 'unpaid' })}
        onConfirm={handleStatusChange}
        title={statusModal.newStatus === 'paid' ? t('sal.confirm.markPaidTitle') : t('sal.confirm.markUnpaidTitle')}
        message={
          statusModal.salary
            ? t(
                statusModal.newStatus === 'paid' ? 'sal.confirm.markPaidMessage' : 'sal.confirm.markUnpaidMessage',
                { name: statusModal.salary.driver_name, amount: statusModal.salary.amount_due.toFixed(2) },
              )
            : ''
        }
        type={statusModal.newStatus === 'paid' ? 'success' : 'warning'}
      />

      {/* Salary Details and Payments Modal */}
      {salaryDetailsModal.isOpen && salaryDetailsModal.salary && (
        <SalaryDetailsModal
          isOpen={salaryDetailsModal.isOpen}
          onClose={() => setSalaryDetailsModal({ isOpen: false, salary: null })}
          salary={salaryDetailsModal.salary}
          onUpdate={loadData}
          // The calendar button went with the row buttons; the dialog it
          // opened is reachable from here for every driver, overlap or not.
          // This dialog closes first so the two never stack.
          onOpenPeriods={() => {
            const driverId = salaryDetailsModal.salary?.driver_id ?? null;
            setSalaryDetailsModal({ isOpen: false, salary: null });
            setPeriodsDriverId(driverId);
          }}
          // The old eye button's list: this driver's Umsatz, Aktionen and
          // Trinkgeld inside the screen's period, same filter as before.
          revenueTransactions={incomes.filter(
            income =>
              income.driver_name === salaryDetailsModal.salary?.driver_name &&
              income.date >= periodStart &&
              income.date <= periodEnd &&
              (income.type === 'umsatz' || income.type === 'aktionen' || income.type === 'trinkgeld')
          )}
        />
      )}

      {/* Merging a driver's overlapping salary rows */}
      {periodsDriverId && (
        <SalaryPeriodsModal
          isOpen
          onClose={() => setPeriodsDriverId(null)}
          driverName={periodsDriverName}
          rows={rowsByDriver.get(periodsDriverId) ?? []}
          companyId={companyId}
          writeRefusal={writeRefusal}
          onChanged={loadData}
        />
      )}
    </div>
  );
};

export default SalariesManagement;
