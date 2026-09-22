import React, { useState, useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { Driver } from '../types/receipt';
import DriversManagement from '../components/DriversManagement';
import { DriverPlanningFields } from '../components/DriverModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, DataTable, KpiCard, PageHeader } from '../components/ui';

const FahrerPage: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  // The rights of the company the session is in — see BelegePage.
  const { canEdit, canDelete, canCreate } = useCompanyScope();
  const { success, error: showError } = useToast();
  const { drivers: driverActions, isLoading: dbLoading, isConnected: dbConnected } = useDatabase();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);

  const canEditDriver = (driver: Driver): boolean => {
    return canEdit(driver.createdBy);
  };

  const canDeleteDriver = (driver: Driver): boolean => {
    return canDelete(driver.createdBy);
  };

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

  const handleAddDriver = async (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning?: DriverPlanningFields) => {
    if (!canCreate) {
      showError(t('common.noPermission'), t('fahrer.noPermissionAdd'));
      return;
    }

    try {
      await driverActions.add(name, salaryRatio, personalnummer, gender, planning);
      await loadData();
      success(t('fahrer.created'), t('fahrer.createdBody'));
    } catch (err) {
      console.error('Error adding driver:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdateDriver = async (id: string, name: string, salaryRatio: number, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields) => {
    try {
      await driverActions.update(id, name, salaryRatio, status, personalnummer, gender, planning);
      await loadData();
      success(t('fahrer.updated'), t('fahrer.updatedBody'));
    } catch (err) {
      console.error('Error updating driver:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  const handleDeleteDriver = async (id: string) => {
    try {
      await driverActions.delete(id);
      await loadData();
      success(t('fahrer.deleted'), t('fahrer.deletedBody'));
    } catch (err) {
      console.error('Error deleting driver:', err);
      showError(t('common.errorDelete'), handleDatabaseError(err));
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for one line:
  // useDatabase() is also asked for `isConnected`, as on Belege, so a database
  // the hook never reached no longer shows as "Keine Fahrer vorhanden" and three
  // zeros. The page's own heading is gone: DriversManagement carries the one
  // title, as Fahrzeuge and Fixkosten do. Everything below only draws.

  if (loading || dbLoading) {
    return (
      <div className="font-ui">
        <PageHeader title={t('nav.fahrer')} />
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard label={t('fleet.activeDrivers')} value="" loading />
            <KpiCard label={t('fleet.inactiveDrivers')} value="" loading />
            <KpiCard label={t('overview.common.gesamt')} value="" loading />
          </div>
          <DataTable
            caption={t('nav.fahrer')}
            columns={[
              { id: 'name', header: t('fleet.driverName') },
              { id: 'status', header: t('common.status') },
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
        <PageHeader title={t('nav.fahrer')} />
        <Alert
          tone="critical"
          title={t('fahrer.loadFailedTitle')}
          action={
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              <RotateCw aria-hidden />
              {t('belege.reload')}
            </Button>
          }
        >
          {t('fahrer.loadFailedBody')}
        </Alert>
      </div>
    );
  }

  return (
    <DriversManagement
      drivers={drivers}
      onAddDriver={handleAddDriver}
      onEditDriver={handleUpdateDriver}
      onDeleteDriver={handleDeleteDriver}
      canEdit={canEditDriver}
      canDelete={canDeleteDriver}
    />
  );
};

export default FahrerPage;
