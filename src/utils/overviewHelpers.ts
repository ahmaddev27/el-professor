import { startOfMonth, endOfMonth, isWithinInterval, parseISO, subMonths, format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Income, Receipt } from '../types/receipt';
import {
  bargeldIncomeEntries,
  belegEntries,
  cashMovementEntries,
  summarizeCashLedger,
  type CashLedgerLabels,
  type CashMovementRow,
} from './cashLedger';

// Type-only: this module names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';
import type { TranslationKey, TranslationVars } from '../i18n';

export type { CashMovementRow };

/** Signature of the `t` from useTranslation(), for helpers that take it. */
type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

/**
 * calcCashSummary totals and never renders an entry, so these fallbacks reach
 * no screen; the ledger builders ask for them all the same. The screen that
 * does render entries (BargeldbestandPage) passes translated ones.
 */
const LEDGER_LABELS: CashLedgerLabels = {
  bargeldIncome: 'Bargeld',
  beleg: 'Beleg',
  gehaltsquittung: 'Gehaltsquittung',
  gehaltsquittungStorno: 'Storno Gehaltsquittung',
  other: 'Bargeldbewegung',
};

export interface FixedCostItem {
  id: string;
  description: string;
  amount: number;
}

export interface SalaryRecord {
  id: string;
  driver_id: string;
  driver_name?: string;
  period_start: string;
  period_end: string;
  amount_due: number;
  netto_salary?: number;
  status: string;
  payment_status?: 'unpaid' | 'partially_paid' | 'paid';
  total_paid?: number;
  remaining_balance?: number;
}

export interface DriverRecord {
  id: string;
  name: string;
  salary_ratio?: number;
  status?: 'active' | 'inactive';
}

export interface WerkstattCheck {
  id: string;
  car_id: string;
  status: 'positive' | 'negative' | 'repaired';
  check_date: string;
  notes: string;
  car?: { kennzeichen: string };
}

export interface UserProfileRecord {
  id: string;
  email: string;
  full_name?: string;
  role: string;
  status?: string;
  invited_at?: string;
}

// ── Period helpers ────────────────────────────────────────────────────────────

export function getMonthRange(monthString: string) {
  const date = parseISO(monthString + '-01');
  return { start: startOfMonth(date), end: endOfMonth(date) };
}

export function getPrevMonthString(monthString: string): string {
  const date = parseISO(monthString + '-01');
  return format(subMonths(date, 1), 'yyyy-MM');
}

// ── Core KPI calculations ─────────────────────────────────────────────────────

export interface PeriodMetrics {
  umsatz: number;        // online revenue (umsatz + aktionen)
  bargeld: number;       // cash income
  trinkgeld: number;     // tips
  aktionen: number;      // aktionen share
  nettoFahrpreis: number; // umsatz only (excluding aktionen)
  totalIncome: number;   // all income types summed
  salaries: number;      // total salary amount due
  expenses: number;      // receipt expenses
  fixedCosts: number;    // fixed costs (always full month)
  totalCosts: number;    // expenses + fixedCosts
  profit: number;        // umsatz - salaries - totalCosts
  profitMargin: number;  // profit / umsatz * 100
}

export function calcPeriodMetrics(
  incomes: Income[],
  salaries: SalaryRecord[],
  receipts: Receipt[],
  fixedCosts: FixedCostItem[],
  start: Date,
  end: Date
): PeriodMetrics {
  const periodIncomes = incomes.filter(i =>
    isWithinInterval(new Date(i.date), { start, end })
  );
  const periodSalaries = salaries.filter(s =>
    isWithinInterval(new Date(s.period_start), { start, end })
  );
  const periodReceipts = receipts.filter(r =>
    isWithinInterval(new Date(r.date), { start, end })
  );

  const umsatzOnly = periodIncomes
    .filter(i => i.type === 'umsatz')
    .reduce((s, i) => s + Number(i.amount), 0);
  const aktionen = periodIncomes
    .filter(i => i.type === 'aktionen')
    .reduce((s, i) => s + Number(i.amount), 0);
  const umsatz = umsatzOnly + aktionen;
  const bargeld = periodIncomes
    .filter(i => i.type === 'bargeld')
    .reduce((s, i) => s + Number(i.amount), 0);
  const trinkgeld = periodIncomes
    .filter(i => i.type === 'trinkgeld')
    .reduce((s, i) => s + Number(i.amount), 0);
  const totalIncome = umsatz + bargeld + trinkgeld;
  const salaryTotal = periodSalaries.reduce((s, sal) => s + Number(sal.amount_due), 0);
  const expenses = periodReceipts.reduce((s, r) => s + r.expense, 0);
  const fixedTotal = fixedCosts.reduce((s, c) => s + Number(c.amount), 0);
  const totalCosts = expenses + fixedTotal;
  const profit = umsatz - salaryTotal - totalCosts;
  const profitMargin = umsatz > 0 ? (profit / umsatz) * 100 : 0;

  return {
    umsatz,
    bargeld,
    trinkgeld,
    aktionen,
    nettoFahrpreis: umsatzOnly,
    totalIncome,
    salaries: salaryTotal,
    expenses,
    fixedCosts: fixedTotal,
    totalCosts,
    profit,
    profitMargin,
  };
}

