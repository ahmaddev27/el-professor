import { useState, useEffect } from 'react';
import { Wallet, Receipt as ReceiptIcon, Filter, TrendingUp, TrendingDown, Calendar, Download, Banknote } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { exportTableToExcel } from '../utils/excelExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { receiptScope } from '../utils/salaryCashReceiptFlow';
import {
  bargeldIncomeEntries,
  belegEntries,
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

/**
 * Bargeldbestand reads one ledger.
 *
 * The money rule: cash in is the Bargeld a driver hands over; cash out is a
 * Beleg and a Gehaltsquittung, the cash salary payment
 * confirm_salary_cash_payment books into public.cash_movements. Voiding one
 * books the cash back on the day of the void. The weekly "Bar zurück" counts
 * as paid and writes no movement, so it never leaves the till here.
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
 * ## One reader cannot see the third term
 *
 * cash_movements and salary_cash_receipts are SELECT-policied
 * `company_id = get_user_company_id()` with no super-admin branch — unlike
 * income and receipts, which have one. Platform staff who have entered a
 * customer therefore read that customer's real Bargeld and Belege and *no*
 * movements at all, and an empty set there is indistinguishable from "no
 * payouts". Printing 0,00 € under "Gehaltsauszahlungen (bar)" would turn a
 * missing read into a claim, for the one role that is supposed to read
 * everything.
 *
 * So when the ledger is out of scope this screen drops the payout card, keeps
 * the older `Bargeld − Belege` label and says why. Slice 3.3 gives both tables
 * the get_active_company_id() / platform_view_company_id() path; remove the
 * guard in that release.
 */

const EMPTY_TOTALS: CashLedgerTotals = {
  cashInCents: 0,
  cashOutCents: 0,
  balanceCents: 0,
  bargeldIncomeCents: 0,
  belegExpenseCents: 0,
  salaryPayoutCents: 0,
};

/** PostgREST puts the whole `.in()` list in the URL, so ask in chunks. */
const RECEIPT_LOOKUP_CHUNK = 200;

export default function BargeldbestandPage() {
  const { t } = useTranslation();
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
  const { user, loading: authLoading, companyId: ownCompanyId } = useAuth();
  const { effectiveCompanyId: companyId, isViewingAsCompany } = useSuperAdmin();
  const { showToast } = useToast();

  // The same scope the Gehaltsquittung screens use, because it is the same two
  // tables and the same policy. Not a bare !isViewingAsCompany: staff who enter
  // their *own* company still read the ledger, and that would have hidden it.
  const ledgerInScope =
    receiptScope({ companyId: ownCompanyId, effectiveCompanyId: companyId, isViewingAsCompany }) === 'own_company';

  const ledgerLabels: CashLedgerLabels = {
    bargeldIncome: t('bargeld.incomeEntry'),
    beleg: t('bargeld.beleg'),
    gehaltsquittung: t('bargeld.gehaltsquittung'),
    gehaltsquittungStorno: t('bargeld.gehaltsquittungStorno'),
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
    const { data, error } = await supabase
      .from('cash_movements')
      .select('id, direction, amount, movement_date, source_type, source_id, description')
      .eq('company_id', companyId)
      .gte('movement_date', monthStart)
      .lte('movement_date', monthEnd)
      .order('movement_date', { ascending: false });
    if (error) throw error;
    return (data ?? []) as CashMovementRow[];
  }

  async function loadCashData() {
    if (!user?.email) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      const monthStart = format(startOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');
      const monthEnd = format(endOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');

      const [incomeResult, receiptsResult, movementRows] = await Promise.all([
        supabase
          .from('income')
          .select('id, amount, type, description, driver_name, date')
          .eq('company_id', companyId)
          .eq('type', 'bargeld')
          .gte('date', monthStart)
          .lte('date', monthEnd)
          .order('date', { ascending: false }),
        supabase
          .from('receipts')
          .select('id, expense, description, driver_name, date')
          .eq('company_id', companyId)
          .gte('date', monthStart)
          .lte('date', monthEnd)
          .order('date', { ascending: false }),
        // Out of scope the policy answers an empty set, which reads exactly
        // like "no payouts". Don't ask, and don't claim a zero below.
        ledgerInScope ? loadCashMovements(monthStart, monthEnd) : Promise.resolve<CashMovementRow[]>([]),
      ]);

      if (incomeResult.error) throw incomeResult.error;
      if (receiptsResult.error) throw receiptsResult.error;

      const payoutDrivers = await loadPayoutDriverNames(
        Array.from(new Set(movementRows.filter(m => m.source_id).map(m => m.source_id))),
      );

      const allEntries = sortCashEntriesByDateDesc([
        ...bargeldIncomeEntries((incomeResult.data ?? []) as BargeldIncomeRow[], ledgerLabels),
        ...belegEntries((receiptsResult.data ?? []) as BelegRow[], ledgerLabels),
        ...cashMovementEntries(movementRows, ledgerLabels, payoutDrivers),
      ]);

      // The cards describe the month, not the filtered table — as they always did.
      setTotals(summarizeCashLedger(allEntries));
      setEntries(allEntries);
      setDrivers(cashLedgerDriverNames(allEntries));
    } catch (error: any) {
      console.error('Error loading cash data:', error);
      showToast('error', t('bargeld.loadFailed'));
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
   * Cents to the euro text this screen has always shown. Not formatCentsDe:
   * the screen writes a decimal point today, and moving it to the German comma
   * is a visual change that belongs with the Phase 5 pass over this page, not
   * with a change to what the figure means.
   */
  function euro(cents: number): string {
    return (cents / 100).toFixed(2);
  }

  function handleExport() {
    const filters: string[] = [`Monat: ${selectedMonth}`];
    if (selectedDriver !== 'all') filters.push(`Fahrer: ${selectedDriver}`);
    if (selectedType !== 'all') filters.push(`Typ: ${selectedType === 'income' ? t('common.income') : t('common.expenses')}`);
    if (startDate) filters.push(`Von: ${new Date(startDate).toLocaleDateString('de-DE')}`);
    if (endDate) filters.push(`Bis: ${new Date(endDate).toLocaleDateString('de-DE')}`);
    // The dump carries the screen's caveat, so a file saved from a platform
    // view cannot later be read as a complete till.
    if (!ledgerInScope) filters.push(t('bargeld.ledgerUnavailable'));

    const filteredTotals = summarizeCashLedger(filteredEntries);

    exportTableToExcel({
      filename: `bargeldbestand_${selectedMonth}`,
      sheetTitle: 'Bargeldbestand',
      moduleName: 'Bargeldbestand',
      filterSummary: filters,
      columns: [
        { key: 'date',        label: t('common.date'),        width: 14, format: v => new Date(v as string).toLocaleDateString('de-DE') },
        { key: 'type',        label: t('fleet.typeColumn'),    width: 14, format: v => v === 'income' ? t('bargeld.incomeCol') : t('bargeld.expenseCol') },
        { key: 'driver_name', label: t('common.driver'),        width: 22 },
        { key: 'description', label: t('common.description'),  width: 36 },
        { key: 'amount',      label: t('bargeld.amountEuro'),    width: 16, align: 'right', format: v => (v as number).toFixed(2) },
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

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none',
    width: '100%',
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  const balancePositive = totals.balanceCents >= 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('nav.bargeldbestand')}</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <Calendar className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            style={{ ...inputStyle, width: 'auto' }}
          />
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
            style={{ background: 'var(--success)', color: 'white' }}
            title={t('common.exportExcel')}
          >
            <Download className="w-4 h-4" />
            Excel
          </button>
        </div>
      </div>

      {!ledgerInScope && (
        <div
          className="rounded-xl px-4 py-3 text-sm"
          style={{ background: 'var(--warning-subtle)', border: '1px solid rgba(217,119,6,0.25)', color: 'var(--warning)' }}
        >
          {t('bargeld.ledgerUnavailable')}
        </div>
      )}

      <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 ${ledgerInScope ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <div className="rounded-xl p-6" style={{ background: 'var(--success-subtle)', border: '1px solid rgba(5,150,105,0.25)' }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg" style={{ background: 'rgba(5,150,105,0.15)' }}>
              <Wallet className="w-6 h-6" style={{ color: 'var(--success)' }} />
            </div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--success)' }}>{t('bargeld.cashIncome')}</h3>
          </div>
          <p className="text-3xl font-bold" style={{ color: 'var(--success)' }}>
            {euro(totals.bargeldIncomeCents)} €
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--success)', opacity: 0.75 }}>{t('bargeld.totalCash')}</p>
        </div>

        <div className="rounded-xl p-6" style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(220,38,38,0.25)' }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg" style={{ background: 'rgba(220,38,38,0.15)' }}>
              <ReceiptIcon className="w-6 h-6" style={{ color: 'var(--danger)' }} />
            </div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--danger)' }}>{t('bargeld.belegExpenses')}</h3>
          </div>
          <p className="text-3xl font-bold" style={{ color: 'var(--danger)' }}>
            {euro(totals.belegExpenseCents)} €
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--danger)', opacity: 0.75 }}>{t('bargeld.totalBelege')}</p>
        </div>

        {ledgerInScope && (
          <div className="rounded-xl p-6" style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(220,38,38,0.25)' }}>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg" style={{ background: 'rgba(220,38,38,0.15)' }}>
                <Banknote className="w-6 h-6" style={{ color: 'var(--danger)' }} />
              </div>
              <h3 className="text-sm font-medium" style={{ color: 'var(--danger)' }}>{t('bargeld.salaryPayouts')}</h3>
            </div>
            <p className="text-3xl font-bold" style={{ color: 'var(--danger)' }}>
              {euro(totals.salaryPayoutCents)} €
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--danger)', opacity: 0.75 }}>{t('bargeld.salaryPayoutsHint')}</p>
          </div>
        )}

        <div
          className="rounded-xl p-6"
          style={{
            background: balancePositive ? 'var(--accent-subtle)' : 'var(--warning-subtle)',
            border: `1px solid ${balancePositive ? 'rgba(37,99,235,0.25)' : 'rgba(217,119,6,0.25)'}`,
          }}
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg" style={{ background: balancePositive ? 'rgba(37,99,235,0.15)' : 'rgba(217,119,6,0.15)' }}>
              <Wallet className="w-6 h-6" style={{ color: balancePositive ? 'var(--accent-text)' : 'var(--warning)' }} />
            </div>
            <h3 className="text-sm font-medium" style={{ color: balancePositive ? 'var(--accent-text)' : 'var(--warning)' }}>
              {t('bargeld.currentBalance')}
            </h3>
          </div>
          <p className="text-3xl font-bold" style={{ color: balancePositive ? 'var(--accent-text)' : 'var(--warning)' }}>
            {euro(totals.balanceCents)} €
          </p>
          <p className="text-xs mt-2" style={{ color: balancePositive ? 'var(--accent-text)' : 'var(--warning)', opacity: 0.75 }}>
            {ledgerInScope ? t('bargeld.balanceFormula') : t('bargeld.balanceFormulaNoLedger')}
          </p>
        </div>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('bargeld.transactions')}</h2>
            <Filter className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        </div>

        <div className="p-6 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
              <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} style={inputStyle}>
                <option value="all">{t('common.allDrivers')}</option>
                {drivers.map(driver => <option key={driver} value={driver}>{driver}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Typ</label>
              <select value={selectedType} onChange={(e) => setSelectedType(e.target.value)} style={inputStyle}>
                <option value="all">{t('common.all')}</option>
                <option value="income">{t('common.income')}</option>
                <option value="expense">{t('common.expenses')}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('common.dateFrom')}</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('common.dateTo')}</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            </div>
          </div>
          {(selectedDriver !== 'all' || selectedType !== 'all' || startDate || endDate) && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={resetFilters}
                className="text-sm"
                style={{ color: 'var(--accent-text)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              >
                Filter zurücksetzen
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ background: 'var(--bg-subtle)' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.date')}</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Typ</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.driver')}</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.description')}</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('common.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Keine Transaktionen gefunden
                  </td>
                </tr>
              ) : (
                filteredEntries.map((entry) => {
                  const isIncome = entry.direction === 'in';
                  return (
                    <tr
                      key={entry.id}
                      className="border-t"
                      style={{ borderColor: 'var(--border)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                        {format(new Date(entry.date), 'dd.MM.yyyy')}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium"
                          style={{
                            background: isIncome ? 'var(--success-subtle)' : 'var(--danger-subtle)',
                            color: isIncome ? 'var(--success)' : 'var(--danger)',
                          }}
                        >
                          {isIncome ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {isIncome ? t('bargeld.incomeCol') : t('bargeld.expenseCol')}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                        {entry.driverName || '-'}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                        {entry.description}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium">
                        <span style={{ color: isIncome ? 'var(--success)' : 'var(--danger)' }}>
                          {isIncome ? '+' : '-'}
                          {euro(entry.amountCents)} €
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
