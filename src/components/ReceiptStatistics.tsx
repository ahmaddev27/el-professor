import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Receipt, Users, Calendar, BarChart3, PieChart } from 'lucide-react';
import { Receipt as ReceiptType, Driver, Income } from '../types/receipt';
import { format, startOfMonth, endOfMonth, isWithinInterval, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface ReceiptStatisticsProps {
  receipts: ReceiptType[];
  drivers: Driver[];
}

interface FixedCost {
  id: string;
  description: string;
  amount: number;
}

const ReceiptStatistics: React.FC<ReceiptStatisticsProps> = ({ receipts, drivers }) => {
  const [selectedMonth, setSelectedMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const { companyId } = useAuth();

  useEffect(() => {
    if (companyId) {
      loadFixedCosts();
      loadIncomes();
    }
  }, [companyId]);

  const loadFixedCosts = async () => {
    try {
      const { data, error } = await supabase
        .from('fixed_costs')
        .select('id, description, amount')
        .eq('company_id', companyId);

      if (error) throw error;
      setFixedCosts(data || []);
    } catch (error) {
      console.error('Error loading fixed costs:', error);
    }
  };

  const loadIncomes = async () => {
    try {
      const { data, error } = await supabase
        .from('income')
        .select('*')
        .eq('company_id', companyId);

      if (error) throw error;
      setIncomes(data || []);
    } catch (error) {
      console.error('Error loading incomes:', error);
    }
  };

  const getMonthRange = (monthString: string) => {
    const date = parseISO(monthString + '-01');
    return {
      start: startOfMonth(date),
      end: endOfMonth(date)
    };
  };

  const { start: monthStart, end: monthEnd } = getMonthRange(selectedMonth);

  const filteredReceipts = receipts.filter(receipt =>
    isWithinInterval(new Date(receipt.date), { start: monthStart, end: monthEnd })
  );

  const filteredIncomes = incomes.filter(income =>
    isWithinInterval(new Date(income.date), { start: monthStart, end: monthEnd })
  );

  // Calculate fixed costs total
  const totalFixedCostsAmount = fixedCosts.reduce((sum, cost) => sum + Number(cost.amount), 0);

  // Calculate statistics for selected month
  const totalReceipts = filteredReceipts.length;

  // Income calculations: Only Bargeld (cash) counts toward company income
  const totalBargeld = filteredIncomes
    .filter(income => income.type === 'bargeld')
    .reduce((sum, income) => sum + Number(income.amount), 0);

  const totalTrinkgeld = filteredIncomes
    .filter(income => income.type === 'trinkgeld')
    .reduce((sum, income) => sum + Number(income.amount), 0);

  // Company income = Bargeld + Trinkgeld
  const totalIncome = totalBargeld + totalTrinkgeld;

  const totalExpenses = filteredReceipts.reduce((sum, receipt) => sum + receipt.expense, 0);
  const netBalance = totalIncome - totalExpenses - totalFixedCostsAmount;
  const currentBalance = filteredReceipts.length > 0 ? filteredReceipts[filteredReceipts.length - 1].balance : 0;

  const monthlyIncome = totalIncome;
  const monthlyExpenses = totalExpenses + totalFixedCostsAmount;
  const monthlyNet = netBalance;

  // Calculate driver statistics for selected month
  const driverStats = drivers.map(driver => {
    const driverReceipts = filteredReceipts.filter(receipt => receipt.driverName === driver.name);
    const driverIncomes = filteredIncomes.filter(income => income.driver_name === driver.name);

    // Online revenue = Umsatz + Aktionen
    const driverUmsatz = driverIncomes
      .filter(income => income.type === 'umsatz' || income.type === 'aktionen')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    // Company income from this driver (Bargeld + Trinkgeld)
    const driverBargeld = driverIncomes
      .filter(income => income.type === 'bargeld')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    const driverTrinkgeld = driverIncomes
      .filter(income => income.type === 'trinkgeld')
      .reduce((sum, income) => sum + Number(income.amount), 0);

    const driverCompanyIncome = driverBargeld + driverTrinkgeld;
    const driverExpenses = driverReceipts.reduce((sum, receipt) => sum + receipt.expense, 0);
    const driverNet = driverCompanyIncome - driverExpenses;

    return {
      name: driver.name,
      receipts: driverReceipts.length,
      umsatz: driverUmsatz,
      companyIncome: driverCompanyIncome,
      expenses: driverExpenses,
      net: driverNet,
      percentage: totalReceipts > 0 ? (driverReceipts.length / totalReceipts) * 100 : 0
    };
  }).sort((a, b) => b.net - a.net);

  // Calculate transaction type statistics for selected month
  const incomeTransactions = filteredIncomes.length;
  const expenseTransactions = filteredReceipts.filter(receipt => receipt.expense > 0).length;
  const avgTransactionValue = (incomeTransactions + expenseTransactions) > 0 ? (totalIncome + totalExpenses) / (incomeTransactions + expenseTransactions) : 0;

  // Get recent activity (within selected month)
  const recentReceipts = filteredReceipts;

  const StatCard: React.FC<{
    title: string;
    value: string;
    subtitle?: string;
    icon: React.ReactNode;
    trend?: 'up' | 'down' | 'neutral';
    borderColor: string;
    iconBg: string;
  }> = ({ title, value, subtitle, icon, trend, borderColor, iconBg }) => (
    <div style={{ background: 'var(--bg-surface)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', padding: '1.5rem', borderLeft: `4px solid ${borderColor}` }}>
      <div className="flex items-center justify-between">
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 500 }}>{title}</p>
          <p style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>{value}</p>
          {subtitle && (
            <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{subtitle}</p>
          )}
        </div>
        <div style={{ background: iconBg, borderRadius: '9999px', padding: '0.75rem' }}>
          {icon}
        </div>
      </div>
      {trend && (
        <div className="mt-4 flex items-center">
          {trend === 'up' && <TrendingUp style={{ color: 'var(--success)' }} size={16} />}
          {trend === 'down' && <TrendingDown style={{ color: 'var(--danger)' }} size={16} />}
          {trend === 'neutral' && <BarChart3 style={{ color: 'var(--text-tertiary)' }} size={16} />}
          <span style={{ marginLeft: '0.25rem', fontSize: '0.875rem', color: trend === 'up' ? 'var(--success)' : trend === 'down' ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {trend === 'up' ? 'Positiv' : trend === 'down' ? 'Negativ' : 'Stabil'}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div style={{ background: 'var(--accent)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-lg)', padding: '1.5rem', color: 'var(--accent-text)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div style={{ background: 'rgba(255,255,255,0.2)', borderRadius: '0.5rem', padding: '0.5rem' }}>
              <BarChart3 size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Statistiken</h1>
              <p style={{ opacity: 0.85, marginTop: '0.25rem' }}>Übersicht über Ihre Finanzdaten</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Calendar size={20} />
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none', fontWeight: 500, boxShadow: 'var(--shadow-md)', outline: 'none' }}
            />
          </div>
        </div>
      </div>

      {/* Main Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Firmeneinnahmen"
          value={`${totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
          subtitle="Bargeld + Trinkgeld"
          icon={<TrendingUp style={{ color: 'var(--success)' }} size={24} />}
          trend="up"
          borderColor="var(--success)"
          iconBg="var(--success-subtle)"
        />
        <StatCard
          title="Gesamtausgaben"
          value={`${totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
          subtitle={`${expenseTransactions} Transaktionen`}
          icon={<TrendingDown style={{ color: 'var(--danger)' }} size={24} />}
          trend="down"
          borderColor="var(--danger)"
          iconBg="var(--danger-subtle)"
        />
        <StatCard
          title="Nettobilanz"
          value={`${netBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
          subtitle={netBalance >= 0 ? 'Gewinn' : 'Verlust'}
          icon={<DollarSign style={{ color: 'var(--accent)' }} size={24} />}
          trend={netBalance >= 0 ? 'up' : 'down'}
          borderColor="var(--accent)"
          iconBg="var(--accent-subtle)"
        />
        <StatCard
          title="Aktueller Bestand"
          value={`${currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
          subtitle="Letzter Beleg"
          icon={<Receipt style={{ color: 'var(--text-secondary)' }} size={24} />}
          trend={currentBalance >= 0 ? 'up' : 'down'}
          borderColor="var(--border)"
          iconBg="var(--bg-subtle)"
        />
      </div>

      {/* Monthly Statistics */}
      <div style={{ background: 'var(--bg-surface)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', padding: '1.5rem' }}>
        <h2 style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Calendar style={{ color: 'var(--accent)' }} size={20} />
          <span>Ausgewählter Monat ({format(parseISO(selectedMonth + '-01'), 'MMMM yyyy', { locale: de })})</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="text-center">
            <div style={{ background: 'var(--success-subtle)', borderRadius: '9999px', padding: '1rem', width: '4rem', height: '4rem', margin: '0 auto 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TrendingUp style={{ color: 'var(--success)' }} size={24} />
            </div>
            <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--success)' }}>{monthlyIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Firmeneinnahmen</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>(Bargeld + Trinkgeld)</p>
          </div>
          <div className="text-center">
            <div style={{ background: 'var(--danger-subtle)', borderRadius: '9999px', padding: '1rem', width: '4rem', height: '4rem', margin: '0 auto 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TrendingDown style={{ color: 'var(--danger)' }} size={24} />
            </div>
            <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--danger)' }}>{monthlyExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Ausgaben (inkl. Fixkosten)</p>
          </div>
          <div className="text-center">
            <div style={{ background: monthlyNet >= 0 ? 'var(--accent-subtle)' : 'var(--warning-subtle)', borderRadius: '9999px', padding: '1rem', width: '4rem', height: '4rem', margin: '0 auto 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <DollarSign style={{ color: monthlyNet >= 0 ? 'var(--accent)' : 'var(--warning)' }} size={24} />
            </div>
            <p style={{ fontSize: '1.5rem', fontWeight: 700, color: monthlyNet >= 0 ? 'var(--accent)' : 'var(--warning)' }}>
              {monthlyNet.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Netto</p>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: '1.5rem', paddingTop: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.75rem' }}>Einnahmen-Aufschlüsselung</h3>
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span style={{ color: 'var(--text-secondary)' }}>Bargeld (Firmeneinnahme)</span>
              <span style={{ fontWeight: 600, color: 'var(--success)' }}>{totalBargeld.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span style={{ color: 'var(--text-secondary)' }}>Trinkgeld</span>
              <span style={{ fontWeight: 600, color: 'var(--success)' }}>{totalTrinkgeld.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }} className="flex justify-between items-center text-sm">
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Gesamt Firmeneinnahmen</span>
              <span style={{ fontWeight: 700, color: 'var(--success)' }}>{totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
            </div>
          </div>
        </div>

        {fixedCosts.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '1.5rem', paddingTop: '1.5rem' }}>
            <h3 style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.75rem' }}>Fixkosten-Aufschlüsselung</h3>
            <div className="space-y-2">
              {fixedCosts.map((cost) => (
                <div key={cost.id} className="flex justify-between items-center text-sm">
                  <span style={{ color: 'var(--text-secondary)' }}>{cost.description}</span>
                  <span style={{ fontWeight: 600, color: 'var(--danger)' }}>{Number(cost.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }} className="flex justify-between items-center text-sm">
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Gesamt Fixkosten</span>
                <span style={{ fontWeight: 700, color: 'var(--danger)' }}>{totalFixedCostsAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Driver Performance */}
      <div style={{ background: 'var(--bg-surface)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', padding: '1.5rem' }}>
        <h2 style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Users style={{ color: 'var(--accent)' }} size={20} />
          <span>Fahrer-Performance</span>
        </h2>
        {driverStats.length > 0 ? (
          <div className="space-y-4">
            {driverStats.map((driver, index) => (
              <div key={driver.name} style={{ background: 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="flex items-center space-x-3">
                  <div style={{ background: 'var(--accent)', borderRadius: '9999px', padding: '0.5rem' }}>
                    <Users style={{ color: 'var(--accent-text)' }} size={16} />
                  </div>
                  <div>
                    <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{driver.name}</p>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{driver.receipts} Belege ({driver.percentage.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)</p>
                  </div>
                </div>
                <div className="text-right">
                  <p style={{ fontWeight: 600, color: driver.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {driver.net.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Umsatz: {driver.umsatz.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Firma: {driver.companyIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € - Ausgaben: {driver.expenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>Keine Fahrer-Daten verfügbar</p>
        )}
      </div>

      {/* Additional Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div style={{ background: 'var(--bg-surface)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', padding: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-primary)', fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <PieChart style={{ color: 'var(--accent)' }} size={18} />
            <span>Transaktions-Übersicht</span>
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Gesamt Belege:</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{totalReceipts}</span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Einnahme-Transaktionen:</span>
              <span style={{ fontWeight: 600, color: 'var(--success)' }}>{incomeTransactions}</span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Ausgaben-Transaktionen:</span>
              <span style={{ fontWeight: 600, color: 'var(--danger)' }}>{expenseTransactions}</span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Ø Transaktionswert:</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{avgTransactionValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--bg-surface)', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', padding: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-primary)', fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar style={{ color: 'var(--accent)' }} size={18} />
            <span>Monatsaktivität</span>
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Belege im Monat:</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{recentReceipts.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Aktivität:</span>
              <span style={{ fontWeight: 600, color: recentReceipts.length > 0 ? 'var(--success)' : 'var(--text-tertiary)' }}>
                {recentReceipts.length > 0 ? 'Aktiv' : 'Inaktiv'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>Aktive Fahrer:</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{drivers.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-secondary)' }}>System Status:</span>
              <span style={{ fontWeight: 600, color: 'var(--success)' }}>Online</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReceiptStatistics;