// ── Period comparison ─────────────────────────────────────────────────────────

export interface PeriodComparison {
  umsatz: number;
  bargeld: number;
  salaries: number;
  totalCosts: number;
  profit: number;
  profitMargin: number;
}

export function calcDeltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// ── Driver performance ranking ────────────────────────────────────────────────

export interface DriverPerformance {
  id: string;
  name: string;
  umsatz: number;
  bargeld: number;
  salary: number;
  expenses: number;
  netContribution: number;
  profitMargin: number | null;
  receiptsCount: number;
  rank: number;
}

export function calcDriverPerformance(
  drivers: DriverRecord[],
  incomes: Income[],
  salaries: SalaryRecord[],
  receipts: Receipt[],
  start: Date,
  end: Date
): DriverPerformance[] {
  const periodIncomes = incomes.filter(i =>
    isWithinInterval(new Date(i.date), { start, end })
  );
  const periodSalaries = salaries.filter(s =>
    isWithinInterval(new Date(s.period_start), { start, end })
  );
  const periodReceipts = receipts.filter(r =>
    isWithinInterval(new Date(r.date), { start, end })
  );

  const performances = drivers.map(driver => {
    const driverIncomes = periodIncomes.filter(i => i.driver_name === driver.name);
    const driverSalaries = periodSalaries.filter(s => s.driver_id === driver.id);
    const driverReceipts = periodReceipts.filter(r => r.driverName === driver.name);

    const driverUmsatz = driverIncomes
      .filter(i => i.type === 'umsatz' || i.type === 'aktionen')
      .reduce((s, i) => s + Number(i.amount), 0);
    const driverBargeld = driverIncomes
      .filter(i => i.type === 'bargeld')
      .reduce((s, i) => s + Number(i.amount), 0);
    const salary = driverSalaries.reduce((s, sal) => s + Number(sal.amount_due), 0);
    const expenses = driverReceipts.reduce((s, r) => s + r.expense, 0);
    const netContribution = driverUmsatz - salary - expenses;
    const profitMargin = driverUmsatz > 0 ? (netContribution / driverUmsatz) * 100 : null;

    return {
      id: driver.id,
      name: driver.name,
      umsatz: driverUmsatz,
      bargeld: driverBargeld,
      salary,
      expenses,
      netContribution,
      profitMargin,
      receiptsCount: driverReceipts.length,
      rank: 0,
    };
  });

  return performances
    .sort((a, b) => b.netContribution - a.netContribution)
    .map((d, i) => ({ ...d, rank: i + 1 }));
}

// ── Salary alerts ─────────────────────────────────────────────────────────────

export interface SalaryAlert {
  id: string;
  driverName: string;
  amountDue: number;
  amountPaid: number;
  remaining: number;
  status: 'unpaid' | 'partially_paid';
  periodStart: string;
  periodEnd: string;
}

export function calcSalaryAlerts(
  salaries: SalaryRecord[],
  drivers: DriverRecord[]
): SalaryAlert[] {
  const driverMap = new Map(drivers.map(d => [d.id, d.name]));

  return salaries
    .filter(s => s.payment_status === 'unpaid' || s.payment_status === 'partially_paid')
    .map(s => ({
      id: s.id,
      driverName: s.driver_name || driverMap.get(s.driver_id) || 'Unbekannt',
      amountDue: Number(s.amount_due),
      amountPaid: Number(s.total_paid || 0),
      remaining: Number(s.remaining_balance || s.amount_due),
      status: (s.payment_status as 'unpaid' | 'partially_paid'),
      periodStart: s.period_start,
      periodEnd: s.period_end,
    }));
}

