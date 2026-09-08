import React, { useState, useEffect } from 'react';
import { useDatabase } from '../hooks/useDatabase';
import { Receipt, Driver } from '../types/receipt';
import ReceiptStatistics from '../components/ReceiptStatistics';

const StatistikenPage: React.FC = () => {
  const { receipts: receiptActions, drivers: driverActions, isLoading: dbLoading } = useDatabase();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dbLoading) {
      loadData();
    }
  }, [dbLoading]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [receiptsData, driversData] = await Promise.all([
        receiptActions.get(),
        driverActions.get()
      ]);
      setReceipts(receiptsData);
      setDrivers(driversData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || dbLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Statistiken</h2>
      <ReceiptStatistics receipts={receipts} drivers={drivers} />
    </div>
  );
};

export default StatistikenPage;
