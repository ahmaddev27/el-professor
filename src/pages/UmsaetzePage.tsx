import React, { useState, useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import { useDatabase } from '../hooks/useDatabase';
import { Driver } from '../types/receipt';
import IncomeManagement from '../components/IncomeManagement';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, DataTable, KpiCard, PageHeader } from '../components/ui';

const UmsaetzePage: React.FC = () => {
  const { t } = useTranslation();
  const { drivers: driverActions, isLoading: dbLoading, isConnected: dbConnected } = useDatabase();
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for one line:
  // useDatabase() is also asked for `isConnected`, as on Belege and Fahrer, so a
  // database the hook never reached no longer shows as no entries and 0,00 €.
  // The page's own heading is gone: IncomeManagement carries the one title.
  // Everything below only draws.

  if (loading || dbLoading) {
    return (
      <div className="font-ui">
        <PageHeader title={t('nav.umsaetze')} />
        <div className="grid grid-cols-1 gap-4">
          <KpiCard label={t('inc.totalFiltered')} value="" loading className="sm:max-w-sm" />
          <DataTable
            caption={t('inc.tableCaption')}
            columns={[
              { id: 'driver', header: t('common.driver') },
              { id: 'amount', header: t('common.amount'), kind: 'currency' },
            ]}
            rows={[]}
            getRowId={() => ''}
            loading
          />
        </div>
      </div>
    );
  }

  if (!dbConnected) {
    return (
      <div className="font-ui">
        <PageHeader title={t('nav.umsaetze')} />
        <Alert
          tone="critical"
          title={t('umsaetze.loadFailedTitle')}
          action={
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              <RotateCw aria-hidden />
              {t('belege.reload')}
            </Button>
          }
        >
          {t('umsaetze.loadFailedBody')}
        </Alert>
      </div>
    );
  }

  return <IncomeManagement drivers={drivers} />;
};

export default UmsaetzePage;