// ── Cash reconciliation ───────────────────────────────────────────────────────

export interface CashSummary {
  cashIncome: number;
  cashFromExpenses: number;
  /** Gehaltsquittungen minus their Stornos: the cash salaries took out of the till. */
  salaryPayouts: number;
  /** Everything that left the till: Belege plus salary payouts. */
  cashOut: number;
  cashBalance: number;
  cashRisk: 'ok' | 'warning' | 'danger';
}

/**
 * The till for a period, from the same ledger the Bargeldbestand screen reads.
 *
 * The money rule: cash in is Bargeld handed over by a driver; cash out is a
 * Beleg and a Gehaltsquittung (`cash_movements`, written by
 * confirm_salary_cash_payment), and voiding a Gehaltsquittung books the cash
 * back on the day of the void. The weekly "Bar zurück" writes no movement and
 * so moves no cash.
 *
 * `movements` defaults to empty, which reproduces the figure this returned
 * before the ledger existed — and is what it still returns for any period in
 * which no Gehaltsquittung was confirmed.
 *
 * Deliberately **not** in calcPeriodMetrics: profit already subtracts the full
 * `salaries` amount due, so counting the payout again would subtract the same
 * salary twice. A payout moves cash, it does not add cost.
 */
export function calcCashSummary(
  incomes: Income[],
  receipts: Receipt[],
  start: Date,
  end: Date,
  movements: readonly CashMovementRow[] = []
): CashSummary {
  const periodIncomes = incomes.filter(i =>
    isWithinInterval(new Date(i.date), { start, end })
  );
  const periodReceipts = receipts.filter(r =>
    isWithinInterval(new Date(r.date), { start, end })
  );
  const periodMovements = movements.filter(m =>
    isWithinInterval(new Date(m.movement_date), { start, end })
  );

  // Integer cents: a month of euro floats accumulates drift, and this figure is
  // the one a fleet owner counts the till against.
  const totals = summarizeCashLedger([
    ...bargeldIncomeEntries(
      periodIncomes.filter(i => i.type === 'bargeld'),
      LEDGER_LABELS
    ),
    ...belegEntries(
      periodReceipts.map(r => ({ id: r.id, expense: r.expense, description: r.description, driver_name: r.driverName, date: r.date })),
      LEDGER_LABELS
    ),
    ...cashMovementEntries(periodMovements, LEDGER_LABELS),
  ]);

  const cashIncome = totals.bargeldIncomeCents / 100;
  const cashFromExpenses = totals.belegExpenseCents / 100;
  const salaryPayouts = totals.salaryPayoutCents / 100;
  const cashOut = totals.cashOutCents / 100;
  const cashBalance = totals.balanceCents / 100;

  let cashRisk: 'ok' | 'warning' | 'danger' = 'ok';
  if (cashBalance < 0) cashRisk = 'danger';
  else if (cashBalance < cashIncome * 0.1) cashRisk = 'warning';

  return { cashIncome, cashFromExpenses, salaryPayouts, cashOut, cashBalance, cashRisk };
}

// ── 6-month trend data ────────────────────────────────────────────────────────

/**
 * A series key is also the label Recharts prints in its legend and tooltip, so
 * the key on the datum and the `dataKey` on the <Area> have to be the same
 * string. The chart already passed translated `dataKey`s while these were
 * hard-coded German, so in the English UI every series resolved to a key no
 * datum had and the chart drew nothing. Both sides read TREND_SERIES now.
 *
 * Unlike the engine messages beside it, this string has no second life outside
 * the chart — nothing matches, classifies or audits it — so it is a plain
 * `t(...)` rather than a German text carrying a key.
 */
export interface TrendDataPoint {
  monat: string;
  [series: string]: string | number;
}

export const TREND_SERIES = {
  umsatz:    'overview.kpi.umsatz',
  kosten:    'overview.chart.kosten',
  gewinn:    'overview.chart.gewinn',
  gehaelter: 'overview.load.gehaelter',
} as const satisfies Record<string, TranslationKey>;

