import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Banknote,
  Calculator,
  CalendarDays,
  Plus,
  Receipt,
  ShieldAlert,
  ShieldX,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  KpiCard,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  formatDate,
  formatEuroCents,
  formatPercent,
  type DataTableColumn,
  type KpiTrend,
} from '../../components/ui';
import { DESIGN_PREVIEW_PATH } from '../gate';
import { RevenueChart, type RevenuePoint } from '../RevenueChart';
import {
  PREVIEW_CASH_CENTS,
  PREVIEW_CASH_DATE,
  PREVIEW_MONTHS,
  PREVIEW_OPEN_SALARIES,
  PREVIEW_PERIOD,
  PREVIEW_VEHICLES,
  centsToEuros,
  driverName,
  monthLabel,
  profitCents,
  shortMonthLabel,
  sumCents,
  tuevOn,
  type PreviewMonth,
  type PreviewSalary,
  type TuevState,
} from '../sampleData';
import { TONE_TEXT_CLASS, TUEV_PRESENTATION } from '../TuevStatus';

const monthKey = (month: Pick<PreviewMonth, 'year' | 'monthIndex'>) => `${month.year}-${month.monthIndex}`;

/** A month-on-month change as a signed German percentage, or nothing for the first month. */
function trendBetween(current: number, previous: number | undefined, risingIsGood: boolean): KpiTrend | undefined {
  if (!previous) return undefined;
  const ratio = (current - previous) / previous;
  const direction = Math.abs(ratio) < 0.0005 ? 'flat' : ratio > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? null : (direction === 'up') === risingIsGood;
  return {
    direction,
    value: `${ratio > 0 ? '+' : ''}${formatPercent(ratio)}`,
    sentiment: good === null ? 'neutral' : good ? 'positive' : 'negative',
  };
}

type AlertTone = 'critical' | 'caution' | 'brand';

const ALERT_TONE_CLASS: Record<AlertTone, string> = {
  critical: 'bg-critical-soft text-critical',
  caution: 'bg-caution-soft text-caution',
  brand: 'bg-brand-soft text-brand-text',
};

interface Alert {
  id: string;
  tone: AlertTone;
  icon: LucideIcon;
  text: string;
  to: string;
}

const FLEET_ORDER: TuevState[] = ['valid', 'expiringSoon', 'expired', 'unknown'];

interface MonthRow extends PreviewMonth {
  label: string;
}

