import { useState, useEffect } from 'react';
import { AlertTriangle, Banknote, Download, Filter, Minus, PiggyBank, Plus, Receipt as ReceiptIcon, RotateCcw, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { cashLedgerInScope } from '../utils/salaryCashReceiptFlow';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import CashEntryDialog from '../components/CashEntryDialog';
import type { CashEntryDirection } from '../utils/cashEntry';
import {
  bargeldIncomeEntries,
  belegEntries,
  cashBelegRows,
  cashLedgerDriverNames,
  cashMovementEntries,
  filterCashEntries,
  sortCashEntriesByDateDesc,
  summarizeCashLedger,
  type BargeldIncomeRow,
  type BelegRow,
  type CashLedgerEntry,
  type CashLedgerLabels,
  type CashLedgerTotals,
  type CashMovementRow,
} from '../utils/cashLedger';
import {
  Alert,
  Badge,
  Button,
  Card,
  cn,
  DataTable,
  EmptyState,
  Field,
  formatEuroCents,
  Input,
  KpiCard,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type DataTableColumn,
} from '../components/ui';
import { UUID_LOOKUP_CHUNK } from '../utils/postgrestLookup';

/**
 * Bargeldbestand reads one ledger.
 *
 * The money rule: cash in is the Bargeld a driver hands over; cash out is a
 * Beleg *paid in cash* and a Gehaltsquittung, the cash salary payment
 * confirm_salary_cash_payment books into public.cash_movements. Voiding one
 * books the cash back on the day of the void. The weekly "Bar zurück" counts
 * as paid and writes no movement, so it never leaves the till here.
 *
 * `receipts.payment_method` decides the first of those: `'uberweisung'` money
 * left the bank account, not the cash box, and `abrechnung_weekly` and
 * `get_current_cash_balance` have always restricted to `'bar'`. This screen
 * did not ask for the column at all, so it charged every Beleg to the till and
 * read lower than the till was — by 110,00 € in 04/2026 and 79,91 € in
 * 05/2026 for the one company on staging that has bank-paid Belege (4 of 857
 * rows, measured 28.09.2026). The select below asks for it and
 * cashBelegRows() applies the rule, so the balance, the cards, the table and
 * the Excel dump all now say what the weekly Abrechnung says.
 *
 * Before this the screen summed Bargeld minus Belege and knew nothing of the
 * third term, so a salary paid out of the till left the balance untouched.
 * Adding it changes no company's figure for any month without a
 * Gehaltsquittung — which was every month up to this release; the comparison
 * in tests/staging/cash-ledger-parity.sql is the evidence.
 *
 * The arithmetic is integer cents (utils/cashLedger.ts); euros appear only in
 * the formatting below.
 *
 * ## Not every reader can see the third term
 *
 * cash_movements and salary_cash_receipts used to be SELECT-policied
 * `company_id = get_user_company_id()` with no platform branch — unlike income
 * and receipts, which had one. Platform staff who had entered a customer
 * therefore read that customer's real Bargeld and Belege and *no* movements at
 * all, and an empty set there is indistinguishable from "no payouts". Printing
 * 0,00 € under "Gehaltsauszahlungen (bar)" would turn a missing read into a
 * claim.
 *
 * Slice 3.3 (20260917130000) did not lift that guard; it narrowed it, giving
 * both tables the SELECT shape every business table carries. Slice 3.4
 * (20260917140000) then moved the platform half: `platform_reads_company_data()`
 * is a constant false, and a platform account reads a company's ledger only
 * through a support session open on that company. So the ledger is in scope
 * for the caller's own company — while the database still admits it — or
 * inside such a session, and nowhere else: not for `billing`, which holds no
 * `business.read`, and not for any role with the capability and no session.
 * Out of scope this screen drops the payout card, keeps the older
 * `Bargeld − Belege` label and says why, and the Excel dump carries the same
 * caveat. The decision is cashLedgerInScope().
 */

const EMPTY_TOTALS: CashLedgerTotals = {
  cashInCents: 0,
  cashOutCents: 0,
  balanceCents: 0,
  bargeldIncomeCents: 0,
  belegExpenseCents: 0,
  salaryPayoutCents: 0,
  manualInCents: 0,
  manualOutCents: 0,
};

/** PostgREST puts the whole `.in()` list in the URL, so ask in chunks — see postgrestLookup.ts for the bound. */
const RECEIPT_LOOKUP_CHUNK = UUID_LOOKUP_CHUNK;

export default function BargeldbestandPage() {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const [totals, setTotals] = useState<CashLedgerTotals>(EMPTY_TOTALS);
  const [entries, setEntries] = useState<CashLedgerEntry[]>([]);
  const [filteredEntries, setFilteredEntries] = useState<CashLedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [drivers, setDrivers] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const { user, loading: authLoading, companyId: ownCompanyId, can } = useAuth();
  const [entryDirection, setEntryDirection] = useState<CashEntryDirection | null>(null);
  const {
    effectiveCompanyId: companyId, isViewingAsCompany, platformReadsCompanyData, ownCompanyReadable,
  } = useSuperAdmin();
  const { showToast } = useToast();

  // The same scope the Gehaltsquittung screens use, because it is the same two
  // tables and the same policy. Not a bare !isViewingAsCompany: staff who enter
  // their *own* company still read the ledger, and that would have hidden it.
  const ledgerInScope = cashLedgerInScope({
    companyId: ownCompanyId,
    effectiveCompanyId: companyId,
    isViewingAsCompany,
    // The seam as the database now answers it: business.read *and* a live
    // context on this company. The capability alone reads nothing since
    // 20260917140000, so passing it here would make this guard a rubber stamp.
    platformReadsCompanyData,
    // And the own company only while the database still admits it: a platform
    // account is let past App.tsx's approval and subscription gates, the
    // database's tenant term is not.
    ownCompanyReadable,
  });

  const ledgerLabels: CashLedgerLabels = {
    bargeldIncome: t('bargeld.incomeEntry'),
    beleg: t('bargeld.beleg'),
    gehaltsquittung: t('bargeld.gehaltsquittung'),
    gehaltsquittungStorno: t('bargeld.gehaltsquittungStorno'),
    manualIn: t('bargeld.manualIn'),
    manualOut: t('bargeld.manualOut'),
    other: t('bargeld.cashMovement'),
  };

  useEffect(() => {
    if (!authLoading) {
      loadCashData();
    }
    // companyId and ledgerInScope: entering or leaving a company changes both
    // which rows to load and whether the ledger is among them.
  }, [user, authLoading, selectedMonth, companyId, ledgerInScope]);

  useEffect(() => {
    applyFilters();
  }, [entries, selectedDriver, selectedType, startDate, endDate]);

  /**
   * The driver behind each payout. cash_movements carries none on purpose —
   * source_id names the Gehaltsquittung, and the driver is on that. Without
   * this lookup a payout would vanish whenever the driver filter is used.
   */
  async function loadPayoutDriverNames(sourceIds: string[]): Promise<Record<string, string>> {
    if (sourceIds.length === 0) return {};

    const { data: driverRows, error: driversError } = await supabase
      .from('drivers')
      .select('id, name')
      .eq('company_id', companyId);
    if (driversError) throw driversError;

    const nameByDriverId = new Map((driverRows ?? []).map(d => [d.id as string, d.name as string]));
    const nameBySourceId: Record<string, string> = {};

    for (let i = 0; i < sourceIds.length; i += RECEIPT_LOOKUP_CHUNK) {
      const { data, error } = await supabase
        .from('salary_cash_receipts')
        .select('id, driver_id')
        .eq('company_id', companyId)
        .in('id', sourceIds.slice(i, i + RECEIPT_LOOKUP_CHUNK));
      if (error) throw error;

      for (const receipt of data ?? []) {
        const name = nameByDriverId.get(receipt.driver_id as string);
        if (name) nameBySourceId[receipt.id as string] = name;
      }
    }

    return nameBySourceId;
  }

  /** The month's movements. Written only by confirm_salary_cash_payment and void_salary_cash_receipt. */
  async function loadCashMovements(monthStart: string, monthEnd: string): Promise<CashMovementRow[]> {
    return fetchAllPaginated<CashMovementRow>(
      (from, to) => supabase
        .from('cash_movements')
        .select('id, direction, amount, movement_date, source_type, source_id, description')
        .eq('company_id', companyId)
        .gte('movement_date', monthStart)
        .lte('movement_date', monthEnd)
        .order('id', { ascending: true })
        .range(from, to),
      { label: t('bargeld.load.movements') },
    );
  }

  async function loadCashData() {
    if (!user?.email) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setLoadFailed(false);

      const monthStart = format(startOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');
      const monthEnd = format(endOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');

      // All three sources are paginated, ordered by id so that a page boundary
      // cannot duplicate or drop a row. PostgREST caps a response at 1000 rows
      // and reports no error when it truncates, so a bare .select() would leave
      // the balance, the cards and the Excel export quietly under-reporting
      // cash. The largest company on staging already holds 836 Belege and 677
      // income rows in a single month — one busy month from the cap. The
      // OverviewPage reads the same tables this way.
      const [incomeRows, receiptRows, movementRows] = await Promise.all([
        fetchAllPaginated<BargeldIncomeRow>(
          (from, to) => supabase
            .from('income')
            .select('id, amount, type, description, driver_name, date')
            .eq('company_id', companyId)
            .eq('type', 'bargeld')
            .gte('date', monthStart)
            .lte('date', monthEnd)
            .order('id', { ascending: true })
            .range(from, to),
          { label: t('bargeld.load.income') },
        ),
        fetchAllPaginated<BelegRow>(
          (from, to) => supabase
            .from('receipts')
            // payment_method is load-bearing, not decoration: without it
            // cashBelegRows() below keeps nothing and the Belege total reads
            // 0,00 €. src/utils/moneyScreenFailures.test.ts pins it.
            .select('id, expense, description, driver_name, date, payment_method')
            .eq('company_id', companyId)
            .gte('date', monthStart)
            .lte('date', monthEnd)
            .order('id', { ascending: true })
            .range(from, to),
          { label: t('bargeld.load.belege') },
        ),
        // Out of scope the policy answers an empty set, which reads exactly
        // like "no payouts". Don't ask, and don't claim a zero below.
        ledgerInScope ? loadCashMovements(monthStart, monthEnd) : Promise.resolve<CashMovementRow[]>([]),
      ]);


      const payoutDrivers = await loadPayoutDriverNames(
        Array.from(new Set(movementRows.filter(m => m.source_id).map(m => m.source_id))),
      );

      const allEntries = sortCashEntriesByDateDesc([
        ...bargeldIncomeEntries(incomeRows, ledgerLabels),
        // Only the cash ones: a bank transfer never passed through the till.
        ...belegEntries(cashBelegRows(receiptRows), ledgerLabels),
        ...cashMovementEntries(movementRows, ledgerLabels, payoutDrivers),
      ]);

      // The cards describe the month, not the filtered table — as they always did.
      setTotals(summarizeCashLedger(allEntries));
      setEntries(allEntries);
      setDrivers(cashLedgerDriverNames(allEntries));
    } catch (error: any) {
      console.error('Error loading cash data:', error);
      showToast('error', t('bargeld.loadFailed'));
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }

  function applyFilters() {
    setFilteredEntries(
      filterCashEntries(entries, {
        driverName: selectedDriver !== 'all' ? selectedDriver : undefined,
        direction: selectedType === 'income' ? 'in' : selectedType === 'expense' ? 'out' : undefined,
        from: startDate || undefined,
        to: endDate || undefined,
      }),
    );
  }

  function resetFilters() {
    setSelectedDriver('all');
    setSelectedType('all');
    setStartDate('');
    setEndDate('');
  }

  /**
   * Cents to the euro text the older parts of this screen have always shown —
   * a decimal point, against the German comma rule. The two cards this slice
   * adds use formatCentsDe instead, so a figure introduced here is written the
   * German way from the start; rounding is identical either way, since cents
   * are integers. Converting the older cards, the table and the Excel export
   * is a visual change that belongs with the Phase 5 pass over this page.
   */
  function euro(cents: number): string {
    return (cents / 100).toFixed(2);
  }

  function handleExport() {
    const filters: string[] = [t('bargeld.filterMonth', { value: selectedMonth })];
    if (selectedDriver !== 'all') filters.push(t('bargeld.filterDriver', { value: selectedDriver }));
    if (selectedType !== 'all') filters.push(t('bargeld.filterType', { value: selectedType === 'income' ? t('common.income') : t('common.expenses') }));
    if (startDate) filters.push(t('bargeld.filterFrom', { value: new Date(startDate).toLocaleDateString('de-DE') }));
    if (endDate) filters.push(t('bargeld.filterTo', { value: new Date(endDate).toLocaleDateString('de-DE') }));
    // The dump carries the screen's caveat, so a file saved from a platform
    // view cannot later be read as a complete till.
    if (!ledgerInScope) filters.push(t('bargeld.ledgerUnavailable'));

    const filteredTotals = summarizeCashLedger(filteredEntries);

    exportPicker.table('cashBalance', {
      filename: `bargeldbestand_${selectedMonth}`,
      sheetTitle: t('nav.bargeldbestand'),
      moduleName: t('nav.bargeldbestand'),
      filterSummary: filters,
      columns: [
        { key: 'date',        label: t('common.date'),        width: 14, format: v => new Date(v as string).toLocaleDateString('de-DE') },
        { key: 'type',        label: t('fleet.typeColumn'),    width: 14, format: v => v === 'income' ? t('bargeld.incomeCol') : t('bargeld.expenseCol') },
        { key: 'driver_name', label: t('common.driver'),        width: 22 },
        { key: 'description', label: t('common.description'),  width: 36 },
        // The row below divides the ledger's integer cents by 100, so what
        // reaches this column is euros — the unit the money format prints.
        { key: 'amount',      label: t('bargeld.amountEuro'),    width: 16, align: 'right', type: 'money' },
      ],
      rows: filteredEntries.map(entry => ({
        date: entry.date,
        type: entry.direction === 'in' ? 'income' : 'expense',
        driver_name: entry.driverName,
        description: entry.description,
        amount: entry.amountCents / 100,
      })),
      totals: {
        amount: `+${euro(filteredTotals.cashInCents)} / -${euro(filteredTotals.cashOutCents)}`,
      },
    });
  }

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for the three
  // `loadFailed` lines; everything below only draws it. The cards and the table
  // show the integer cents summarizeCashLedger and the ledger entries carry,
  // formatted once through utils/money.ts (formatEuroCents): no arithmetic here.
  // euro() above still writes the Excel export exactly as it always did.

  // Booking is the company's own act: the database refuses a platform context
  // outright (platform_session_not_allowed), so the buttons are not offered
  // there, nor where the ledger is not even readable.
  const canBook = ledgerInScope && !!ownCompanyId && ownCompanyId === companyId && can('cash-balance', 'edit');
  const hasManualEntries = totals.manualInCents + totals.manualOutCents > 0;
  const filtersActive = selectedDriver !== 'all' || selectedType !== 'all' || startDate || endDate;
  const balancePositive = totals.balanceCents >= 0;

  const columns: DataTableColumn<CashLedgerEntry>[] = [
    { id: 'date', header: t('common.date'), kind: 'date', value: entry => entry.date, sortable: true, className: 'pl-3 pr-2 sm:px-4' },
    {
      id: 'type',
      header: t('fleet.typeColumn'),
      // On a phone the sign in front of the amount carries the direction.
      hideBelow: 'sm',
      cell: entry =>
        entry.direction === 'in' ? (
          <Badge tone="positive">
            <TrendingUp aria-hidden />
            {t('bargeld.incomeCol')}
          </Badge>
        ) : (
          <Badge tone="critical">
            <TrendingDown aria-hidden />
            {t('bargeld.expenseCol')}
          </Badge>
        ),
    },
    // On a phone the driver is the description's second line: four columns
    // side by side were 74 px wider than a 375 px screen.
    { id: 'driver', header: t('common.driver'), value: entry => entry.driverName, sortable: true, hideBelow: 'sm' },
    {
      id: 'description',
      header: t('common.description'),
      value: entry => entry.description,
      className: 'px-2 sm:min-w-[9rem] sm:px-4',
      cell: entry => (
        <span className="block py-1">
          {entry.description}
          {entry.driverName ? <span className="block text-xs text-fg-muted sm:hidden">{entry.driverName}</span> : null}
        </span>
      ),
    },
    {
      id: 'amount',
      header: t('common.amount'),
      kind: 'currency',
      className: 'pl-2 pr-3 sm:px-4',
      cell: entry => (
        <span className={cn('font-semibold', entry.direction === 'in' ? 'text-positive' : 'text-critical')}>
          {entry.direction === 'in' ? '+' : '-'}
          {formatEuroCents(entry.amountCents)}
        </span>
      ),
    },
  ];

  const showManualCard = ledgerInScope && hasManualEntries;
  const kpiGrid = cn(
    'grid grid-cols-1 gap-4 sm:grid-cols-2',
    !ledgerInScope ? 'xl:grid-cols-3' : showManualCard ? 'xl:grid-cols-5' : 'xl:grid-cols-4',
  );

  const cards = isLoading ? (
    <div className={kpiGrid}>
      {Array.from({ length: ledgerInScope ? 4 : 3 }, (_, index) => (
        <KpiCard key={index} label="" value="" loading />
      ))}
    </div>
  ) : loadFailed ? (
    // A failed read has no month to describe. The zeros and the previous
    // month's figures the state still holds would both be claims.
    <Alert tone="critical" title={t('bargeld.loadFailed')}>
      {t('bargeld.loadFailedBody')}
    </Alert>
  ) : (
    <div className={kpiGrid}>
      <KpiCard
        label={t('bargeld.cashIncome')}
        value={formatEuroCents(totals.bargeldIncomeCents)}
        icon={Wallet}
        caption={t('bargeld.totalCash')}
      />
      <KpiCard
        label={t('bargeld.belegExpenses')}
        value={formatEuroCents(totals.belegExpenseCents)}
        icon={ReceiptIcon}
        caption={t('bargeld.totalBelege')}
      />
      {ledgerInScope && (
        <KpiCard
          label={t('bargeld.salaryPayouts')}
          value={formatEuroCents(totals.salaryPayoutCents)}
          icon={Banknote}
          caption={t('bargeld.salaryPayoutsHint')}
        />
      )}
      {showManualCard && (
        <KpiCard
          label={t('bargeld.manualCard')}
          value={formatEuroCents(totals.manualInCents - totals.manualOutCents)}
          icon={PiggyBank}
          caption={t('bargeld.manualCardHint')}
        />
      )}
      <KpiCard
        label={t('bargeld.currentBalance')}
        value={
          <span className={balancePositive ? undefined : 'text-caution'}>{formatEuroCents(totals.balanceCents)}</span>
        }
        icon={balancePositive ? Wallet : AlertTriangle}
        caption={
          !ledgerInScope
            ? t('bargeld.balanceFormulaNoLedger')
            : showManualCard
              ? t('bargeld.balanceFormulaManual')
              : t('bargeld.balanceFormula')
        }
      />
    </div>
  );

  return (
    <div className="font-ui">
      <PageHeader
        title={t('nav.bargeldbestand')}
        actions={
          <>
            {canBook && (
              <>
                <Button onClick={() => setEntryDirection('in')} disabled={isLoading || loadFailed}>
                  <Plus aria-hidden />
                  {t('bargeld.addIn')}
                </Button>
                <Button variant="secondary" onClick={() => setEntryDirection('out')} disabled={isLoading || loadFailed}>
                  <Minus aria-hidden />
                  {t('bargeld.addOut')}
                </Button>
              </>
            )}
            <Input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              aria-label={t('common.month')}
              className="w-44"
            />
            <Button
              variant="secondary"
              onClick={handleExport}
              disabled={isLoading || loadFailed}
              title={t('common.exportExcel')}
            >
              <Download aria-hidden />
              {t('common.exportExcelShort')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4">
        {!ledgerInScope && <Alert tone="caution">{t('bargeld.ledgerUnavailable')}</Alert>}

        {cards}

        <section aria-labelledby="bargeld-transactions" className="grid grid-cols-1 gap-3 pt-2">
          <h2 id="bargeld-transactions" className="text-[15px] font-semibold text-fg">
            {t('bargeld.transactions')}
          </h2>

          {!loadFailed && (
            <Card className="grid grid-cols-1 gap-4 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('common.driver')}>
                  <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('common.allDrivers')}</SelectItem>
                      {drivers.map(driver => (
                        <SelectItem key={driver} value={driver}>
                          {driver}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('fleet.typeColumn')}>
                  <Select value={selectedType} onValueChange={setSelectedType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('common.all')}</SelectItem>
                      <SelectItem value="income">{t('common.income')}</SelectItem>
                      <SelectItem value="expense">{t('common.expenses')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('common.dateFrom')}>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </Field>
                <Field label={t('common.dateTo')}>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </Field>
              </div>
              {filtersActive && (
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" onClick={resetFilters}>
                    <RotateCcw aria-hidden />
                    {t('bargeld.resetFilters')}
                  </Button>
                </div>
              )}
            </Card>
          )}

          <DataTable
            caption={t('bargeld.transactions')}
            columns={columns}
            rows={filteredEntries}
            getRowId={entry => entry.id}
            loading={isLoading}
            error={loadFailed}
            onRetry={() => loadCashData()}
            emptyState={<EmptyState size="sm" icon={Filter} title={t('bargeld.noTransactions')} />}
          />
        </section>
      </div>
      <CashEntryDialog direction={entryDirection} onClose={() => setEntryDirection(null)} onBooked={() => loadCashData()} />
    </div>
  );
}