export function buildTrendData(
  selectedMonth: string,
  incomes: Income[],
  salaries: SalaryRecord[],
  receipts: Receipt[],
  fixedCosts: FixedCostItem[],
  t: Translate,
): TrendDataPoint[] {
  return Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(parseISO(selectedMonth + '-01'), 5 - i);
    const mStart = startOfMonth(d);
    const mEnd = endOfMonth(d);
    const metrics = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, mStart, mEnd);
    return {
      monat: format(d, 'MMM', { locale: de }),
      [t(TREND_SERIES.umsatz)]:    metrics.umsatz,
      [t(TREND_SERIES.kosten)]:    metrics.totalCosts,
      [t(TREND_SERIES.gewinn)]:    metrics.profit,
      [t(TREND_SERIES.gehaelter)]: metrics.salaries,
    };
  });
}

// ── Expense visibility ────────────────────────────────────────────────────────

export interface ExpenseItem {
  description: string;
  amount: number;
  driverName: string;
  date: string;
  type: 'receipt' | 'fixed';
}

export function getTopExpenses(
  receipts: Receipt[],
  fixedCosts: FixedCostItem[],
  start: Date,
  end: Date,
  topN = 5
): ExpenseItem[] {
  const periodReceipts = receipts
    .filter(r => isWithinInterval(new Date(r.date), { start, end }))
    .map(r => ({
      description: r.description || r.receiptNumber,
      amount: r.expense,
      driverName: r.driverName,
      date: r.date,
      type: 'receipt' as const,
    }));

  const fixedItems: ExpenseItem[] = fixedCosts.map(c => ({
    description: c.description,
    amount: Number(c.amount),
    driverName: '',
    date: format(start, 'yyyy-MM-dd'),
    type: 'fixed' as const,
  }));

  return [...periodReceipts, ...fixedItems]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);
}

// ── Smart insights ────────────────────────────────────────────────────────────

export interface SmartInsight {
  type: 'success' | 'warning' | 'info' | 'danger';
  /** German, as this module has always written it. The screen's fallback. */
  title: string;
  titleKey?: EngineMessageKey;
  titleVars?: EngineMessageVars;
  body: string;
  bodyKey?: EngineMessageKey;
  bodyVars?: EngineMessageVars;
}

