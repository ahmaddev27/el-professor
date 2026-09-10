import { useState, useEffect } from 'react';
import { Wallet, Receipt as ReceiptIcon, Filter, TrendingUp, TrendingDown, Calendar, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { exportTableToExcel } from '../utils/excelExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

interface Transaction {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  description: string;
  driver_name?: string;
  date: string;
}

export default function BargeldbestandPage() {
  const { t } = useTranslation();
  const [totalCashIncome, setTotalCashIncome] = useState(0);
  const [totalBelegeExpenses, setTotalBelegeExpenses] = useState(0);
  const [cashBalance, setCashBalance] = useState(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [drivers, setDrivers] = useState<string[]>([]);
  const { user, loading: authLoading } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { showToast } = useToast();

  useEffect(() => {
    if (!authLoading) {
      loadCashData();
    }
  }, [user, authLoading, selectedMonth]);

  useEffect(() => {
    applyFilters();
  }, [transactions, selectedDriver, selectedType, startDate, endDate]);

  async function loadCashData() {
    if (!user?.email) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      const monthStart = format(startOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');
      const monthEnd = format(endOfMonth(new Date(selectedMonth)), 'yyyy-MM-dd');

      const { data: incomeData, error: incomeError } = await supabase
        .from('income')
        .select('id, amount, type, description, driver_name, date')
        .eq('company_id', companyId)
        .eq('type', 'bargeld')
        .gte('date', monthStart)
        .lte('date', monthEnd)
        .order('date', { ascending: false });

      if (incomeError) throw incomeError;

      const cashIncome = incomeData?.reduce((sum, item) => sum + Number(item.amount), 0) || 0;
      setTotalCashIncome(cashIncome);

      const { data: receiptsData, error: receiptsError } = await supabase
        .from('receipts')
        .select('id, expense, description, driver_name, date')
        .eq('company_id', companyId)
        .gte('date', monthStart)
        .lte('date', monthEnd)
        .order('date', { ascending: false });

      if (receiptsError) throw receiptsError;

      const belegeExpenses = receiptsData?.reduce((sum, r) => sum + Number(r.expense), 0) || 0;
      setTotalBelegeExpenses(belegeExpenses);
      setCashBalance(cashIncome - belegeExpenses);

      const incomeTransactions: Transaction[] = incomeData?.map(item => ({
        id: item.id,
        type: 'income' as const,
        amount: Number(item.amount),
        description: item.description || t('bargeld.incomeEntry'),
        driver_name: item.driver_name,
        date: item.date,
      })) || [];

      const expenseTransactions: Transaction[] = receiptsData?.map(item => ({
        id: item.id,
        type: 'expense' as const,
        amount: Number(item.expense),
        description: item.description || 'Beleg',
        driver_name: item.driver_name,
        date: item.date,
      })) || [];

      const allTransactions = [...incomeTransactions, ...expenseTransactions]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      setTransactions(allTransactions);

      const uniqueDrivers = Array.from(
        new Set(allTransactions.map(t => t.driver_name).filter(Boolean))
      ) as string[];
      setDrivers(uniqueDrivers.sort());

    } catch (error: any) {
      console.error('Error loading cash data:', error);
      showToast('error', t('bargeld.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  function applyFilters() {
    let filtered = [...transactions];
    if (selectedDriver !== 'all') filtered = filtered.filter(t => t.driver_name === selectedDriver);
    if (selectedType !== 'all') filtered = filtered.filter(t => t.type === selectedType);
    if (startDate) filtered = filtered.filter(t => t.date >= startDate);
    if (endDate) filtered = filtered.filter(t => t.date <= endDate);
    setFilteredTransactions(filtered);
  }

  function resetFilters() {
    setSelectedDriver('all');
    setSelectedType('all');
    setStartDate('');
    setEndDate('');
  }

  function handleExport() {
    const filters: string[] = [`Monat: ${selectedMonth}`];
    if (selectedDriver !== 'all') filters.push(`Fahrer: ${selectedDriver}`);
    if (selectedType !== 'all') filters.push(`Typ: ${selectedType === 'income' ? t('common.income') : t('common.expenses')}`);
    if (startDate) filters.push(`Von: ${new Date(startDate).toLocaleDateString('de-DE')}`);
    if (endDate) filters.push(`Bis: ${new Date(endDate).toLocaleDateString('de-DE')}`);

    const totalIncome = filteredTransactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const totalExpense = filteredTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

    exportTableToExcel({
      filename: `bargeldbestand_${selectedMonth}`,
      sheetTitle: 'Bargeldbestand',
      moduleName: 'Bargeldbestand',
      filterSummary: filters,
      columns: [
        { key: 'date',        label: t('common.date'),        width: 14, format: v => new Date(v as string).toLocaleDateString('de-DE') },
        { key: 'type',        label: 'Typ',          width: 14, format: v => v === 'income' ? t('bargeld.incomeCol') : t('bargeld.expenseCol') },
        { key: 'driver_name', label: t('common.driver'),        width: 22 },
        { key: 'description', label: t('common.description'),  width: 36 },
        { key: 'amount',      label: t('bargeld.amountEuro'),    width: 16, align: 'right', format: v => (v as number).toFixed(2) },
      ],
      rows: filteredTransactions as unknown as Record<string, unknown>[],
      totals: {
        amount: `+${totalIncome.toFixed(2)} / -${totalExpense.toFixed(2)}`,
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="rounded-xl p-6" style={{ background: 'var(--success-subtle)', border: '1px solid rgba(5,150,105,0.25)' }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg" style={{ background: 'rgba(5,150,105,0.15)' }}>
              <Wallet className="w-6 h-6" style={{ color: 'var(--success)' }} />
            </div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--success)' }}>{t('bargeld.cashIncome')}</h3>
          </div>
          <p className="text-3xl font-bold" style={{ color: 'var(--success)' }}>
            {totalCashIncome.toFixed(2)} €
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
            {totalBelegeExpenses.toFixed(2)} €
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--danger)', opacity: 0.75 }}>{t('bargeld.totalBelege')}</p>
        </div>

        <div
          className="rounded-xl p-6"
          style={{
            background: cashBalance >= 0 ? 'var(--accent-subtle)' : 'var(--warning-subtle)',
            border: `1px solid ${cashBalance >= 0 ? 'rgba(37,99,235,0.25)' : 'rgba(217,119,6,0.25)'}`,
          }}
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg" style={{ background: cashBalance >= 0 ? 'rgba(37,99,235,0.15)' : 'rgba(217,119,6,0.15)' }}>
              <Wallet className="w-6 h-6" style={{ color: cashBalance >= 0 ? 'var(--accent-text)' : 'var(--warning)' }} />
            </div>
            <h3 className="text-sm font-medium" style={{ color: cashBalance >= 0 ? 'var(--accent-text)' : 'var(--warning)' }}>
              Aktueller Bestand
            </h3>
          </div>
          <p className="text-3xl font-bold" style={{ color: cashBalance >= 0 ? 'var(--accent-text)' : 'var(--warning)' }}>
            {cashBalance.toFixed(2)} €
          </p>
          <p className="text-xs mt-2" style={{ color: cashBalance >= 0 ? 'var(--accent-text)' : 'var(--warning)', opacity: 0.75 }}>
            Bargeld - Belege
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
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Keine Transaktionen gefunden
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((transaction) => (
                  <tr
                    key={transaction.id}
                    className="border-t"
                    style={{ borderColor: 'var(--border)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: 'var(--text-primary)' }}>
                      {format(new Date(transaction.date), 'dd.MM.yyyy')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium"
                        style={{
                          background: transaction.type === 'income' ? 'var(--success-subtle)' : 'var(--danger-subtle)',
                          color: transaction.type === 'income' ? 'var(--success)' : 'var(--danger)',
                        }}
                      >
                        {transaction.type === 'income' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {transaction.type === 'income' ? t('bargeld.incomeCol') : t('bargeld.expenseCol')}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                      {transaction.driver_name || '-'}
                    </td>
                    <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                      {transaction.description}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium">
                      <span style={{ color: transaction.type === 'income' ? 'var(--success)' : 'var(--danger)' }}>
                        {transaction.type === 'income' ? '+' : '-'}
                        {transaction.amount.toFixed(2)} €
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
