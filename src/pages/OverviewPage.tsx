import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDatabase } from '../hooks/useDatabase';
import { useAuth } from '../contexts/AuthContext';
import { usePlan, Plan, PlanState } from '../contexts/PlanContext';
import { Receipt, Driver, Income } from '../types/receipt';
import {
  TrendingUp, TrendingDown, DollarSign, Users, Calendar, BarChart3,
  ArrowUpRight, ArrowDownRight, Wallet, Receipt as ReceiptIcon, Target,
  ChevronRight, AlertTriangle, CheckCircle, Wrench, FileText, Plus,
  AlertCircle, Info, Zap, CreditCard, Building2 as Building2Icon,
  ShieldX, ShieldAlert,
} from 'lucide-react';
import { format, isWithinInterval, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '../lib/supabase';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import type { CashMovementRow } from '../utils/cashLedger';
import { cashLedgerInScope } from '../utils/salaryCashReceiptFlow';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import {
  FixedCostItem, SalaryRecord, DriverRecord, WerkstattCheck, UserProfileRecord,
  PeriodMetrics, DriverPerformance, SalaryAlert, CashSummary, TrendDataPoint,
  ExpenseItem, SmartInsight, RevenueCompositionItem,
  getMonthRange, getPrevMonthString,
  calcPeriodMetrics, calcDeltaPct,
  calcDriverPerformance, calcSalaryAlerts,
  calcCashSummary, buildTrendData,
  getTopExpenses, generateInsights, buildRevenueComposition,
} from '../utils/overviewHelpers';
import { getTuevStatus } from '../types/car';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { ADMIN_BASE } from '../lib/adminGate';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { engineText } from '../i18n/engineMessage';
import { FleetImportPrompt } from '../components/partner/FleetImportPrompt';

const fmt = (n: number) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Delta badge ───────────────────────────────────────────────────────────────
const DeltaBadge: React.FC<{ delta: number | null; higherIsBetter?: boolean }> = ({
  delta,
  higherIsBetter = true,
}) => {
  if (delta === null) return <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>k.V.</span>;
  const positive = higherIsBetter ? delta >= 0 : delta <= 0;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-md"
      style={{
        background: positive ? 'var(--success-subtle)' : 'var(--danger-subtle)',
        color: positive ? 'var(--success)' : 'var(--danger)',
      }}
    >
      {delta >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
};

// ── KPI card ──────────────────────────────────────────────────────────────────
const KpiCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  delta?: number | null;
  higherIsBetter?: boolean;
}> = ({ label, value, sub, icon, iconBg, iconColor, delta, higherIsBetter }) => (
  <div
    className="rounded-2xl p-5 flex flex-col gap-3 transition-all duration-200 cursor-default"
    style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; }}
  >
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <div className="rounded-xl p-2" style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
    </div>
    <div>
      <p className="text-2xl font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>{value}</p>
      <div className="flex items-center gap-2 mt-1">
        {sub && <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
        {delta !== undefined && (
          <DeltaBadge delta={delta ?? null} higherIsBetter={higherIsBetter} />
        )}
      </div>
    </div>
  </div>
);

// ── Custom tooltip ────────────────────────────────────────────────────────────
const ChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl p-3 text-sm"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <p className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} style={{ color: entry.color }} className="flex justify-between gap-4">
          <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
          <span className="font-semibold" style={{ color: entry.color }}>{fmt(entry.value)} €</span>
        </p>
      ))}
    </div>
  );
};

// ── Alert row ─────────────────────────────────────────────────────────────────
const AlertRow: React.FC<{
  type: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  body: string;
}> = ({ type, title, body }) => {
  const s = {
    danger:  { bg: 'var(--danger-subtle)',  border: 'var(--danger)',  icon: <AlertCircle  size={16} style={{ color: 'var(--danger)'  }} className="flex-shrink-0" /> },
    warning: { bg: 'var(--warning-subtle)', border: 'var(--warning)', icon: <AlertTriangle size={16} style={{ color: 'var(--warning)' }} className="flex-shrink-0" /> },
    info:    { bg: 'var(--accent-subtle)',  border: 'var(--accent)',   icon: <Info          size={16} style={{ color: 'var(--accent-text)'}} className="flex-shrink-0" /> },
    success: { bg: 'var(--success-subtle)', border: 'var(--success)', icon: <CheckCircle   size={16} style={{ color: 'var(--success)' }} className="flex-shrink-0" /> },
  }[type];
  return (
    <div
      className="flex items-start gap-2.5 p-3 rounded-xl"
      style={{ background: s.bg, border: `1px solid ${s.border}33` }}
    >
      {s.icon}
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{body}</p>
      </div>
    </div>
  );
};

// ── Section header ────────────────────────────────────────────────────────────
const SectionHeader: React.FC<{
  title: string; sub?: string; icon: React.ReactNode; action?: React.ReactNode;
}> = ({ title, sub, icon, action }) => (
  <div className="flex items-center justify-between mb-5">
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>
        {icon}
      </div>
      <div>
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
      </div>
    </div>
    {action}
  </div>
);

// ── Panel wrapper ─────────────────────────────────────────────────────────────
const Panel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div
    className={`rounded-2xl p-5 ${className}`}
    style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}
  >
    {children}
  </div>
);

// ── Plan status card ─────────────────────────────────────────────────────────

const PLAN_LABEL: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };
const PLAN_COLOR: Record<Plan, string> = { basic: 'var(--accent)', advanced: '#f59e0b', premium: '#10b981' };
// Keys, not text: this map lives outside any component, and t() is a hook value.
const STATUS_LABEL: Record<string, TranslationKey> = {
  trial:         'overview.status.trial',
  active:        'overview.status.active',
  trial_expired: 'overview.status.trialExpired',
  suspended:     'overview.status.suspended',
  inactive:      'overview.status.inactive',
};