export function generateInsights(
  current: PeriodMetrics,
  previous: PeriodMetrics,
  drivers: DriverPerformance[],
  salaryAlerts: SalaryAlert[],
  fleetChecks: WerkstattCheck[]
): SmartInsight[] {
  const insights: SmartInsight[] = [];

  // Revenue vs previous month
  const umsatzDelta = calcDeltaPct(current.umsatz, previous.umsatz);
  if (umsatzDelta !== null) {
    if (umsatzDelta >= 5) {
      insights.push({
        type: 'success',
        title: 'Umsatz gestiegen',
        titleKey: 'engine.insight.revenueUp.title',
        body: `+${umsatzDelta.toFixed(1)}% im Vergleich zum Vormonat`,
        bodyKey: 'engine.insight.revenueUp.body',
        bodyVars: { pct: umsatzDelta.toFixed(1) },
      });
    } else if (umsatzDelta <= -5) {
      insights.push({
        type: 'warning',
        title: 'Umsatz gesunken',
        titleKey: 'engine.insight.revenueDown.title',
        body: `${umsatzDelta.toFixed(1)}% im Vergleich zum Vormonat`,
        bodyKey: 'engine.insight.revenueDown.body',
        bodyVars: { pct: umsatzDelta.toFixed(1) },
      });
    }
  }

  // Profit health
  if (current.profit < 0) {
    insights.push({
      type: 'danger',
      title: 'Verlust im aktuellen Monat',
      titleKey: 'engine.insight.loss.title',
      body: `Firmengewinn: ${current.profit.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      bodyKey: 'engine.insight.loss.body',
      bodyVars: { amount: current.profit.toLocaleString('de-DE', { minimumFractionDigits: 2 }) },
    });
  } else if (current.profitMargin > 30) {
    insights.push({
      type: 'success',
      title: 'Starke Gewinnmarge',
      titleKey: 'engine.insight.strongMargin.title',
      body: `${current.profitMargin.toFixed(1)}% Rentabilität diesen Monat`,
      bodyKey: 'engine.insight.strongMargin.body',
      bodyVars: { pct: current.profitMargin.toFixed(1) },
    });
  }

  // Top driver
  const topDriver = drivers[0];
  if (topDriver && topDriver.netContribution > 0) {
    insights.push({
      type: 'info',
      title: `Top-Fahrer: ${topDriver.name}`,
      titleKey: 'engine.insight.topDriver.title',
      titleVars: { driver: topDriver.name },
      body: `Nettoertrag: +${topDriver.netContribution.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      bodyKey: 'engine.insight.netContributionPositive',
      bodyVars: { amount: topDriver.netContribution.toLocaleString('de-DE', { minimumFractionDigits: 2 }) },
    });
  }

  // Worst driver
  const worst = drivers[drivers.length - 1];
  if (worst && worst !== topDriver && worst.netContribution < 0) {
    insights.push({
      type: 'warning',
      title: `Negativer Ertrag: ${worst.name}`,
      titleKey: 'engine.insight.worstDriver.title',
      titleVars: { driver: worst.name },
      body: `Nettoertrag: ${worst.netContribution.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      bodyKey: 'engine.insight.netContribution',
      bodyVars: { amount: worst.netContribution.toLocaleString('de-DE', { minimumFractionDigits: 2 }) },
    });
  }

  // Unpaid salaries
  const unpaidCount = salaryAlerts.filter(a => a.status === 'unpaid').length;
  const partialCount = salaryAlerts.filter(a => a.status === 'partially_paid').length;
  const unpaidTotal = salaryAlerts.reduce((s, a) => s + a.remaining, 0);
  if (unpaidCount > 0) {
    insights.push({
      type: 'warning',
      title: `${unpaidCount} unbezahlte Gehälter`,
      titleKey: 'engine.insight.unpaidSalaries.title',
      titleVars: { count: unpaidCount },
      body: `Offen: ${unpaidTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      bodyKey: 'engine.insight.unpaidSalaries.body',
      bodyVars: { amount: unpaidTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 }) },
    });
  } else if (partialCount > 0) {
    insights.push({
      type: 'info',
      title: `${partialCount} teilweise bezahlte Gehälter`,
      titleKey: 'engine.insight.partialSalaries.title',
      titleVars: { count: partialCount },
      body: `Restbetrag: ${unpaidTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      bodyKey: 'engine.insight.partialSalaries.body',
      bodyVars: { amount: unpaidTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 }) },
    });
  }

  // Fleet issues
  const negativeChecks = fleetChecks.filter(c => c.status === 'negative').length;
  if (negativeChecks > 0) {
    insights.push({
      type: 'danger',
      title: `${negativeChecks} Fahrzeug${negativeChecks > 1 ? 'e' : ''} mit Problemen`,
      // One key per number: German and English inflect the noun itself, not a
      // suffix the engine could splice on.
      titleKey: negativeChecks > 1
        ? 'engine.insight.fleetIssues.title.other'
        : 'engine.insight.fleetIssues.title.one',
      titleVars: { count: negativeChecks },
      body: 'Werkstatt-Checks zeigen negative Befunde',
      bodyKey: 'engine.insight.fleetIssues.body',
    });
  }

  return insights.slice(0, 6);
}

// ── Revenue composition ───────────────────────────────────────────────────────

export interface RevenueCompositionItem {
  /** German, as this module has always written it. The chart's fallback. */
  name: string;
  nameKey: EngineMessageKey;
  value: number;
  color: string;
}

export function buildRevenueComposition(metrics: PeriodMetrics): RevenueCompositionItem[] {
  return [
    { name: 'Netto-Fahrpreis', nameKey: 'engine.revenue.nettoFahrpreis', value: metrics.nettoFahrpreis, color: '#3b82f6' },
    { name: 'Aktionen', nameKey: 'engine.revenue.aktionen', value: metrics.aktionen, color: '#f59e0b' },
    { name: 'Trinkgeld', nameKey: 'engine.revenue.trinkgeld', value: metrics.trinkgeld, color: '#8b5cf6' },
    { name: 'Bargeld', nameKey: 'engine.revenue.bargeld', value: metrics.bargeld, color: '#10b981' },
  ].filter(i => i.value > 0);
}
