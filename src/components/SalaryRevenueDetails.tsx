import React from 'react';
import { Receipt } from 'lucide-react';
import type { Income } from '../types/receipt';
import { useTranslation } from '../contexts/LanguageContext';
import { Badge, cn, DataTable, EmptyState, formatEuro, type DataTableColumn } from './ui';
import { formatStoredDate } from '../utils/salaryRowEdit';

interface SalaryRevenueDetailsProps {
  /** The driver's Umsatz, Aktionen and Trinkgeld rows of the period. */
  transactions: Income[];
  periodStart: string;
  periodEnd: string;
}

// formatEuro refuses a value that is not a finite amount; show it as it is.
const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

const sumOf = (transactions: Income[], type: string) =>
  transactions.filter(tx => tx.type === type).reduce((sum, tx) => sum + Number(tx.amount), 0);

/**
 * The transactions behind a driver's salary for the period. It was a dialog of
 * its own behind an eye button on the salary row; the row has no buttons now,
 * so it lives in the salary's own dialog. Figures are the old dialog's, summed
 * the same way.
 */
const SalaryRevenueDetails: React.FC<SalaryRevenueDetailsProps> = ({ transactions, periodStart, periodEnd }) => {
  const { t } = useTranslation();
  const umsatzTotal = sumOf(transactions, 'umsatz');
  const aktionenTotal = sumOf(transactions, 'aktionen');
  const trinkgeldTotal = sumOf(transactions, 'trinkgeld');
  const bargeldTotal = sumOf(transactions, 'bargeld');
  const totalIncome = umsatzTotal + aktionenTotal + trinkgeldTotal + bargeldTotal;

  // `type` is the stored income type; only the returned label is translated.
  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'umsatz': return t('sal.type.umsatz');
      case 'aktionen': return t('sal.type.aktionen');
      case 'trinkgeld': return t('sal.type.trinkgeld');
      case 'bargeld': return t('sal.type.bargeld');
      default: return type;
    }
  };

  // Umsatz and Trinkgeld green, Aktionen amber, Bargeld red.
  const typeTone = (type: string) =>
    type === 'umsatz' || type === 'trinkgeld' ? 'positive' : type === 'aktionen' ? 'caution' : type === 'bargeld' ? 'critical' : 'neutral';

  const columns: DataTableColumn<Income>[] = [
    { id: 'date', header: t('common.date'), kind: 'date', value: tx => tx.date, sortable: true },
    { id: 'type', header: t('sal.col.type'), cell: tx => <Badge tone={typeTone(tx.type)}>{getTypeLabel(tx.type)}</Badge> },
    { id: 'description', header: t('common.description'), value: tx => tx.description, hideBelow: 'sm' },
    {
      id: 'amount',
      header: t('common.amount'),
      kind: 'currency',
      value: tx => Number(tx.amount),
      sortable: true,
      cell: tx => (
        <span className={cn('font-semibold', tx.type === 'bargeld' ? 'text-critical' : 'text-positive')}>{euro(Number(tx.amount))}</span>
      ),
    },
  ];

  const tile = (label: string, amount: number, className?: string) => (
    <div className={cn('rounded-control border border-line bg-raised p-3', className)}>
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-fg">{euro(amount)}</p>
    </div>
  );

  return (
    <section className="font-ui grid grid-cols-1 gap-3 text-fg">
      <h3 className="text-base font-semibold">{t('sal.transactions.caption')}</h3>
      <p className="text-sm text-fg-muted">{formatStoredDate(periodStart)} – {formatStoredDate(periodEnd)}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tile(t('sal.type.umsatz'), umsatzTotal)}
        {aktionenTotal > 0 && tile(t('sal.type.aktionen'), aktionenTotal)}
        {tile(t('sal.type.trinkgeld'), trinkgeldTotal)}
        {tile(t('sal.total'), totalIncome, 'border-brand/40 bg-brand-soft')}
      </div>
      <DataTable
        caption={t('sal.transactions.caption')}
        columns={columns}
        rows={transactions}
        getRowId={tx => tx.id}
        density="compact"
        scrollClassName="max-h-[50vh]"
        emptyState={<EmptyState size="sm" icon={Receipt} title={t('sal.noTransactions')} />}
      />
    </section>
  );
};

export default SalaryRevenueDetails;
