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
import ModuleOffNotice from '../components/ModuleOffNotice';
import {
  overviewPanelOffModules,
  overviewReadEnabled,
  type OverviewPanelKey,
} from '../utils/overviewModuleScope';
import { moduleDefinition } from '../lib/companyModules';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { ADMIN_BASE } from '../lib/adminGate';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { engineText } from '../i18n/engineMessage';
import { receiptCountsOn } from '../utils/receiptBusinessDate';
import { FleetImportPrompt } from '../components/partner/FleetImportPrompt';
import { Alert, Card } from '../components/ui';

const fmt = (n: number) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const { planState, effectivePlan, companyModules, loading: planLoading } = usePlan();
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

  /*
    `planLoading` is in the condition, not only in the dependency list, and
    without it this slice would not work at all. `PlanContext` starts at
    `NO_MODULE_DECISIONS` — every module on, the fail-open value — and only
    replaces it once the `company_modules` read answers. A load that ran before
    that would fetch all seven tables on the old terms and fill the panels with
    a disabled module's rows, and would then be the state the user sees until
    something else re-renders. `loading` there is false only after **both** the
    company row and the module map have arrived, so it is the right gate.

    `companyModules` is a dependency so a module switched off in another tab —
    which `PlanContext.refresh` picks up — re-reads rather than leaving the
    figures of a module that is now gone on screen.
  */
  useEffect(() => {
    if (!dbLoading && !planLoading) loadData();
  }, [dbLoading, planLoading, companyModules]);

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      /*
        Belege and Fahrer come through `useDatabase`, which four screens share
        and which falls back to local storage, so nothing inside the hook may be
        changed on the Overview's behalf. The **call site** is the Overview's
        own, though, so a module that is off is simply not fetched here: no
        request, no rows, and the other three screens untouched. The measurement
        in `src/lib/moduleReadScope.test.ts` still records `shared reads
        receipts` and `shared reads drivers` as crossings, because the hook's
        other callers remain.
      */
      const [receiptsData, driversData] = await Promise.all([
        overviewReadEnabled(companyModules, 'receipts') ? receiptActions.get() : Promise.resolve([]),
        overviewReadEnabled(companyModules, 'drivers') ? driverActions.get() : Promise.resolve([]),
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
  // ── The module term on each of the Overview's own five reads ──────────────
  //
  // `overview` is `lockable: false` and reads five toggleable modules' tables,
  // which `src/lib/moduleReadScope.test.ts` measured and named as the first of
  // two structural blockers on closing reads. The panels are withheld by
  // `overviewPanelOffModules` either way, so skipping the request moves no
  // figure — what it changes is that the rows of a module this company does not
  // have never arrive, so a panel added later cannot quietly compute from them.
  //
  // Two of the seven reads carry no term, and the reason is in
  // `OVERVIEW_OWN_READS`' header: `user_profiles` belongs to `users`, which can
  // never be off, and `cash_movements` belongs to no module at all.
  const loadFixedCosts = async () => {
    if (!overviewReadEnabled(companyModules, 'fixed_costs')) {
      setFixedCosts([]);
      return;
    }
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
    if (!overviewReadEnabled(companyModules, 'income')) {
      setIncomes([]);
      return;
    }
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
    if (!overviewReadEnabled(companyModules, 'salaries')) {
      setSalaries([]);
      return;
    }
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
    if (!overviewReadEnabled(companyModules, 'werkstatt_checks')) {
      setWerkstattChecks([]);
      return;
    }
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
    if (!overviewReadEnabled(companyModules, 'cars')) {
      setCars([]);
      return;
    }
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

  // ── Which panels may speak ───────────────────────────────────────────────
  //
  // `panelOff(panel)` is the modules that panel's figures are computed from and
  // this company does not have; empty means it renders them. The map is
  // `OVERVIEW_PANEL_MODULES` and the reasoning is that file's header. Two rules
  // the call sites below all follow:
  //
  //   - **a withheld figure is stated, never rendered as 0 and never hidden.**
  //     An empty list and a 0,00 € are claims about the customer's money, and
  //     the three composite panels are worse than a zero: `profit` subtracts
  //     salaries, Belege and Fixkosten, so a missing cost term **overstates**
  //     it, `totalCosts` understates, and the till understates what went out.
  //     None of them goes to zero, so none of them looks wrong.
  //   - **the input is emptied as well as the panel withheld**, wherever a
  //     helper would otherwise compute over a partial set. `generateInsights`
  //     is the sharp case: it compares this month with last and would write a
  //     confident sentence about a collapse that is only a closed read.
  const panelOff = (panel: OverviewPanelKey) => overviewPanelOffModules(companyModules, panel);
  const panelOn = (panel: OverviewPanelKey) => panelOff(panel).length === 0;
  /** The KPI cards' one-line reason: short, because it sits under a figure. */
  const offSub = (panel: OverviewPanelKey): string | null => {
    const off = panelOff(panel);
    if (off.length === 0) return null;
    return t('overview.moduleOff.short', {
      modules: off.map(key => t(moduleDefinition(key)!.labelKey)).join(', '),
    });
  };
  /** What a KPI card shows in place of a figure. Not '0,00 €', which is a claim. */
  const WITHHELD = '—';


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

  /*
    The two cards that colour themselves by sign read neutral when withheld. A
    red icon beside a `—` is a claim one step quieter than a figure: it says the
    company made a loss, off a profit computed without its Fixkosten. Written as
    a boolean rather than a second colour literal at each call site, because the
    style ratchet counts occurrences and a duplicated `rgba(...)` would raise its
    baseline — which is a regression, not a conversion.

    BELOW `currentMetrics`, not up with the other panel helpers, and the
    typecheck ratchet is what insisted: up there these two read a `const` still
    in its temporal dead zone, so for a company with every module on — where
    `offSub` answers null and the `||` does not short-circuit — the Overview
    threw a ReferenceError on every render. Four errors, all of them real.
  */
  const profitReadsPositive = offSub('kpiProfit') !== null || currentMetrics.profit >= 0;
  const marginReadsPositive = offSub('kpiMargin') !== null || currentMetrics.profitMargin >= 0;

  // Each of these is emptied rather than computed when its panel is withheld,
  // so no helper runs over a set a closed module left short. `insights` is the
  // one that must be emptied rather than merely not rendered: it compares two
  // months, and a month whose cost terms were not read is a comparison that
  // reads as a collapse.
  const driverPerformance = panelOn('driverChart')
    ? calcDriverPerformance(driverRecords, incomes, salaries, receipts, monthStart, monthEnd) : [];
  const salaryAlerts      = panelOn('alertsSalaries') ? calcSalaryAlerts(salaries, driverRecords) : [];
  const cashSummary       = calcCashSummary(incomes, receipts, monthStart, monthEnd, cashMovements);
  const trendData         = buildTrendData(selectedMonth, incomes, salaries, receipts, fixedCosts, t);
  const topExpenses       = panelOn('topExpenses')
    ? getTopExpenses(receipts, fixedCosts, monthStart, monthEnd, 5) : [];
  const insights          = panelOn('insights')
    ? generateInsights(currentMetrics, prevMetrics, driverPerformance, salaryAlerts, werkstattChecks) : [];
  // overviewHelpers writes German and names a key beside it; translating here
  // covers the legend and the chart tooltip, which reads `name` off the datum.
  const revenueComposition = buildRevenueComposition(currentMetrics)
    .map(d => ({ ...d, name: engineText(t, d.name, d.nameKey) }));

  const recentReceipts = [...receipts]
    .filter(r => isWithinInterval(new Date(receiptCountsOn(r)), { start: monthStart, end: monthEnd }))
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged; everything below
  // only draws it.

  if (loading || dbLoading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <div className="size-10 rounded-full border-2 border-line-strong border-b-brand motion-safe:animate-spin" />
      </div>
    );
  }

  // Chart colours come from the tokens, so both themes follow.
  const C = CHART;

  return (
    <div className="space-y-5 pb-8 font-ui">

      {/* A failed load used to render as 0,00 € everywhere. Say what happened. */}
      {loadError && (
        <Alert tone="critical">
          <strong>{t('overview.error.partial')}</strong>{' '}
          {t('overview.error.partialBody', { reason: loadError })}
        </Alert>
      )}

      {/* ── Super Admin Banner ── */}
      {isSuperAdmin && (
        <Link
          to={ADMIN_BASE}
          className={`group flex items-center justify-between gap-3 rounded-surface border border-caution/30 bg-caution-soft p-4 motion-safe:transition-colors ${FOCUS_RING}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-tight bg-raised text-caution shadow-hi">
              <Building2Icon size={20} aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-caution">{t('overview.superAdmin.title')}</p>
              <p className="mt-0.5 text-xs text-fg-muted">
                {t('overview.superAdmin.sub')}
              </p>
            </div>
          </div>
          <ChevronRight size={18} aria-hidden className="shrink-0 text-caution motion-safe:transition-transform group-hover:translate-x-1" />
        </Link>
      )}

      {/* ── Plan Status Card ── */}
      {!isSuperAdmin && (
        <PlanStatusCard planState={planState} effectivePlan={effectivePlan} />
      )}

      {/* ── Fleet import: only for an empty company whose counts were read ── */}
      {!isSuperAdmin && <FleetImportPrompt />}

      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">
            {t('overview.title')}
          </h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            {format(parseISO(selectedMonth + '-01'), 'MMMM yyyy', { locale: de })}
            {' · '}{t('overview.comparedWith')}{' '}
            {format(parseISO(prevMonthStr + '-01'), 'MMMM yyyy', { locale: de })}
          </p>
        </div>
        <div className="glass-card flex items-center gap-2 self-start rounded-control px-3 py-2">
          <Calendar size={15} aria-hidden className="text-fg-subtle" />
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className={`rounded-chip bg-transparent text-sm font-medium text-fg [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:text-base ${FOCUS_RING}`}
          />
        </div>
      </div>

      {/* ── Smart insights ──
          `insights` is `[]` unless all six of its modules are on, and the block
          is conditional on being non-empty, so this is the alerts case again.
          What matters is that it was **not computed**: `generateInsights`
          compares this month with last, and over a term that was not read it
          writes a confident German sentence about a collapse that never
          happened. */}
      {insights.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

      {/* ── KPI Cards ──
          A withheld card keeps its label and its place and shows `—` with the
          reason underneath, rather than a 0,00 € or an empty grid cell. The
          `delta` goes with the figure: a percentage change against a month
          whose term was not read is the same false statement one level down. */}
      <div className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiCard label={t('overview.kpi.umsatz')}
          value={offSub('kpiUmsatz') ? WITHHELD : `${fmt(currentMetrics.umsatz)} €`}
          sub={offSub('kpiUmsatz') ?? t('overview.kpi.vsPrevMonth')}
          icon={<TrendingUp size={18} aria-hidden />} iconBg="bg-positive-soft" iconColor="text-positive"
          delta={offSub('kpiUmsatz') ? undefined : umsatzDelta} higherIsBetter />
        <KpiCard label={t('overview.kpi.bargeld')}
          value={offSub('kpiBargeld') ? WITHHELD : `${fmt(currentMetrics.bargeld)} €`}
          sub={offSub('kpiBargeld') ?? t('overview.kpi.vsPrevMonth')}
          icon={<Wallet size={18} aria-hidden />} iconBg="bg-teal-soft" iconColor="text-teal"
          delta={offSub('kpiBargeld') ? undefined : bargeldDelta} higherIsBetter />
        <KpiCard label={t('overview.load.gehaelter')}
          value={offSub('kpiSalaries') ? WITHHELD : `${fmt(currentMetrics.salaries)} €`}
          sub={offSub('kpiSalaries') ?? t('overview.kpi.vsPrevMonth')}
          icon={<Users size={18} aria-hidden />} iconBg="bg-caution-soft" iconColor="text-caution"
          delta={offSub('kpiSalaries') ? undefined : salariesDelta} higherIsBetter={false} />
        <KpiCard label={t('overview.kpi.gesamtkosten')}
          value={offSub('kpiTotalCosts') ? WITHHELD : `${fmt(currentMetrics.totalCosts)} €`}
          sub={offSub('kpiTotalCosts') ?? t('overview.kpi.costBasis')}
          icon={<TrendingDown size={18} aria-hidden />} iconBg="bg-critical-soft" iconColor="text-critical"
          delta={offSub('kpiTotalCosts') ? undefined : costsDelta} higherIsBetter={false} />
        <KpiCard label={t('overview.kpi.firmengewinn')}
          value={offSub('kpiProfit') ? WITHHELD : `${fmt(currentMetrics.profit)} €`}
          sub={offSub('kpiProfit') ?? t('overview.kpi.vsPrevMonth')}
          icon={<DollarSign size={18} aria-hidden />}
          iconBg={profitReadsPositive ? 'bg-info-soft' : 'bg-critical-soft'}
          iconColor={profitReadsPositive ? 'text-info' : 'text-critical'}
          delta={offSub('kpiProfit') ? undefined : profitDelta} higherIsBetter />
        <KpiCard label={t('overview.kpi.gewinnmarge')}
          value={offSub('kpiMargin') ? WITHHELD : `${currentMetrics.profitMargin.toFixed(1)}%`}
          sub={offSub('kpiMargin')
            ?? (marginDelta !== null ? `${marginDelta >= 0 ? '+' : ''}${marginDelta.toFixed(1)}pp` : t('overview.kpi.profitability'))}
          icon={<Target size={18} aria-hidden />}
          iconBg={marginReadsPositive ? 'bg-info-soft' : 'bg-critical-soft'}
          iconColor={marginReadsPositive ? 'text-info' : 'text-critical'} />
      </div>

      {/* ── Action alerts ──
          The rows here are the one place silence is right, and it is reasoned
          rather than convenient: each row renders **only when there is
          something to report** (`unpaidCount > 0`, `fleetIssues > 0`,
          `tuevAbgelaufen.length > 0`), so absence is this panel's normal state
          and withholding a row claims nothing. Nothing is left to infer a zero
          from either — the KPI card above each of these shows `—` with the
          module named, so the reason is on screen in the place a figure would
          have been. The inputs are emptied upstream (`salaryAlerts`,
          `werkstattChecks`, `cars`), so no row is drawn from a partial set.
          `pendingInvites` is ungated: `users` can never be off. */}
      {hasAlerts && (
        <Panel>
          <SectionHeader title={t('overview.alerts.title')} sub={t('overview.alerts.sub')} icon={<AlertTriangle size={16} aria-hidden />} />
          <div className="space-y-2">
            {unpaidCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-critical/20 bg-critical-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <AlertCircle size={16} aria-hidden className="shrink-0 text-critical" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.unpaidSalaries.one', other: 'overview.alerts.unpaidSalaries.other' }, unpaidCount)}
                    </p>
                    <p className="text-xs tabular-nums text-fg-muted">{t('overview.alerts.totalOpen', { amount: `${fmt(totalOpenSalary)} €` })}</p>
                  </div>
                </div>
                <Link to="/gehaelter" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-critical [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('overview.alerts.manage')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
            {partialCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-caution/20 bg-caution-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <AlertTriangle size={16} aria-hidden className="shrink-0 text-caution" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.partialSalaries.one', other: 'overview.alerts.partialSalaries.other' }, partialCount)}
                    </p>
                    <p className="text-xs tabular-nums text-fg-muted">
                      {t('overview.alerts.remaining', { amount: `${fmt(salaryAlerts.filter(a => a.status === 'partially_paid').reduce((s, a) => s + a.remaining, 0))} €` })}
                    </p>
                  </div>
                </div>
                <Link to="/gehaelter" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-caution [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('overview.alerts.manage')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
            {/*
              `panelOn` here is not redundant with the emptied input, and the
              coverage test in `overviewModuleScope.test.ts` is what insists on
              it: `fleetIssues` is 0 today because `werkstatt_checks` was not
              fetched, which couples this row to a *fetch* decision taken two
              hundred lines away. Naming the panel is what keeps the row tied to
              its own declared dependency list, so a later change to either side
              is visible rather than silently load-bearing.
            */}
            {panelOn('alertsFleet') && fleetIssues > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-critical/20 bg-critical-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Wrench size={16} aria-hidden className="shrink-0 text-critical" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.negativeCheck.one', other: 'overview.alerts.negativeCheck.other' }, fleetIssues)}
                    </p>
                    <p className="text-xs text-fg-muted">{t('overview.alerts.checkWerkstatt')}</p>
                  </div>
                </div>
                <Link to="/werkstatt" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-critical [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('nav.werkstatt')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
            {panelOn('alertsTuev') && tuevAbgelaufen.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-critical/20 bg-critical-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <ShieldX size={16} aria-hidden className="shrink-0 text-critical" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.tuevExpired.one', other: 'overview.alerts.tuevExpired.other' }, tuevAbgelaufen.length)}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {tuevAbgelaufen.map(c => c.kennzeichen).join(', ')}
                    </p>
                  </div>
                </div>
                <Link to="/cars" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-critical [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('nav.cars')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
            {panelOn('alertsTuev') && tuevBaldAblaufend.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-caution/20 bg-caution-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <ShieldAlert size={16} aria-hidden className="shrink-0 text-caution" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.tuevSoon.one', other: 'overview.alerts.tuevSoon.other' }, tuevBaldAblaufend.length)}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {tuevBaldAblaufend.map(c => c.kennzeichen).join(', ')}
                    </p>
                  </div>
                </div>
                <Link to="/cars" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-caution [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('nav.cars')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
            {pendingInvites > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-tile border border-brand/20 bg-brand-soft p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Info size={16} aria-hidden className="shrink-0 text-brand-text" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      {tPlural({ one: 'overview.alerts.pendingInvites.one', other: 'overview.alerts.pendingInvites.other' }, pendingInvites)}
                    </p>
                    <p className="text-xs text-fg-muted">{t('overview.alerts.notAccepted')}</p>
                  </div>
                </div>
                <Link to="/benutzer" className={`flex items-center gap-1 rounded-chip text-xs font-semibold text-brand-text [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                  {t('nav.users')} <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ── Charts row 1: trend + revenue mix ── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <SectionHeader title={t('overview.trend.title')} sub={t('overview.trend.sub')} icon={<BarChart3 size={16} aria-hidden />} />
          {/* A six-month chart drawn over a closed term is the worst of the lot:
              it does not look empty, it looks like a trend. */}
          {!panelOn('trend') ? (
            <ModuleOffNotice moduleKeys={panelOff('trend')} />
          ) : (
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
          )}
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.mix.title')} sub={t('overview.mix.sub')} icon={<DollarSign size={16} aria-hidden />} />
          {!panelOn('revenueMix') ? (
            // Not the existing "Keine Einnahmen" empty state: that sentence says
            // the company earned nothing this month, which is a different claim.
            <ModuleOffNotice moduleKeys={panelOff('revenueMix')} />
          ) : revenueComposition.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={revenueComposition} cx="50%" cy="50%" innerRadius={42} outerRadius={65} paddingAngle={3} dataKey="value">
                    {revenueComposition.map((d, i) => <Cell key={i} fill={pieVar(d.nameKey)} />)}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => `${fmt(v)} €`}
                    contentStyle={{
                      background: 'rgb(var(--overlay) / var(--overlay-a))',
                      border: '1px solid rgb(var(--line-strong) / var(--line-strong-a))',
                      borderRadius: '0.5rem',
                      color: 'rgb(var(--fg))',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-3 space-y-2">
                {revenueComposition.map(d => {
                  const total = revenueComposition.reduce((s, x) => s + x.value, 0);
                  const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : '0';
                  return (
                    <div key={d.name} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`size-2.5 shrink-0 rounded-full ${pieDot(d.nameKey)}`} />
                        <span className="text-fg-muted">{d.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-semibold text-fg">{fmt(d.value)} €</span>
                        <span className="w-7 text-right text-fg-subtle">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between border-t border-line pt-2 text-xs tabular-nums">
                  <span className="font-semibold text-fg-muted">{t('overview.common.gesamt')}</span>
                  <span className="font-semibold text-fg">
                    {fmt(revenueComposition.reduce((s, d) => s + d.value, 0))} €
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-fg-subtle">
              {t('overview.mix.none')}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Profit + Cash ── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel className="flex flex-col">
          <SectionHeader title={t('overview.profit.title')} sub={format(parseISO(selectedMonth + '-01'), 'MMMM yyyy', { locale: de })} icon={<Target size={16} aria-hidden />} />
          {/* The breakdown is the one panel that shows the subtraction itself —
              Netto, Aktionen, minus Gehälter, Belege, Fixkosten — so a missing
              term here is a row of 0,00 € beside four real ones, which reads as
              a figure that was measured. */}
          {!panelOn('profitBreakdown') ? (
            <ModuleOffNotice moduleKeys={panelOff('profitBreakdown')} />
          ) : (
          <div className="flex flex-1 flex-col gap-2">
            {[
              { label: t('overview.profit.netFare'), value: currentMetrics.nettoFahrpreis, sign: '+', color: 'text-positive', bg: 'bg-positive-soft', border: 'border-positive/20', icon: <TrendingUp size={13} aria-hidden /> },
              { label: t('overview.profit.aktionen'),        value: currentMetrics.aktionen,       sign: '+', color: 'text-info', bg: 'bg-info-soft',  border: 'border-info/20',  icon: <Zap size={13} aria-hidden /> },
              { label: t('overview.load.gehaelter'),        value: currentMetrics.salaries,       sign: '-', color: 'text-caution', bg: 'bg-caution-soft',  border: 'border-caution/20',  icon: <Users size={13} aria-hidden /> },
              { label: t('overview.profit.belegeExpenses'), value: currentMetrics.expenses,     sign: '-', color: 'text-critical', bg: 'bg-critical-soft',   border: 'border-critical/20',   icon: <ReceiptIcon size={13} aria-hidden /> },
              { label: t('overview.load.fixkosten'),       value: currentMetrics.fixedCosts,     sign: '-', color: 'text-critical', bg: 'bg-critical-soft',   border: 'border-critical/20',   icon: <TrendingDown size={13} aria-hidden /> },
            ].map(row => (
              <div
                key={row.label}
                className={`flex items-center justify-between gap-3 rounded-tile border p-3 ${row.bg} ${row.border}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className={`flex size-6 shrink-0 items-center justify-center rounded-tight border ${row.bg} ${row.color} ${row.border}`}>
                    {row.icon}
                  </div>
                  <span className="text-sm font-medium text-fg">{row.label}</span>
                </div>
                <span className={`shrink-0 text-sm font-semibold tabular-nums ${row.color}`}>
                  {row.sign}{fmt(row.value)} €
                </span>
              </div>
            ))}
            <div
              className={`mt-1 flex items-center justify-between gap-3 rounded-tile p-4 ${
                currentMetrics.profit >= 0 ? 'bg-brand text-brand-fg' : 'bg-critical-solid text-critical-fg'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className={`flex size-7 shrink-0 items-center justify-center rounded-tight ${
                  currentMetrics.profit >= 0 ? 'bg-brand-fg/20' : 'bg-critical-fg/20'
                }`}>
                  <DollarSign size={14} aria-hidden />
                </div>
                <span className="text-sm font-semibold">{t('overview.kpi.firmengewinn')}</span>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg font-semibold tabular-nums">
                  {currentMetrics.profit >= 0 ? '+' : ''}{fmt(currentMetrics.profit)} €
                </p>
                <p className="text-xs opacity-80">{t('overview.profit.margin', { value: currentMetrics.profitMargin.toFixed(1) })}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1 text-xs tabular-nums text-fg-subtle">
              <span>{t('overview.profit.prevMonth', { amount: `${fmt(prevMetrics.profit)} €` })}</span>
              <DeltaBadge delta={profitDelta} higherIsBetter />
            </div>
          </div>
          )}
        </Panel>

        <Panel className="flex flex-col">
          <SectionHeader title={t('overview.cash.title')} sub={t('overview.cash.sub')} icon={<Wallet size={16} aria-hidden />} />
          {/* The till is `Bargeld − Belege − (GQ − Stornos)`, so Belege off
              **understates what left the till** and Umsätze off understates what
              came in. Either way the balance is wrong, not zero, and this is the
              figure a fleet owner counts the cash box against. */}
          {!panelOn('cash') ? (
            <ModuleOffNotice moduleKeys={panelOff('cash')} />
          ) : (
          <div className="flex flex-1 flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
              <div className="rounded-tile border border-positive/20 bg-positive-soft p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-positive">{t('overview.cash.income')}</p>
                <p className="text-xl font-semibold tabular-nums text-positive">{fmt(cashSummary.cashIncome)} €</p>
                <p className="mt-0.5 text-xs text-fg-muted">{t('overview.cash.driverCash')}</p>
              </div>
              <div className="rounded-tile border border-critical/20 bg-critical-soft p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-critical">{t('overview.cash.belegExpenses')}</p>
                <p className="text-xl font-semibold tabular-nums text-critical">{fmt(cashSummary.cashFromExpenses)} €</p>
                <p className="mt-0.5 text-xs text-fg-muted">{t('overview.cash.belegCash')}</p>
              </div>
            </div>

            <div
              className={`rounded-tile border p-4 ${
                cashSummary.cashRisk === 'ok'
                  ? 'border-info/20 bg-info-soft'
                  : cashSummary.cashRisk === 'warning'
                  ? 'border-caution/20 bg-caution-soft'
                  : 'border-critical/20 bg-critical-soft'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className={`mb-1 text-xs font-semibold uppercase tracking-wide ${
                    cashSummary.cashRisk === 'ok' ? 'text-info' : cashSummary.cashRisk === 'warning' ? 'text-caution' : 'text-critical'
                  }`}>
                    {t('overview.cash.balanceNet')}
                  </p>
                  <p className={`text-2xl font-semibold tabular-nums ${cashSummary.cashBalance >= 0 ? 'text-info' : 'text-critical'}`}>
                    {cashSummary.cashBalance >= 0 ? '' : '-'}{fmt(Math.abs(cashSummary.cashBalance))} €
                  </p>
                </div>
                <div
                  className={`shrink-0 rounded-tight bg-raised p-2.5 shadow-hi ${cashSummary.cashRisk === 'ok' ? 'text-info' : 'text-caution'}`}
                >
                  <Wallet size={22} aria-hidden />
                </div>
              </div>
              {ledgerInScope && cashSummary.salaryPayouts !== 0 && (
                <p className="mt-2 text-xs tabular-nums text-fg-muted">
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
                <div className="mt-2 flex items-center gap-1.5">
                  <AlertTriangle size={12} aria-hidden className="text-caution" />
                  <p className="text-xs font-medium text-caution">
                    {cashSummary.cashRisk === 'warning' ? t('overview.cash.low') : t('overview.cash.negative')}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-tile bg-sunken p-3 text-xs">
              <span className="text-fg-muted">{t('overview.cash.ratio')}</span>
              <span className="font-semibold tabular-nums text-fg">
                {cashSummary.cashIncome > 0
                  ? t('overview.cash.spentPct', { value: ((cashSummary.cashOut / cashSummary.cashIncome) * 100).toFixed(0) })
                  : '—'}
              </span>
            </div>

            <Link
              to="/bargeldbestand"
              className={`group flex items-center justify-between gap-3 rounded-tile bg-sunken p-3 motion-safe:transition-colors hover:bg-brand-soft [@media(pointer:coarse)]:min-h-11 ${FOCUS_RING}`}
            >
              <span className="text-sm font-medium text-fg">{t('overview.cash.detailed')}</span>
              <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-subtle" />
            </Link>
          </div>
          )}
        </Panel>
      </div>

      {/* ── Driver performance ── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <SectionHeader title={t('overview.drivers.title')} sub={t('overview.drivers.sub')} icon={<Users size={16} aria-hidden />} />
          {!panelOn('driverChart') ? (
            // Not "Keine Fahrerdaten für diesen Monat", which says the drivers
            // drove nothing.
            <ModuleOffNotice moduleKeys={panelOff('driverChart')} />
          ) : driverPerformance.filter(d => d.umsatz > 0).length > 0 ? (
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
            <div className="flex h-40 items-center justify-center text-sm text-fg-subtle">
              {t('overview.drivers.noneMonth')}
            </div>
          )}
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.drivers.ranking')} sub={t('overview.drivers.rankingSub')} icon={<Target size={16} aria-hidden />} />
          {!panelOn('driverRanking') ? (
            <ModuleOffNotice moduleKeys={panelOff('driverRanking')} />
          ) : driverPerformance.length > 0 ? (
            <div className="space-y-2.5">
              {driverPerformance.map((driver, idx) => {
                const maxUmsatz = Math.max(...driverPerformance.map(d => d.umsatz), 1);
                const barPct = Math.max((driver.umsatz / maxUmsatz) * 100, 0);
                const isTop = idx === 0;
                const isWorst = idx === driverPerformance.length - 1 && driverPerformance.length > 1;
                return (
                  <div
                    key={driver.id}
                    className={`cursor-default rounded-tile border p-3 motion-safe:transition-colors ${
                      isTop ? 'border-positive/20 bg-positive-soft' : 'border-transparent hover:bg-sunken'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`w-5 shrink-0 text-center text-xs font-semibold tabular-nums ${isTop ? 'text-positive' : 'text-fg-subtle'}`}>
                        {idx + 1}
                      </span>
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg">
                        <span className="text-xs font-semibold">{driver.name.charAt(0).toUpperCase()}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center justify-between">
                          <p className="truncate text-xs font-semibold text-fg">{driver.name}</p>
                          <span className={`ml-1 shrink-0 text-xs font-semibold tabular-nums ${driver.netContribution >= 0 ? 'text-positive' : 'text-critical'}`}>
                            {driver.netContribution >= 0 ? '+' : ''}{fmt(driver.netContribution)} €
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                          <div className="h-full rounded-full bg-brand" style={{ width: `${barPct}%` }} />
                        </div>
                        {driver.profitMargin !== null && (
                          <p className="mt-1 text-xs tabular-nums text-fg-subtle">
                            {t('overview.drivers.marginLabel')} <strong className="text-fg-muted">{driver.profitMargin.toFixed(0)}%</strong>
                            {' · '}{t('overview.drivers.revenueSuffix', { amount: fmt(driver.umsatz) })}
                          </p>
                        )}
                      </div>
                      {isTop && <span className="shrink-0 rounded-chip bg-positive-soft px-1.5 py-0.5 text-xs font-semibold text-positive">{t('overview.drivers.top')}</span>}
                      {isWorst && driver.netContribution < 0 && <span className="shrink-0 rounded-chip bg-critical-soft px-1.5 py-0.5 text-xs font-semibold text-critical">{t('overview.drivers.attention')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-fg-subtle">{t('overview.drivers.none')}</div>
          )}
        </Panel>
      </div>

      {/* ── Expenses + Fleet ── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel>
          <SectionHeader title={t('overview.costs.title')} sub={t('overview.costs.sub')} icon={<TrendingDown size={16} aria-hidden />} />
          {!panelOn('topExpenses') ? (
            // Its footer prints `currentMetrics.totalCosts`, so the empty state
            // would come with a cost total that is missing a whole category.
            <ModuleOffNotice moduleKeys={panelOff('topExpenses')} />
          ) : topExpenses.length > 0 ? (
            <div className="space-y-2">
              {topExpenses.map((item, i) => (
                <div
                  key={i}
                  className="flex cursor-default items-center gap-3 rounded-tile p-3 motion-safe:transition-colors hover:bg-sunken"
                >
                  <div className={`flex size-7 shrink-0 items-center justify-center rounded-tight ${item.type === 'fixed' ? 'bg-sunken' : 'bg-critical-soft'}`}
                  >
                    {item.type === 'fixed'
                      ? <CreditCard size={14} aria-hidden className="text-fg-subtle" />
                      : <ReceiptIcon size={14} aria-hidden className="text-critical" />
                    }
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{item.description}</p>
                    <p className="text-xs text-fg-subtle">
                      {item.type === 'fixed' ? t('overview.load.fixkosten') : item.driverName || t('bargeld.beleg')}
                      {item.type === 'receipt' && ` · ${format(new Date(item.date), 'dd.MM.yyyy')}`}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-critical">-{fmt(item.amount)} €</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-line px-1 pt-2 text-xs tabular-nums text-fg-subtle">
                <span>{t('overview.costs.total')}</span>
                <span className="font-semibold text-fg">{fmt(currentMetrics.totalCosts)} €</span>
              </div>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-fg-subtle">{t('overview.costs.none')}</div>
          )}
        </Panel>

        <Panel>
          <SectionHeader
            title={t('overview.fleet.title')} sub={t('overview.fleet.sub')} icon={<Wrench size={16} aria-hidden />}
            action={
              <Link to="/werkstatt" className={`flex items-center gap-1 rounded-chip text-xs font-medium text-brand-text [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                {t('common.all')} <ChevronRight size={12} aria-hidden />
              </Link>
            }
          />
          {/* Three counts of 0 beside "OK / Probleme / Repariert" reads as a
              clean fleet, which is a claim about roadworthiness. */}
          {!panelOn('fleet') ? (
            <ModuleOffNotice moduleKeys={panelOff('fleet')} />
          ) : (
          <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            {[
              { label: 'OK', value: fleetOk, color: 'text-positive', bg: 'bg-positive-soft', border: 'border-positive/20' },
              { label: t('overview.fleet.problems'), value: fleetIssues, color: 'text-critical', bg: 'bg-critical-soft', border: 'border-critical/20' },
              { label: t('overview.fleet.repaired'), value: fleetRepaired, color: 'text-info', bg: 'bg-info-soft', border: 'border-info/20' },
            ].map(s => (
              <div key={s.label} className={`min-w-0 rounded-tile border p-2 text-center sm:p-3 ${s.bg} ${s.border}`}>
                <p className={`text-2xl font-semibold tabular-nums ${s.color}`}>{s.value}</p>
                <p className={`mt-0.5 text-xs font-medium ${s.color}`}>{s.label}</p>
              </div>
            ))}
          </div>

          {currentMonthChecks.length > 0 ? (
            <div className="space-y-2">
              {currentMonthChecks.filter(c => c.status === 'negative').slice(0, 3).map(c => (
                <div key={c.id} className="flex items-center gap-2.5 rounded-tight border border-critical/20 bg-critical-soft p-2.5"
                >
                  <AlertCircle size={14} aria-hidden className="shrink-0 text-critical" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-fg">{c.car?.kennzeichen || t('overview.common.unknown')}</p>
                    <p className="truncate text-xs text-fg-muted">{c.notes}</p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                    {format(new Date(c.check_date), 'dd.MM')}
                  </span>
                </div>
              ))}
              {currentMonthChecks.filter(c => c.status === 'negative').length === 0 && (
                <div className="flex items-center gap-2 rounded-tight bg-positive-soft p-2.5 text-xs text-positive"
                >
                  <CheckCircle size={14} aria-hidden />
                  {t('overview.fleet.noNegative')}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-20 items-center justify-center text-sm text-fg-subtle">
              {t('overview.fleet.noChecks')}
            </div>
          )}
          </>
          )}
        </Panel>
      </div>

      {/* ── Unpaid salaries ──
          `salaryAlerts` is already `[]` when Gehälter or Fahrer is off, and this
          table only exists when it is non-empty, so it is the action-alerts
          case: nothing is withheld, because nothing was ever claimed. The panel
          is still named here rather than left to ride on `salaryAlerts`, for the
          reason the Werkstatt alert row gives: its dependency list is declared
          separately and a later change to either side has to be visible. */}
      {panelOn('unpaidSalaries') && salaryAlerts.length > 0 && (
        <Panel>
          <SectionHeader
            title={t('overview.salaries.title')} sub={t('overview.salaries.sub')} icon={<CreditCard size={16} aria-hidden />}
            action={
              <Link to="/gehaelter" className={`flex items-center gap-1 rounded-chip text-xs font-medium text-brand-text [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                {t('overview.alerts.manage')} <ChevronRight size={12} aria-hidden />
              </Link>
            }
          />
          {/* Positioned, so a scrolled-off cell's label stays inside the frame;
              figures never break, so on a phone the table scrolls instead. */}
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line bg-wash">
                  {[t('overview.salaries.driver'), t('overview.salaries.due'), t('overview.salaries.paid'), t('overview.salaries.open'), t('overview.salaries.status')].map((h, i) => (
                    <th key={h} className={`px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-subtle ${i === 0 ? 'text-left' : i === 4 ? 'text-center' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {salaryAlerts.map(alert => (
                  <tr
                    key={alert.id}
                    className="border-b border-line motion-safe:transition-colors hover:bg-sunken"
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg">
                          <span className="text-xs font-semibold">{alert.driverName.charAt(0).toUpperCase()}</span>
                        </div>
                        <div>
                          <p className="font-medium text-fg">{alert.driverName}</p>
                          <p className="whitespace-nowrap text-xs text-fg-subtle">
                            {format(new Date(alert.periodStart), 'dd.MM')} – {format(new Date(alert.periodEnd), 'dd.MM.yy')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium text-fg">{fmt(alert.amountDue)} €</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium text-positive">{fmt(alert.amountPaid)} €</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-critical">{fmt(alert.remaining)} €</td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${
                          alert.status === 'unpaid'
                            ? 'bg-critical-soft text-critical'
                            : 'bg-caution-soft text-caution'
                        }`}
                      >
                        {alert.status === 'unpaid' ? t('overview.salaries.unpaid') : t('overview.salaries.partial')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong">
                  <td className="px-3 py-2.5 font-semibold text-fg" colSpan={3}>{t('overview.salaries.totalOpen')}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-critical">{fmt(totalOpenSalary)} €</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}

      {/* ── Recent receipts + quick actions ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHeader
            title={t('overview.receipts.title')} sub={t('overview.receipts.sub')} icon={<ReceiptIcon size={16} aria-hidden />}
            action={
              <Link to="/belege" className={`flex items-center gap-1 rounded-chip text-xs font-medium text-brand-text [@media(pointer:coarse)]:min-h-10 ${FOCUS_RING}`}>
                {t('common.all')} <ChevronRight size={12} aria-hidden />
              </Link>
            }
          />
          {!panelOn('recentReceipts') ? (
            // "Keine Belege" would say the company filed none this month.
            <ModuleOffNotice moduleKeys={panelOff('recentReceipts')} />
          ) : recentReceipts.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-fg-subtle">
              <FileText size={24} aria-hidden className="text-fg-subtle" />
              <span className="text-sm">{t('overview.receipts.none')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {recentReceipts.map(r => (
                <div
                  key={r.id}
                  className="flex cursor-default items-center gap-3 rounded-tile p-3 motion-safe:transition-colors hover:bg-sunken"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-tight bg-sunken">
                    <FileText size={14} aria-hidden className="text-fg-subtle" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">{r.receiptNumber}</p>
                    <p className="truncate text-xs text-fg-subtle">{r.description || r.driverName}</p>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    {r.expense > 0 && <p className="text-sm font-semibold text-critical">-{r.expense.toFixed(2)} €</p>}
                    <p className="text-xs text-fg-subtle">{format(new Date(r.date), 'dd.MM.yyyy')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel>
          <SectionHeader title={t('overview.quick.title')} sub={t('overview.quick.sub')} icon={<Zap size={16} aria-hidden />} />
          <div className="grid grid-cols-1 gap-3">
            {[
              { to: '/belege',      icon: <Plus size={16} aria-hidden />,       bg: 'bg-positive-soft text-positive', title: t('overview.quick.addBeleg'),   sub: t('overview.quick.addBelegSub') },
              { to: '/umsaetze',    icon: <TrendingUp size={16} aria-hidden />, bg: 'bg-info-soft text-info', title: t('overview.quick.revenue'),  sub: t('overview.quick.revenueSub') },
              { to: '/abrechnung',  icon: <BarChart3 size={16} aria-hidden />,  bg: 'bg-caution-soft text-caution', title: t('overview.quick.abrechnung'),         sub: t('overview.quick.abrechnungSub') },
              { to: '/statistiken', icon: <Target size={16} aria-hidden />,     bg: 'bg-teal-soft text-teal', title: t('overview.quick.stats'),        sub: t('overview.quick.statsSub') },
            ].map(item => (
              <Link
                key={item.to}
                to={item.to}
                className={`group flex items-center gap-3 rounded-tile border border-line bg-sunken p-3.5 motion-safe:transition-all hover:bg-brand-soft motion-safe:hover:-translate-y-px hover:shadow-elev-md [@media(pointer:coarse)]:min-h-11 ${FOCUS_RING}`}
              >
                <div className={`flex size-9 shrink-0 items-center justify-center rounded-tight ${item.bg}`}>
                  {item.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-fg">{item.title}</p>
                  <p className="text-xs text-fg-subtle">{item.sub}</p>
                </div>
                <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-subtle" />
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
};

// ── Presentation helpers (phase 5) ───────────────────────────────────────────
// Everything below only draws. They sit under the component, which is the
// screen's logic, and are read at render time.

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

// Series colours by token: a Recharts prop takes a string, and `rgb(var(--…))`
// resolves in SVG attributes. The grid uses the line token with its own alpha.
const CHART = {
  umsatz: 'rgb(var(--chart-2))',
  gewinn: 'rgb(var(--chart-1))',
  gehaelter: 'rgb(var(--chart-3))',
  kosten: 'rgb(var(--critical))',
  grid: 'rgb(var(--line) / var(--line-a))',
  tick: 'rgb(var(--fg-subtle))',
};

// The revenue slices are painted by their key, not by the colour the helper
// carries, so the pie, its legend dot and the series tokens agree.
const PIE_COLOR: Record<string, string> = {
  'engine.revenue.nettoFahrpreis': 'chart-2',
  'engine.revenue.aktionen': 'chart-3',
  'engine.revenue.trinkgeld': 'chart-4',
  'engine.revenue.bargeld': 'chart-1',
};
const pieVar = (key: string) => `rgb(var(--${PIE_COLOR[key] ?? 'chart-5'}))`;
// Whole class names, so Tailwind sees them: the legend dot matches its slice.
const PIE_DOT: Record<string, string> = {
  'engine.revenue.nettoFahrpreis': 'bg-chart-2',
  'engine.revenue.aktionen': 'bg-chart-3',
  'engine.revenue.trinkgeld': 'bg-chart-4',
  'engine.revenue.bargeld': 'bg-chart-1',
};
const pieDot = (key: string) => PIE_DOT[key] ?? 'bg-chart-5';

// ── Delta badge ───────────────────────────────────────────────────────────────
const DeltaBadge: React.FC<{ delta: number | null; higherIsBetter?: boolean }> = ({
  delta,
  higherIsBetter = true,
}) => {
  if (delta === null) return <span className="text-xs text-fg-subtle">k.V.</span>;
  const positive = higherIsBetter ? delta >= 0 : delta <= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-chip px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
        positive ? 'bg-positive-soft text-positive' : 'bg-critical-soft text-critical'
      }`}
    >
      {delta >= 0 ? <ArrowUpRight size={10} aria-hidden /> : <ArrowDownRight size={10} aria-hidden />}
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
  <div className="glass-card flex cursor-default flex-col gap-3 rounded-surface p-4 font-ui sm:p-5">
    <div className="flex flex-col-reverse items-start gap-2 min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between">
      <span className="min-w-0 break-words text-xs font-medium uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <div className={`shrink-0 rounded-tight p-2 ${iconBg} ${iconColor}`}>
        {icon}
      </div>
    </div>
    <div>
      <div className="[container-type:inline-size]">
        <p className="text-[clamp(1.0625rem,14cqi,1.5rem)] font-semibold leading-tight tabular-nums text-fg">{value}</p>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {sub && <p className="text-xs text-fg-subtle">{sub}</p>}
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
    <div className="rounded-lg border border-line bg-overlay px-3 py-2 text-xs shadow-overlay">
      <p className="mb-1 font-semibold text-fg">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} className="flex justify-between gap-4 tabular-nums">
          <span className="text-fg-muted">{entry.name}</span>
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
    danger:  { tone: 'critical' as const, icon: AlertCircle },
    warning: { tone: 'caution' as const,  icon: AlertTriangle },
    info:    { tone: 'brand' as const,    icon: Info },
    success: { tone: 'positive' as const, icon: CheckCircle },
  }[type];
  return (
    <Alert tone={s.tone} icon={s.icon} title={title} role="status">
      {body}
    </Alert>
  );
};

// ── Section header ────────────────────────────────────────────────────────────
const SectionHeader: React.FC<{
  title: string; sub?: string; icon: React.ReactNode; action?: React.ReactNode;
}> = ({ title, sub, icon, action }) => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-tight bg-sunken text-fg-subtle">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-fg">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
      </div>
    </div>
    {action}
  </div>
);

// ── Panel wrapper ─────────────────────────────────────────────────────────────
const Panel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <Card className={`p-4 font-ui sm:p-5 ${className}`}>
    {children}
  </Card>
);

// ── Plan status card ─────────────────────────────────────────────────────────

const PLAN_LABEL: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };
// Tiers keep their old hue on the tone tokens: basic blue, advanced amber, premium green.
const PLAN_TONE: Record<Plan, { box: string; chip: string; text: string }> = {
  basic:    { box: 'border-info/20 bg-info-soft',         chip: 'bg-raised',     text: 'text-info' },
  advanced: { box: 'border-caution/20 bg-caution-soft',   chip: 'bg-raised',  text: 'text-caution' },
  premium:  { box: 'border-positive/20 bg-positive-soft', chip: 'bg-raised', text: 'text-positive' },
};
// Keys, not text: this map lives outside any component, and t() is a hook value.
const STATUS_LABEL: Record<string, TranslationKey> = {
  active:        'overview.status.active',
  suspended:     'overview.status.suspended',
  inactive:      'overview.status.inactive',
};

const PlanStatusCard: React.FC<{ planState: PlanState; effectivePlan: Plan }> = ({ planState, effectivePlan }) => {
  const { t } = useTranslation();
  const tone = PLAN_TONE[planState.plan];

  return (
    <div className={`flex flex-wrap items-center justify-between gap-4 rounded-surface border p-4 font-ui ${tone.box}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-tight bg-raised shadow-hi ${tone.text}`}>
          <Zap size={18} aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">
              {t('overview.plan.named', { plan: PLAN_LABEL[effectivePlan] })}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.chip} ${tone.text}`}>
              {STATUS_LABEL[planState.status] ? t(STATUS_LABEL[planState.status]) : planState.status}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-fg-muted">
            {planState.status === 'active' ? t('overview.plan.activeSub') : null}
          </p>
        </div>
      </div>
    </div>
  );
};

export default OverviewPage;
