import React, { useState, useEffect } from 'react';
import { useDatabase } from '../hooks/useDatabase';
import { Driver } from '../types/receipt';
import IncomeManagement from '../components/IncomeManagement';
import { useTranslation } from '../contexts/LanguageContext';

const UmsaetzePage: React.FC = () => {
  const { t } = useTranslation();
  const { drivers: driverActions, isLoading: dbLoading } = useDatabase();
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
      const driversData = await driverActions.get();
      setDrivers(driversData);
    } catch (error) {
      console.error('Error loading drivers:', error);
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
      <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('umsaetze.title')}</h2>
      <IncomeManagement drivers={drivers} />
    </div>
  );
};

export default UmsaetzePage;