export default function DashboardPreview() {
  const { t, language } = useTranslation();
  const [periodKey, setPeriodKey] = useState(monthKey(PREVIEW_PERIOD));

  const periodIndex = Math.max(0, PREVIEW_MONTHS.findIndex(month => monthKey(month) === periodKey));
  const period = PREVIEW_MONTHS[periodIndex];
  const previous = PREVIEW_MONTHS[periodIndex - 1] as PreviewMonth | undefined;
  const periodLabel = monthLabel(period.year, period.monthIndex, language);
  const reportingLabel = monthLabel(PREVIEW_PERIOD.year, PREVIEW_PERIOD.monthIndex, language);

  const vehicleStatus = useMemo(() => PREVIEW_VEHICLES.map(vehicle => ({ vehicle, tuev: tuevOn(vehicle.tuevValidUntil) })), []);
  const openSalariesCents = sumCents(PREVIEW_OPEN_SALARIES.map(salary => salary.dueCents - salary.paidCents));
  const margin = profitCents(period) / period.revenueCents;

  const alerts: Alert[] = [
    ...vehicleStatus
      .filter(({ tuev }) => tuev.state === 'expired')
      .map(({ vehicle, tuev }) => ({
        id: `tuev-${vehicle.id}`,
        tone: 'critical' as const,
        icon: ShieldX,
        text: t('preview.alerts.tuevExpired', { plate: vehicle.plate, days: Math.abs(tuev.daysLeft ?? 0) }),
        to: `${DESIGN_PREVIEW_PATH}/fahrzeuge`,
      })),
    ...vehicleStatus
      .filter(({ tuev }) => tuev.state === 'expiringSoon')
      .sort((a, b) => (a.tuev.daysLeft ?? 0) - (b.tuev.daysLeft ?? 0))
      .map(({ vehicle, tuev }) => ({
        id: `tuev-${vehicle.id}`,
        tone: 'caution' as const,
        icon: ShieldAlert,
        text: t('preview.alerts.tuevSoon', { plate: vehicle.plate, days: tuev.daysLeft ?? 0 }),
        to: `${DESIGN_PREVIEW_PATH}/fahrzeuge`,
      })),
    {
      id: 'salaries',
      tone: 'caution',
      icon: Wallet,
      text: t('preview.alerts.salaries', {
        count: PREVIEW_OPEN_SALARIES.length,
        amount: formatEuroCents(openSalariesCents),
      }),
      to: `${DESIGN_PREVIEW_PATH}/gehaelter`,
    },
    {
      id: 'planning',
      tone: 'brand',
      icon: CalendarDays,
      text: t('preview.alerts.planning', { month: reportingLabel }),
      to: `${DESIGN_PREVIEW_PATH}/monatsplanung`,
    },
  ];

  const chartData: RevenuePoint[] = PREVIEW_MONTHS.map(month => ({
    key: monthKey(month),
    shortLabel: shortMonthLabel(month.year, month.monthIndex, language),
    longLabel: monthLabel(month.year, month.monthIndex, language),
    revenue: centsToEuros(month.revenueCents),
  }));

  const monthRows: MonthRow[] = PREVIEW_MONTHS.map(month => ({
    ...month,
    label: monthLabel(month.year, month.monthIndex, language),
  }));

  const monthColumns: DataTableColumn<MonthRow>[] = [
    { id: 'month', header: t('common.month'), value: row => row.label },
    { id: 'revenue', header: t('overview.kpi.umsatz'), kind: 'currency', value: row => centsToEuros(row.revenueCents) },
    { id: 'costs', header: t('overview.chart.kosten'), kind: 'currency', value: row => centsToEuros(row.costsCents), hideBelow: 'sm' },
    { id: 'salaries', header: t('nav.salaries'), kind: 'currency', value: row => centsToEuros(row.salariesCents), hideBelow: 'md' },
    { id: 'profit', header: t('overview.chart.gewinn'), kind: 'currency', value: row => centsToEuros(profitCents(row)) },
  ];

  const salaryColumns: DataTableColumn<PreviewSalary>[] = [
    { id: 'driver', header: t('overview.salaries.driver'), value: row => driverName(row.driverId), sortable: true },
    {
      id: 'period',
      header: t('common.period'),
      value: row => `${row.year}-${String(row.monthIndex + 1).padStart(2, '0')}`,
      cell: row => monthLabel(row.year, row.monthIndex, language),
      hideBelow: 'sm',
    },
    { id: 'due', header: t('overview.salaries.due'), kind: 'currency', value: row => centsToEuros(row.dueCents), hideBelow: 'md' },
    { id: 'paid', header: t('overview.salaries.paid'), kind: 'currency', value: row => centsToEuros(row.paidCents), hideBelow: 'md' },
    {
      id: 'open',
      header: t('overview.salaries.open'),
      kind: 'currency',
      value: row => centsToEuros(row.dueCents - row.paidCents),
      sortable: true,
    },
    {
      id: 'status',
      header: t('overview.salaries.status'),
      value: row => (row.paidCents > 0 ? 'partial' : 'unpaid'),
      cell: row =>
        row.paidCents > 0 ? (
          <Badge tone="neutral">{t('overview.salaries.partial')}</Badge>
        ) : (
          <Badge tone="caution">{t('overview.salaries.unpaid')}</Badge>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('nav.overview')}
        description={t('preview.dashboard.description', { month: periodLabel })}
        actions={
          <>
            <Select value={periodKey} onValueChange={setPeriodKey}>
              <SelectTrigger className="w-44" aria-label={t('common.period')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...PREVIEW_MONTHS].reverse().map(month => (
                  <SelectItem key={monthKey(month)} value={monthKey(month)}>
                    {monthLabel(month.year, month.monthIndex, language)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button>
              <Plus aria-hidden />
              {t('overview.quick.addBeleg')}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t('overview.kpi.umsatz')}
          icon={Banknote}
          value={formatEuroCents(period.revenueCents)}
          trend={(() => {
            const trend = trendBetween(period.revenueCents, previous?.revenueCents, true);
            return trend && { ...trend, label: t('overview.kpi.vsPrevMonth') };
          })()}
        />
        <KpiCard
          label={t('overview.kpi.gesamtkosten')}
          icon={Receipt}
          value={formatEuroCents(period.costsCents)}
          trend={(() => {
            const trend = trendBetween(period.costsCents, previous?.costsCents, false);
            return trend && { ...trend, label: t('overview.kpi.vsPrevMonth') };
          })()}
          caption={previous ? undefined : t('overview.kpi.costBasis')}
        />
        <KpiCard
          label={t('overview.kpi.firmengewinn')}
          icon={Calculator}
          value={formatEuroCents(profitCents(period))}
          caption={`${t('overview.kpi.gewinnmarge')} ${formatPercent(margin)}`}
        />
        <KpiCard
          label={t('overview.kpi.bargeld')}
          icon={Wallet}
          value={formatEuroCents(PREVIEW_CASH_CENTS)}
          caption={t('preview.dashboard.cashHint', { date: formatDate(PREVIEW_CASH_DATE) })}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <Tabs defaultValue="chart">
            <CardHeader>
              <div>
                <CardTitle>{t('preview.trend.title')}</CardTitle>
                <CardDescription>{t('preview.trend.sub')}</CardDescription>
              </div>
              <TabsList variant="segmented" aria-label={t('preview.trend.title')}>
                <TabsTrigger value="chart">{t('preview.trend.chart')}</TabsTrigger>
                <TabsTrigger value="table">{t('preview.trend.table')}</TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent>
              <TabsContent value="chart">
                <RevenueChart data={chartData} label={t('preview.trend.title')} />
              </TabsContent>
              <TabsContent value="table">
                <DataTable
                  caption={t('preview.trend.title')}
                  columns={monthColumns}
                  rows={monthRows}
                  getRowId={row => monthKey(row)}
                  density="compact"
                />
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('overview.alerts.title')}</CardTitle>
              <CardDescription>{t('overview.alerts.sub')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {alerts.map(alert => {
                const Icon = alert.icon;
                return (
                  <li key={alert.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', ALERT_TONE_CLASS[alert.tone])}>
                      <Icon aria-hidden className="size-4" />
                    </span>
                    <p id={`alert-${alert.id}`} className="min-w-0 flex-1 pt-1.5 text-sm leading-snug text-fg">
                      {alert.text}
                    </p>
                    {/* Five links all named "Öffnen" are indistinguishable in a
                        screen reader's link list; the description says which. */}
                    <Button asChild variant="link" size="sm" className="mt-1.5">
                      <Link to={alert.to} aria-describedby={`alert-${alert.id}`}>
                        {t('preview.alerts.open')}
                      </Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{t('overview.salaries.title')}</CardTitle>
              <CardDescription>{t('overview.salaries.sub')}</CardDescription>
            </div>
            <Button asChild variant="link" size="sm">
              <Link to={`${DESIGN_PREVIEW_PATH}/gehaelter`}>
                {t('preview.salaries.viewAll')}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <DataTable
              caption={t('overview.salaries.title')}
              columns={salaryColumns}
              rows={PREVIEW_OPEN_SALARIES}
              getRowId={row => row.id}
              initialSort={{ columnId: 'open', direction: 'desc' }}
              totals={{
                driver: t('overview.salaries.totalOpen'),
                open: formatEuroCents(openSalariesCents),
              }}
              density="compact"
              className="rounded-none border-x-0 border-b-0 shadow-none"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('overview.fleet.title')}</CardTitle>
              <CardDescription>{t('preview.fleet.sub')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {FLEET_ORDER.map(state => {
                const { icon: Icon, tone, labelKey } = TUEV_PRESENTATION[state];
                const count = vehicleStatus.filter(({ tuev }) => tuev.state === state).length;
                return (
                  <li key={state} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5 text-fg">
                      <Icon aria-hidden className={cn('size-4', TONE_TEXT_CLASS[tone])} />
                      {t(labelKey)}
                    </span>
                    <span className="font-semibold tabular-nums text-fg">{count}</span>
                  </li>
                );
              })}
            </ul>
            <Button asChild variant="link" size="sm" className="mt-5">
              <Link to={`${DESIGN_PREVIEW_PATH}/fahrzeuge`}>
                {t('preview.fleet.viewAll')}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
