import React, { useEffect, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import FahrtenbuchTripsView from '../components/FahrtenbuchTripsView';
import type { DriverOption, CarOption } from '../components/FahrtenbuchImportModal';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { tripAnalysisLinkShown } from '../components/navVisibility';
import { ACTIVE_DRIVER_STATUS } from '../utils/driverStatus';
import { Button, PageHeader } from '../components/ui';

// The Fahrtenbuch used to be a sub-view of DocumentsPage; it has its own route
// now. The two lookups below moved with it unchanged.
const FahrtenbuchPage: React.FC = () => {
  const navigate = useNavigate();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { t } = useTranslation();

  // Drivers and cars for Fahrtenbuch matching
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [cars, setCars] = useState<CarOption[]>([]);

  useEffect(() => {
    if (!companyId) return;
    supabase
      .from('drivers')
      .select('id, name')
      .eq('company_id', companyId)
      // A chooser: who a trip is reassigned to.
      .eq('status', ACTIVE_DRIVER_STATUS)
      .order('name')
      .then(({ data }) => setDrivers((data || []) as DriverOption[]));

    supabase
      .from('cars')
      .select('id, kennzeichen')
      .eq('company_id', companyId)
      .order('kennzeichen')
      .then(({ data }) => setCars(
        (data || []).map((c: { id: string; kennzeichen: string }) => ({
          id: c.id,
          plate: c.kennzeichen,
        }))
      ));
  }, [companyId]);

  return (
    <div>
      {/* No font-ui here: the trips view below is still the legacy screen. */}
      <PageHeader
        title={t('doc.fahrtenbuch')}
        description={t('doc.fahrtenbuchSubtitle')}
        actions={
          // Offered only where the Fahrtenanalyse is meant to be seen. The route
          // stays registered everywhere, so the screen is reachable by address.
          tripAnalysisLinkShown(import.meta.env.VITE_DEPLOY_ENV, import.meta.env.DEV) ? (
            <Button variant="secondary" onClick={() => navigate('/fahrtenanalyse')}>
              <FileSearch aria-hidden />
              {t('ta.link.open')}
            </Button>
          ) : undefined
        }
      />
      <FahrtenbuchTripsView drivers={drivers} cars={cars} />
    </div>
  );
};

export default FahrtenbuchPage;