const PlanStatusCard: React.FC<{ planState: PlanState; effectivePlan: Plan }> = ({ planState, effectivePlan }) => {
  const { t, tPlural } = useTranslation();
  const color = planState.isInTrial ? 'var(--accent)' : PLAN_COLOR[planState.plan];
  const trialEndStr = planState.trialEnd
    ? planState.trialEnd.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
    : null;

  return (
    <div
      className="flex items-center justify-between gap-4 p-4 rounded-2xl flex-wrap"
      style={{
        background: `${color}12`,
        border: `1px solid ${color}30`,
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `${color}20` }}
        >
          <Zap size={18} style={{ color }} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
              {planState.isInTrial
                ? t('overview.plan.trialUnlocked', { plan: PLAN_LABEL[effectivePlan] })
                : t('overview.plan.named', { plan: PLAN_LABEL[planState.plan] })
              }
            </span>
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: `${color}20`, color }}
            >
              {STATUS_LABEL[planState.status] ? t(STATUS_LABEL[planState.status]) : planState.status}
            </span>
          </div>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {planState.isInTrial && trialEndStr
              ? tPlural(
                  { one: 'overview.plan.trialLeft.one', other: 'overview.plan.trialLeft.other' },
                  planState.trialDaysLeft,
                  { date: trialEndStr },
                )
              : planState.isTrialExpired && trialEndStr
                ? t('overview.plan.trialEnded', { date: trialEndStr })
                : t('overview.plan.activeSub')
            }
          </p>
        </div>
      </div>

      {(planState.isInTrial || planState.isTrialExpired) && (
        <a
          href="mailto:support@el-professor.de?subject=Plan upgraden"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold flex-shrink-0 transition-opacity hover:opacity-80"
          style={{ background: color, color: 'white' }}
        >
          <Zap size={12} />
          {t('trial.choosePlan')}
        </a>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
const OverviewPage: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const { isSuperAdmin, companyId: ownCompanyId } = useAuth();
  const {
    effectiveCompanyId: companyId, isViewingAsCompany, platformReadsCompanyData, ownCompanyReadable,
  } = useSuperAdmin();
  // cash_movements answers for the caller's active company, and — since 3.4 —
  // for a platform account only inside a support session open on that
  // company. Outside both the ledger reads empty, so the payout line below
  // stays hidden rather than reporting a zero it never read.
  const ledgerInScope = cashLedgerInScope({
    companyId: ownCompanyId,
    effectiveCompanyId: companyId,
    isViewingAsCompany,
    // The seam as the database now answers it: business.read *and* a live
    // context on this company. The capability alone reads nothing since
    // 20260917140000, so passing it here would make this guard a rubber stamp.
    platformReadsCompanyData,
    // And the own company only while the database still admits it.
    ownCompanyReadable,
  });
  const { planState, effectivePlan } = usePlan();
  const { receipts: receiptActions, drivers: driverActions, isLoading: dbLoading } = useDatabase();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [fixedCosts, setFixedCosts] = useState<FixedCostItem[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [salaries, setSalaries] = useState<SalaryRecord[]>([]);
  const [werkstattChecks, setWerkstattChecks] = useState<WerkstattCheck[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfileRecord[]>([]);
  const [cars, setCars] = useState<{ id: string; kennzeichen: string; tuev_gueltig_bis: string | null }[]>([]);
  // The cash ledger: Gehaltsquittungen and their Stornos, the cash salaries
  // take out of the till. Written only by confirm_salary_cash_payment and
  // void_salary_cash_receipt.
  const [cashMovements, setCashMovements] = useState<CashMovementRow[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!dbLoading) loadData();
  }, [dbLoading]);

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [receiptsData, driversData] = await Promise.all([
        receiptActions.get(),
        driverActions.get(),
      ]);
      setReceipts(receiptsData);
      setDrivers(driversData);
      await Promise.all([
        loadFixedCosts(), loadIncomes(), loadSalaries(),
        loadWerkstattChecks(), loadUserProfiles(), loadCars(),
        loadCashMovements(),
      ]);
    } catch (err) {
      // Previously swallowed: a failed query left every array empty and the
      // dashboard rendered a confident 0,00 € instead of admitting it had no
      // data. Say so rather than presenting a wrong number as a real one.
      console.error('Error loading data:', err);
      setLoadError(err instanceof Error ? err.message : t('overview.error.unknown'));
    } finally {
      setLoading(false);
    }
  };

  // All three were unpaginated. PostgREST caps a response at 1000 rows without
  // reporting it, so past that point the dashboard's Umsatz and Gewinn figures
  // were simply wrong — computed from a partial income table. They also dropped
  // their error, turning a failed query into a plausible-looking zero.
  const loadFixedCosts = async () => {
    setFixedCosts(await fetchAllPaginated<any>(
      (from, to) => supabase
        .from('fixed_costs')
        // `period_month` and `created_at` are what make a fixed cost belong to a
        // month (`20261003110000`). Without them every row reads as the baseline
        // and the Overview sums every month the company has ever recorded into
        // one Gewinn figure.
        .select('id, description, amount, period_month, created_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
      { label: t('overview.load.fixkosten') },
    ));
  };
  const loadIncomes = async () => {
    setIncomes(await fetchAllPaginated<Income>(
      (from, to) => supabase
        .from('income')
        .select('*')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
      { label: t('overview.load.umsaetze') },
    ));
  };
  const loadSalaries = async () => {
    setSalaries(await fetchAllPaginated<any>(
      (from, to) => supabase
        .from('salaries')
        .select('*')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
      { label: t('overview.load.gehaelter') },
    ));
  };
  const loadWerkstattChecks = async () => {
    const { data } = await supabase
      .from('werkstatt_checks')
      .select('id, car_id, status, check_date, notes, car:cars(kennzeichen)')
      .eq('company_id', companyId)
      .order('check_date', { ascending: false })
      .limit(50);
    setWerkstattChecks((data as WerkstattCheck[]) || []);
  };
  const loadUserProfiles = async () => {
    const { data } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, status, invited_at')
      .eq('company_id', companyId);
    setUserProfiles(data || []);
  };
  const loadCars = async () => {
    const { data } = await supabase
      .from('cars')
      .select('id, kennzeichen, tuev_gueltig_bis')
      .eq('company_id', companyId);
    setCars(data || []);
  };
  // Paginated like the other three: a company that pays every salary in cash
  // passes 1000 movements in under three years, and PostgREST truncates
  // without saying so.
  const loadCashMovements = async () => {
    if (!ledgerInScope) {
      setCashMovements([]);
      return;
    }
    setCashMovements(await fetchAllPaginated<CashMovementRow>(
      (from, to) => supabase
        .from('cash_movements')
        .select('id, direction, amount, movement_date, source_type, source_id, description')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
      { label: t('overview.load.bargeld') },
    ));
  };

  // ── Derived data ─────────────────────────────────────────────────────────
  const { start: monthStart, end: monthEnd } = getMonthRange(selectedMonth);
  const prevMonthStr = getPrevMonthString(selectedMonth);
  const { start: prevStart, end: prevEnd } = getMonthRange(prevMonthStr);

  const driverRecords: DriverRecord[] = drivers.map(d => ({
    id: d.id, name: d.name,
    salary_ratio: d.salary_ratio ?? d.salaryRatio,
    status: d.status,
  }));

  const currentMetrics = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, monthStart, monthEnd);
  const prevMetrics    = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, prevStart, prevEnd);

  const umsatzDelta   = calcDeltaPct(currentMetrics.umsatz, prevMetrics.umsatz);
  const bargeldDelta  = calcDeltaPct(currentMetrics.bargeld, prevMetrics.bargeld);
  const salariesDelta = calcDeltaPct(currentMetrics.salaries, prevMetrics.salaries);
  const costsDelta    = calcDeltaPct(currentMetrics.totalCosts, prevMetrics.totalCosts);
  const profitDelta   = calcDeltaPct(currentMetrics.profit, prevMetrics.profit);
  const marginDelta   = prevMetrics.profitMargin !== 0
    ? currentMetrics.profitMargin - prevMetrics.profitMargin : null;

  const driverPerformance = calcDriverPerformance(driverRecords, incomes, salaries, receipts, monthStart, monthEnd);
  const salaryAlerts      = calcSalaryAlerts(salaries, driverRecords);
  const cashSummary       = calcCashSummary(incomes, receipts, monthStart, monthEnd, cashMovements);
  const trendData         = buildTrendData(selectedMonth, incomes, salaries, receipts, fixedCosts, t);
  const topExpenses       = getTopExpenses(receipts, fixedCosts, monthStart, monthEnd, 5);
  const insights          = generateInsights(currentMetrics, prevMetrics, driverPerformance, salaryAlerts, werkstattChecks);
  // overviewHelpers writes German and names a key beside it; translating here
  // covers the legend and the chart tooltip, which reads `name` off the datum.
  const revenueComposition = buildRevenueComposition(currentMetrics)
    .map(d => ({ ...d, name: engineText(t, d.name, d.nameKey) }));

  const recentReceipts = [...receipts]
    .filter(r => isWithinInterval(new Date(r.date), { start: monthStart, end: monthEnd }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5);

  const currentMonthChecks = werkstattChecks.filter(c =>
    isWithinInterval(new Date(c.check_date), { start: monthStart, end: monthEnd })
  );
  const fleetOk       = currentMonthChecks.filter(c => c.status === 'positive').length;
  const fleetIssues   = currentMonthChecks.filter(c => c.status === 'negative').length;
  const fleetRepaired = currentMonthChecks.filter(c => c.status === 'repaired').length;

  const pendingInvites = userProfiles.filter(u => u.invited_at && u.status !== 'active').length;
  const totalOpenSalary = salaryAlerts.reduce((s, a) => s + a.remaining, 0);
  const unpaidCount     = salaryAlerts.filter(a => a.status === 'unpaid').length;
  const partialCount    = salaryAlerts.filter(a => a.status === 'partially_paid').length;

  const tuevAbgelaufen    = cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'abgelaufen');
  const tuevBaldAblaufend = cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'bald_ablaufend');

  const hasAlerts = salaryAlerts.length > 0 || pendingInvites > 0 || fleetIssues > 0
    || tuevAbgelaufen.length > 0 || tuevBaldAblaufend.length > 0;

  if (loading || dbLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: 'var(--accent)' }} />
      </div>
    );
  }

  // Chart colors that work on both themes
  const C = {
    umsatz: '#3b82f6',
    gewinn: '#10b981',
    gehaelter: '#f59e0b',
    kosten: '#ef4444',
    grid: 'var(--border)',
    tick: 'var(--text-tertiary)',
  };

  return (
    <div className="space-y-5 pb-8">

      {/* A failed load used to render as 0,00 € everywhere. Say what happened. */}
      {loadError && (
        <div
          className="p-4 rounded-2xl text-sm"
          style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', color: 'var(--danger)' }}
        >
          <strong>{t('overview.error.partial')}</strong>{' '}
          {t('overview.error.partialBody', { reason: loadError })}
        </div>
      )}

      {/* ── Super Admin Banner ── */}
      {isSuperAdmin && (
        <Link
          to={ADMIN_BASE}
          className="flex items-center justify-between p-4 rounded-2xl transition-all group"
          style={{
            background: 'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(245,158,11,0.05) 100%)',
            border: '1px solid rgba(245,158,11,0.4)',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(245,158,11,0.2)' }}>
              <Building2Icon size={20} style={{ color: '#f59e0b' }} />
            </div>
            <div>
              <p className="font-bold text-sm" style={{ color: '#f59e0b' }}>{t('overview.superAdmin.title')}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {t('overview.superAdmin.sub')}
              </p>
            </div>
          </div>
          <ChevronRight size={18} style={{ color: '#f59e0b' }} className="group-hover:translate-x-1 transition-transform" />
        </Link>
      )}

      {/* ── Plan / Trial Status Card ── */}
      {!isSuperAdmin && (
        <PlanStatusCard planState={planState} effectivePlan={effectivePlan} />
      )}

      {/* ── Fleet import: only for an empty company whose counts were read ── */}
      {!isSuperAdmin && <FleetImportPrompt />}

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {t('overview.title')}
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {format(parseISO(selectedMonth + '-01'), 'MMMM yyyy', { locale: de })}
            {' · '}{t('overview.comparedWith')}{' '}
            {format(parseISO(prevMonthStr + '-01'), 'MMMM yyyy', { locale: de })}
          </p>
        </div>
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2 self-start"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <Calendar size={15} style={{ color: 'var(--text-tertiary)' }} />
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="text-sm font-medium bg-transparent focus:outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      {/* ── Smart insights ── */}
      {insights.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {insights.map((ins, i) => (
            <AlertRow
              key={i}
              type={ins.type}
              title={engineText(t, ins.title, ins.titleKey, ins.titleVars)}
              body={engineText(t, ins.body, ins.bodyKey, ins.bodyVars)}
            />
          ))}
        </div>
      )}

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label={t('overview.kpi.umsatz')} value={`${fmt(currentMetrics.umsatz)} €`} sub={t('overview.kpi.vsPrevMonth')}
          icon={<TrendingUp size={18} />} iconBg="rgba(16,185,129,0.12)" iconColor="#10b981"
          delta={umsatzDelta} higherIsBetter />
        <KpiCard label={t('overview.kpi.bargeld')} value={`${fmt(currentMetrics.bargeld)} €`} sub={t('overview.kpi.vsPrevMonth')}
          icon={<Wallet size={18} />} iconBg="rgba(20,184,166,0.12)" iconColor="#14b8a6"
          delta={bargeldDelta} higherIsBetter />
        <KpiCard label={t('overview.load.gehaelter')} value={`${fmt(currentMetrics.salaries)} €`} sub={t('overview.kpi.vsPrevMonth')}
          icon={<Users size={18} />} iconBg="rgba(245,158,11,0.12)" iconColor="#f59e0b"
          delta={salariesDelta} higherIsBetter={false} />
        <KpiCard label={t('overview.kpi.gesamtkosten')} value={`${fmt(currentMetrics.totalCosts)} €`} sub={t('overview.kpi.costBasis')}
          icon={<TrendingDown size={18} />} iconBg="rgba(239,68,68,0.12)" iconColor="#ef4444"
          delta={costsDelta} higherIsBetter={false} />
        <KpiCard label={t('overview.kpi.firmengewinn')} value={`${fmt(currentMetrics.profit)} €`} sub={t('overview.kpi.vsPrevMonth')}
          icon={<DollarSign size={18} />}
          iconBg={currentMetrics.profit >= 0 ? 'rgba(59,130,246,0.12)' : 'rgba(239,68,68,0.12)'}
          iconColor={currentMetrics.profit >= 0 ? '#3b82f6' : '#ef4444'}
          delta={profitDelta} higherIsBetter />
        <KpiCard label={t('overview.kpi.gewinnmarge')}
          value={`${currentMetrics.profitMargin.toFixed(1)}%`}
          sub={marginDelta !== null ? `${marginDelta >= 0 ? '+' : ''}${marginDelta.toFixed(1)}pp` : t('overview.kpi.profitability')}
          icon={<Target size={18} />}
          iconBg={currentMetrics.profitMargin >= 0 ? 'rgba(14,165,233,0.12)' : 'rgba(239,68,68,0.12)'}
          iconColor={currentMetrics.profitMargin >= 0 ? '#0ea5e9' : '#ef4444'} />
      </div>

      {/* ── Action alerts ── */}
      {hasAlerts && (
        <Panel>
          <SectionHeader title={t('overview.alerts.title')} sub={t('overview.alerts.sub')} icon={<AlertTriangle size={16} />} />
          <div className="space-y-2">
            {unpaidCount > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(239,68,68,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <AlertCircle size={16} style={{ color: 'var(--danger)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.unpaidSalaries.one', other: 'overview.alerts.unpaidSalaries.other' }, unpaidCount)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('overview.alerts.totalOpen', { amount: `${fmt(totalOpenSalary)} €` })}</p>
                  </div>
                </div>
                <Link to="/gehaelter" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--danger)' }}>
                  {t('overview.alerts.manage')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
            {partialCount > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--warning-subtle)', border: '1px solid rgba(245,158,11,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <AlertTriangle size={16} style={{ color: 'var(--warning)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.partialSalaries.one', other: 'overview.alerts.partialSalaries.other' }, partialCount)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {t('overview.alerts.remaining', { amount: `${fmt(salaryAlerts.filter(a => a.status === 'partially_paid').reduce((s, a) => s + a.remaining, 0))} €` })}
                    </p>
                  </div>
                </div>
                <Link to="/gehaelter" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                  {t('overview.alerts.manage')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
            {fleetIssues > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(239,68,68,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <Wrench size={16} style={{ color: 'var(--danger)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.negativeCheck.one', other: 'overview.alerts.negativeCheck.other' }, fleetIssues)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('overview.alerts.checkWerkstatt')}</p>
                  </div>
                </div>
                <Link to="/werkstatt" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--danger)' }}>
                  {t('nav.werkstatt')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
            {tuevAbgelaufen.length > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(239,68,68,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <ShieldX size={16} style={{ color: 'var(--danger)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.tuevExpired.one', other: 'overview.alerts.tuevExpired.other' }, tuevAbgelaufen.length)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {tuevAbgelaufen.map(c => c.kennzeichen).join(', ')}
                    </p>
                  </div>
                </div>
                <Link to="/cars" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--danger)' }}>
                  {t('nav.cars')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
            {tuevBaldAblaufend.length > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--warning-subtle)', border: '1px solid rgba(245,158,11,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <ShieldAlert size={16} style={{ color: 'var(--warning)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.tuevSoon.one', other: 'overview.alerts.tuevSoon.other' }, tuevBaldAblaufend.length)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {tuevBaldAblaufend.map(c => c.kennzeichen).join(', ')}
                    </p>
                  </div>
                </div>
                <Link to="/cars" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                  {t('nav.cars')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
            {pendingInvites > 0 && (
              <div
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--accent-subtle)', border: '1px solid rgba(6,182,212,0.2)' }}
              >
                <div className="flex items-center gap-2.5">
                  <Info size={16} style={{ color: 'var(--accent-text)' }} className="flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {tPlural({ one: 'overview.alerts.pendingInvites.one', other: 'overview.alerts.pendingInvites.other' }, pendingInvites)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('overview.alerts.notAccepted')}</p>
                  </div>
                </div>
                <Link to="/benutzer" className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--accent-text)' }}>
                  {t('nav.users')} <ChevronRight size={12} />
                </Link>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ── Charts row 1: trend + revenue mix ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel className="xl:col-span-2">
          <SectionHeader title={t('overview.trend.title')} sub={t('overview.trend.sub')} icon={<BarChart3 size={16} />} />
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gU" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.umsatz} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={C.umsatz} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.gewinn} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={C.gewinn} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="monat" tick={{ fontSize: 12, fill: C.tick }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: C.tick }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8, color: C.tick }} />
              <Area type="monotone" dataKey={t('overview.kpi.umsatz')}   stroke={C.umsatz}   strokeWidth={2} fill="url(#gU)"   dot={false} />
              <Area type="monotone" dataKey={t('overview.chart.gewinn')}   stroke={C.gewinn}   strokeWidth={2} fill="url(#gG)"   dot={false} />
              <Area type="monotone" dataKey={t('overview.load.gehaelter')} stroke={C.gehaelter} strokeWidth={1.5} fill="transparent" strokeDasharray="4 2" dot={false} />
              <Area type="monotone" dataKey={t('overview.chart.kosten')}   stroke={C.kosten}   strokeWidth={1.5} fill="transparent" strokeDasharray="4 2" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.mix.title')} sub={t('overview.mix.sub')} icon={<DollarSign size={16} />} />
          {revenueComposition.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={revenueComposition} cx="50%" cy="50%" innerRadius={42} outerRadius={65} paddingAngle={3} dataKey="value">
                    {revenueComposition.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => `${fmt(v)} €`}
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: '0.75rem',
                      color: 'var(--text-primary)',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-3 space-y-2">
                {revenueComposition.map(d => {
                  const total = revenueComposition.reduce((s, x) => s + x.value, 0);
                  const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : '0';
                  return (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: d.color }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{fmt(d.value)} €</span>
                        <span className="w-7 text-right" style={{ color: 'var(--text-tertiary)' }}>{pct}%</span>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between text-xs pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('overview.common.gesamt')}</span>
                  <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                    {fmt(revenueComposition.reduce((s, d) => s + d.value, 0))} €
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('overview.mix.none')}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Profit + Cash ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel className="flex flex-col">
          <SectionHeader title={t('overview.profit.title')} sub={format(parseISO(selectedMonth + '-01'), 'MMMM yyyy', { locale: de })} icon={<Target size={16} />} />
          <div className="flex-1 flex flex-col gap-2">
            {[
              { label: t('overview.profit.netFare'), value: currentMetrics.nettoFahrpreis, sign: '+', color: '#10b981', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)', icon: <TrendingUp size={13} /> },
              { label: t('overview.profit.aktionen'),        value: currentMetrics.aktionen,       sign: '+', color: '#0ea5e9', bg: 'rgba(14,165,233,0.08)',  border: 'rgba(14,165,233,0.2)',  icon: <Zap size={13} /> },
              { label: t('overview.load.gehaelter'),        value: currentMetrics.salaries,       sign: '-', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.2)',  icon: <Users size={13} /> },
              { label: t('overview.profit.belegeExpenses'), value: currentMetrics.expenses,     sign: '-', color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)',   icon: <ReceiptIcon size={13} /> },
              { label: t('overview.load.fixkosten'),       value: currentMetrics.fixedCosts,     sign: '-', color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)',   icon: <TrendingDown size={13} /> },
            ].map(row => (
              <div
                key={row.label}
                className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: row.bg, border: `1px solid ${row.border}` }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: row.bg, color: row.color, border: `1px solid ${row.border}` }}>
                    {row.icon}
                  </div>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{row.label}</span>
                </div>
                <span className="text-sm font-bold" style={{ color: row.color }}>
                  {row.sign}{fmt(row.value)} €
                </span>
              </div>
            ))}
            <div
              className="flex items-center justify-between p-4 rounded-xl mt-1"
              style={{ background: currentMetrics.profit >= 0 ? '#1d4ed8' : '#b91c1c' }}
            >
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center">
                  <DollarSign size={14} className="text-white" />
                </div>
                <span className="text-sm font-bold text-white">{t('overview.kpi.firmengewinn')}</span>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-white">
                  {currentMetrics.profit >= 0 ? '+' : ''}{fmt(currentMetrics.profit)} €
                </p>
                <p className="text-xs text-white/80">{t('overview.profit.margin', { value: currentMetrics.profitMargin.toFixed(1) })}</p>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs px-1 pt-1" style={{ color: 'var(--text-tertiary)' }}>
              <span>{t('overview.profit.prevMonth', { amount: `${fmt(prevMetrics.profit)} €` })}</span>
              <DeltaBadge delta={profitDelta} higherIsBetter />
            </div>
          </div>
        </Panel>

        <Panel className="flex flex-col">
          <SectionHeader title={t('overview.cash.title')} sub={t('overview.cash.sub')} icon={<Wallet size={16} />} />
          <div className="flex flex-col gap-3 flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: '#10b981' }}>{t('overview.cash.income')}</p>
                <p className="text-xl font-bold" style={{ color: '#10b981' }}>{fmt(cashSummary.cashIncome)} €</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('overview.cash.driverCash')}</p>
              </div>
              <div className="p-4 rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: '#ef4444' }}>{t('overview.cash.belegExpenses')}</p>
                <p className="text-xl font-bold" style={{ color: '#ef4444' }}>{fmt(cashSummary.cashFromExpenses)} €</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('overview.cash.belegCash')}</p>
              </div>
            </div>

            <div
              className="p-4 rounded-xl"
              style={{
                background: cashSummary.cashRisk === 'ok'
                  ? 'rgba(59,130,246,0.08)'
                  : cashSummary.cashRisk === 'warning'
                  ? 'rgba(245,158,11,0.08)'
                  : 'rgba(239,68,68,0.08)',
                border: `1px solid ${cashSummary.cashRisk === 'ok' ? 'rgba(59,130,246,0.2)' : cashSummary.cashRisk === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)'}`,
              }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1"
                    style={{ color: cashSummary.cashRisk === 'ok' ? '#3b82f6' : cashSummary.cashRisk === 'warning' ? '#f59e0b' : '#ef4444' }}>
                    {t('overview.cash.balanceNet')}
                  </p>
                  <p className="text-2xl font-bold"
                    style={{ color: cashSummary.cashBalance >= 0 ? '#3b82f6' : '#ef4444' }}>
                    {cashSummary.cashBalance >= 0 ? '' : '-'}{fmt(Math.abs(cashSummary.cashBalance))} €
                  </p>
                </div>
                <div
                  className="p-2.5 rounded-xl"
                  style={{ background: cashSummary.cashRisk === 'ok' ? 'rgba(59,130,246,0.15)' : 'rgba(245,158,11,0.15)' }}
                >
                  <Wallet size={22} style={{ color: cashSummary.cashRisk === 'ok' ? '#3b82f6' : '#f59e0b' }} />
                </div>
              </div>
              {ledgerInScope && cashSummary.salaryPayouts !== 0 && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                  {/*
                    The sign comes from the value, never as a literal: voiding a
                    Gehaltsquittung books the cash back on the day of the void,
                    so a receipt paid in March and voided in April makes April's
                    payout −300, and a literal minus in front of an already
                    signed number renders "−-300,00 €". A negative payout is
                    money coming back into the till, and reads as +.
                  */}
                  {t('overview.cash.salaryPayouts')}:{' '}
                  {cashSummary.salaryPayouts < 0 ? '+' : '−'}{fmt(Math.abs(cashSummary.salaryPayouts))} €
                </p>
              )}
              {cashSummary.cashRisk !== 'ok' && (
                <div className="flex items-center gap-1.5 mt-2">
                  <AlertTriangle size={12} style={{ color: '#f59e0b' }} />
                  <p className="text-xs font-medium" style={{ color: '#f59e0b' }}>
                    {cashSummary.cashRisk === 'warning' ? t('overview.cash.low') : t('overview.cash.negative')}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-xs p-3 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{t('overview.cash.ratio')}</span>
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {cashSummary.cashIncome > 0
                  ? t('overview.cash.spentPct', { value: ((cashSummary.cashOut / cashSummary.cashIncome) * 100).toFixed(0) })
                  : '—'}
              </span>
            </div>

            <Link
              to="/bargeldbestand"
              className="flex items-center justify-between p-3 rounded-xl transition-colors group"
              style={{ background: 'var(--bg-subtle)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
            >
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('overview.cash.detailed')}</span>
              <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} />
            </Link>
          </div>
        </Panel>
      </div>

      {/* ── Driver performance ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel className="xl:col-span-2">
          <SectionHeader title={t('overview.drivers.title')} sub={t('overview.drivers.sub')} icon={<Users size={16} />} />
          {driverPerformance.filter(d => d.umsatz > 0).length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(180, driverPerformance.filter(d => d.umsatz > 0).length * 40)}>
              <BarChart
                /* The series key is the <Bar> dataKey, so both come from the same
                   t(...) call: hard-coded German keys left every bar empty in the
                   English UI. */
                data={driverPerformance.filter(d => d.umsatz > 0).slice(0, 8).map(d => ({
                  name: d.name,
                  [t('overview.kpi.umsatz')]:       d.umsatz,
                  [t('overview.drivers.gehalt')]:   d.salary,
                  [t('overview.drivers.ausgaben')]: d.expenses,
                }))}
                layout="vertical"
                margin={{ top: 0, right: 10, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: C.tick }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 11, fill: C.tick }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 12, color: C.tick }} />
                <Bar dataKey={t('overview.kpi.umsatz')}   fill={C.umsatz}   radius={[0, 3, 3, 0]} barSize={8} />
                <Bar dataKey={t('overview.drivers.gehalt')}   fill={C.gehaelter} radius={[0, 3, 3, 0]} barSize={8} />
                <Bar dataKey={t('overview.drivers.ausgaben')} fill={C.kosten}   radius={[0, 3, 3, 0]} barSize={8} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('overview.drivers.noneMonth')}
            </div>
          )}
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.drivers.ranking')} sub={t('overview.drivers.rankingSub')} icon={<Target size={16} />} />
          {driverPerformance.length > 0 ? (
            <div className="space-y-2.5">
              {driverPerformance.map((driver, idx) => {
                const maxUmsatz = Math.max(...driverPerformance.map(d => d.umsatz), 1);
                const barPct = Math.max((driver.umsatz / maxUmsatz) * 100, 0);
                const isTop = idx === 0;
                const isWorst = idx === driverPerformance.length - 1 && driverPerformance.length > 1;
                return (
                  <div
                    key={driver.id}
                    className="p-3 rounded-xl transition-colors cursor-default"
                    style={{
                      background: isTop ? 'rgba(16,185,129,0.08)' : 'transparent',
                      border: isTop ? '1px solid rgba(16,185,129,0.2)' : '1px solid transparent',
                    }}
                    onMouseEnter={e => {
                      if (!isTop) (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)';
                    }}
                    onMouseLeave={e => {
                      if (!isTop) (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-5 text-xs font-bold flex-shrink-0 text-center" style={{ color: isTop ? '#10b981' : 'var(--text-tertiary)' }}>
                        {idx + 1}
                      </span>
                      <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}>
                        <span className="text-xs font-bold">{driver.name.charAt(0).toUpperCase()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{driver.name}</p>
                          <span className="text-xs font-bold ml-1 flex-shrink-0" style={{ color: driver.netContribution >= 0 ? '#10b981' : '#ef4444' }}>
                            {driver.netContribution >= 0 ? '+' : ''}{fmt(driver.netContribution)} €
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-muted)' }}>
                          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: 'var(--accent)' }} />
                        </div>
                        {driver.profitMargin !== null && (
                          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {t('overview.drivers.marginLabel')} <strong style={{ color: 'var(--text-secondary)' }}>{driver.profitMargin.toFixed(0)}%</strong>
                            {' · '}{t('overview.drivers.revenueSuffix', { amount: fmt(driver.umsatz) })}
                          </p>
                        )}
                      </div>
                      {isTop && <span className="text-xs font-semibold px-1.5 py-0.5 rounded-md flex-shrink-0" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>{t('overview.drivers.top')}</span>}
                      {isWorst && driver.netContribution < 0 && <span className="text-xs font-semibold px-1.5 py-0.5 rounded-md flex-shrink-0" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>{t('overview.drivers.attention')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('overview.drivers.none')}</div>
          )}
        </Panel>
      </div>

      {/* ── Expenses + Fleet ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel>
          <SectionHeader title={t('overview.costs.title')} sub={t('overview.costs.sub')} icon={<TrendingDown size={16} />} />
          {topExpenses.length > 0 ? (
            <div className="space-y-2">
              {topExpenses.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-xl transition-colors cursor-default"
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: item.type === 'fixed' ? 'var(--bg-muted)' : 'var(--danger-subtle)' }}
                  >
                    {item.type === 'fixed'
                      ? <CreditCard size={14} style={{ color: 'var(--text-tertiary)' }} />
                      : <ReceiptIcon size={14} style={{ color: 'var(--danger)' }} />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.description}</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {item.type === 'fixed' ? t('overview.load.fixkosten') : item.driverName || t('bargeld.beleg')}
                      {item.type === 'receipt' && ` · ${format(new Date(item.date), 'dd.MM.yyyy')}`}
                    </p>
                  </div>
                  <span className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--danger)' }}>-{fmt(item.amount)} €</span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs px-1 pt-2" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-tertiary)' }}>
                <span>{t('overview.costs.total')}</span>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{fmt(currentMetrics.totalCosts)} €</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('overview.costs.none')}</div>
          )}
        </Panel>

        <Panel>
          <SectionHeader
            title={t('overview.fleet.title')} sub={t('overview.fleet.sub')} icon={<Wrench size={16} />}
            action={
              <Link to="/werkstatt" className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-text)' }}>
                {t('common.all')} <ChevronRight size={12} />
              </Link>
            }
          />
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: 'OK', value: fleetOk, color: '#10b981', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)' },
              { label: t('overview.fleet.problems'), value: fleetIssues, color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.2)' },
              { label: t('overview.fleet.repaired'), value: fleetRepaired, color: '#3b82f6', bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.2)' },
            ].map(s => (
              <div key={s.label} className="p-3 rounded-xl text-center" style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                <p className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</p>
                <p className="text-xs font-medium mt-0.5" style={{ color: s.color }}>{s.label}</p>
              </div>
            ))}
          </div>

          {currentMonthChecks.length > 0 ? (
            <div className="space-y-2">
              {currentMonthChecks.filter(c => c.status === 'negative').slice(0, 3).map(c => (
                <div key={c.id} className="flex items-center gap-2.5 p-2.5 rounded-lg"
                  style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <AlertCircle size={14} style={{ color: 'var(--danger)' }} className="flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{c.car?.kennzeichen || t('overview.common.unknown')}</p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{c.notes}</p>
                  </div>
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                    {format(new Date(c.check_date), 'dd.MM')}
                  </span>
                </div>
              ))}
              {currentMonthChecks.filter(c => c.status === 'negative').length === 0 && (
                <div className="flex items-center gap-2 p-2.5 text-xs rounded-lg"
                  style={{ background: 'rgba(16,185,129,0.08)', color: '#10b981' }}
                >
                  <CheckCircle size={14} />
                  {t('overview.fleet.noNegative')}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('overview.fleet.noChecks')}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Unpaid salaries ── */}
      {salaryAlerts.length > 0 && (
        <Panel>
          <SectionHeader
            title={t('overview.salaries.title')} sub={t('overview.salaries.sub')} icon={<CreditCard size={16} />}
            action={
              <Link to="/gehaelter" className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-text)' }}>
                {t('overview.alerts.manage')} <ChevronRight size={12} />
              </Link>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {[t('overview.salaries.driver'), t('overview.salaries.due'), t('overview.salaries.paid'), t('overview.salaries.open'), t('overview.salaries.status')].map((h, i) => (
                    <th key={h} className={`py-2 px-3 text-xs font-semibold uppercase ${i === 0 ? 'text-left' : i === 4 ? 'text-center' : 'text-right'}`} style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {salaryAlerts.map(alert => (
                  <tr
                    key={alert.id}
                    className="transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}>
                          <span className="text-xs font-bold">{alert.driverName.charAt(0).toUpperCase()}</span>
                        </div>
                        <div>
                          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{alert.driverName}</p>
                          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {format(new Date(alert.periodStart), 'dd.MM')} – {format(new Date(alert.periodEnd), 'dd.MM.yy')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{fmt(alert.amountDue)} €</td>
                    <td className="py-2.5 px-3 text-right font-medium" style={{ color: '#10b981' }}>{fmt(alert.amountPaid)} €</td>
                    <td className="py-2.5 px-3 text-right font-bold" style={{ color: 'var(--danger)' }}>{fmt(alert.remaining)} €</td>
                    <td className="py-2.5 px-3 text-center">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                        style={alert.status === 'unpaid'
                          ? { background: 'var(--danger-subtle)', color: 'var(--danger)' }
                          : { background: 'var(--warning-subtle)', color: 'var(--warning)' }
                        }
                      >
                        {alert.status === 'unpaid' ? t('overview.salaries.unpaid') : t('overview.salaries.partial')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td className="py-2.5 px-3 font-bold" style={{ color: 'var(--text-primary)' }} colSpan={3}>{t('overview.salaries.totalOpen')}</td>
                  <td className="py-2.5 px-3 text-right font-bold" style={{ color: 'var(--danger)' }}>{fmt(totalOpenSalary)} €</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}

      {/* ── Recent receipts + quick actions ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel>
          <SectionHeader
            title={t('overview.receipts.title')} sub={t('overview.receipts.sub')} icon={<ReceiptIcon size={16} />}
            action={
              <Link to="/belege" className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-text)' }}>
                {t('common.all')} <ChevronRight size={12} />
              </Link>
            }
          />
          {recentReceipts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2" style={{ color: 'var(--text-tertiary)' }}>
              <FileText size={24} style={{ color: 'var(--border)' }} />
              <span className="text-sm">{t('overview.receipts.none')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {recentReceipts.map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 p-3 rounded-xl transition-colors cursor-default"
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-muted)' }}>
                    <FileText size={14} style={{ color: 'var(--text-tertiary)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{r.receiptNumber}</p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{r.description || r.driverName}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {r.expense > 0 && <p className="text-sm font-bold" style={{ color: 'var(--danger)' }}>-{r.expense.toFixed(2)} €</p>}
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{format(new Date(r.date), 'dd.MM.yyyy')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.quick.title')} sub={t('overview.quick.sub')} icon={<Zap size={16} />} />
          <div className="grid grid-cols-1 gap-3">
            {[
              { to: '/belege',      icon: <Plus size={16} className="text-white" />,       bg: '#059669', title: t('overview.quick.addBeleg'),   sub: t('overview.quick.addBelegSub') },
              { to: '/umsaetze',    icon: <TrendingUp size={16} className="text-white" />, bg: '#2563eb', title: t('overview.quick.revenue'),  sub: t('overview.quick.revenueSub') },
              { to: '/abrechnung',  icon: <BarChart3 size={16} className="text-white" />,  bg: '#d97706', title: t('overview.quick.abrechnung'),         sub: t('overview.quick.abrechnungSub') },
              { to: '/statistiken', icon: <Target size={16} className="text-white" />,     bg: '#0284c7', title: t('overview.quick.stats'),        sub: t('overview.quick.statsSub') },
            ].map(item => (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center gap-3 p-3.5 rounded-xl transition-all group"
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLElement;
                  el.style.background = 'var(--bg-muted)';
                  el.style.boxShadow = 'var(--shadow-md)';
                  el.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement;
                  el.style.background = 'var(--bg-subtle)';
                  el.style.boxShadow = 'none';
                  el.style.transform = 'translateY(0)';
                }}
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-all" style={{ background: item.bg }}>
                  {item.icon}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{item.title}</p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{item.sub}</p>
                </div>
                <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} />
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
};

export default OverviewPage;
