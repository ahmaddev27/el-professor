import React, { useCallback, useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { pageWriteRights } from '../lib/pageWriteRights';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { Driver, DriverContact } from '../types/receipt';
import DriversManagement from '../components/DriversManagement';
import { DriverPlanningFields } from '../components/DriverModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, DataTable, KpiCard, PageHeader } from '../components/ui';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { PendingLinksNotice } from '../components/partner/PendingLinksNotice';
import { FleetImportShortcut } from '../components/partner/FleetImportShortcut';
import { FleetUpdateButton, FleetUpdateOutcome } from '../components/partner/FleetUpdate';
import { useFleetUpdate } from '../components/partner/useFleetUpdate';
import { supabase } from '../lib/supabase';
import { fetchLinkRows, summariseLinks, type LinkSummary } from '../lib/partnerDriverLinks';

const FahrerPage: React.FC = () => {
  const { t } = useTranslation();
  // The rights of the company the session is in — see BelegePage.
  const scope = useCompanyScope();
  // The page the database asks (drivers), so the browser asks the same question.
  // Deleting a driver is not a page right: since 27.11.2026 it is the
  // administrator's alone and only when nothing refers to the driver, and
  // DriversManagement asks that (`mayDeleteDriver`), not this page.
  const { canEdit, canCreate } = pageWriteRights('drivers', scope);
  const { success, error: showError } = useToast();
  const { drivers: driverActions, isLoading: dbLoading, isConnected: dbConnected } = useDatabase();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  // The company whose rows a screen must query, not the membership — the rule
  // every tenant query in this codebase follows. `useDatabase` already resolves
  // it internally; the Reidey links are read directly, so this needs the value.
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  // The Reidey links, read once per load: they decide the badge on each row and
  // the notice about proposals waiting for a decision. A failed read is empty,
  // not an error: the list itself is what the page is for.
  const [links, setLinks] = useState<LinkSummary>({ byDriver: new Map(), pending: 0 });

  const canEditDriver = (driver: Driver): boolean => {
    return canEdit(driver.createdBy);
  };

  useEffect(() => {
    if (!dbLoading) {
      loadData();
    }
  }, [dbLoading]);

  const loadLinks = useCallback(async () => {
    if (!companyId) return;
    try {
      setLinks(summariseLinks(await fetchLinkRows(supabase, companyId)));
    } catch (error) {
      console.error('Error loading partner links:', error);
    }
  }, [companyId]);

  useEffect(() => { void loadLinks(); }, [loadLinks]);

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

  const handleAddDriver = async (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact) => {
    if (!canCreate) {
      showError(t('common.noPermission'), t('fahrer.noPermissionAdd'));
      return;
    }

    try {
      await driverActions.add(name, salaryRatio, personalnummer, gender, planning, contact);
      await loadData();
      success(t('fahrer.created'), t('fahrer.createdBody'));
    } catch (err) {
      console.error('Error adding driver:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdateDriver = async (id: string, name: string, salaryRatio: number, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact) => {
    try {
      await driverActions.update(id, name, salaryRatio, status, personalnummer, gender, planning, contact);
      await loadData();
      success(t('fahrer.updated'), t('fahrer.updatedBody'));
    } catch (err) {
      console.error('Error updating driver:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  // The update button pulls Reidey's roster and imports it; afterwards the list
  // and the links are read again, because the import may have added drivers.
  const reloadAll = () => { void loadData(); void loadLinks(); };
  const update = useFleetUpdate('drivers', reloadAll);

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

  const empty = drivers.length === 0;

  return (
    <>
      {empty ? <FleetImportShortcut /> : null}
      <DriversManagement
        drivers={drivers}
        onAddDriver={handleAddDriver}
        onEditDriver={handleUpdateDriver}
        canEdit={canEditDriver}
        partnerLinks={links.byDriver}
        onDriverDeleted={reloadAll}
        headerActions={empty ? null : <FleetUpdateButton update={update} />}
        headerNotice={(
          <>
            <FleetUpdateOutcome update={update} />
            <PendingLinksNotice
              count={links.pending}
              companyId={companyId}
              drivers={drivers}
              onDecided={reloadAll}
            />
          </>
        )}
      />
    </>
  );
};

export default FahrerPage;
