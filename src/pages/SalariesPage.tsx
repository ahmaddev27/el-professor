import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import SalariesManagement from '../components/SalariesManagement';
import { Button, Card, EmptyState, PageHeader } from '../components/ui';
import { Driver } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { handleDatabaseError } from '../utils/errorHandler';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

const SalariesPage: React.FC = () => {
  const { t } = useTranslation();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();

  useEffect(() => {
    if (companyId) loadDrivers();
  }, [companyId]);

  const loadDrivers = async () => {
    try {
      setLoading(true);
      setLoadError(false);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 10000)
      );

      const dataPromise = supabase
        .from('drivers')
        .select('*')
        .eq('company_id', companyId)
        .order('name', { ascending: true });

      const { data, error } = await Promise.race([dataPromise, timeoutPromise]) as any;

      if (error) throw error;
      setDrivers(data || []);
    } catch (err: any) {
      console.error('Error loading drivers:', err);
      setLoadError(true);
      showError(t('common.errorLoad'), handleDatabaseError(err));
      setDrivers([]);
    } finally {
      setLoading(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the page's logic and is unchanged; everything below
  // only draws it. While the drivers load, and when they fail to, the page
  // renders nothing of SalariesManagement — as before, an empty driver list
  // after a failure is never handed on as if it were the company's.

  if (loading) {
    return (
      <div className="font-ui">
        <PageHeader title={t('sal.title')} description={t('sal.subtitle')} />
        <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-fg-muted">
          <Loader2 aria-hidden className="size-5 motion-safe:animate-spin" />
          {t('salaries.loadingDrivers')}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="font-ui">
        <PageHeader title={t('sal.title')} description={t('sal.subtitle')} />
        <Card>
          <EmptyState
            icon={AlertTriangle}
            title={t('salaries.loadFailed')}
            description={t('salaries.noConnection')}
            action={
              <Button variant="secondary" onClick={loadDrivers}>
                <RotateCw aria-hidden />
                {t('ui.table.retry')}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return <SalariesManagement drivers={drivers} />;
};

export default SalariesPage;
