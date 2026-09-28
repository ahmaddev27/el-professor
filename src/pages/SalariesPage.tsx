import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import SalariesManagement from '../components/SalariesManagement';
import GehaltsquittungList from '../components/GehaltsquittungList';
import GehaltsquittungModal from '../components/GehaltsquittungModal';
import { Button, Card, EmptyState, PageHeader } from '../components/ui';
import { Driver } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { handleDatabaseError } from '../utils/errorHandler';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

const SalariesPage: React.FC = () => {
  const { t } = useTranslation();

  const location = useLocation();
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [receiptsVersion, setReceiptsVersion] = useState(0);
  const focusReceiptState = (location.state as { focusReceiptId?: unknown } | null)?.focusReceiptId;
  const focusReceiptId = typeof focusReceiptState === 'string' ? focusReceiptState : null;
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

  return (
    <div className="grid gap-6">
      <SalariesManagement drivers={drivers} />

      {/* The Gehaltsquittung lives here since 28.09.2026, at the owner's request:
          it left the Dokumente screen entirely, so issuing one and finding one
          again both happen where a salary is paid.

          `focusReceiptId` still arrives in the router's location state, because
          SalaryDetailsModal links to a receipt it has just written — that link
          now points at this screen rather than /dokumente. */}
      <GehaltsquittungList
        refreshKey={receiptsVersion}
        focusReceiptId={focusReceiptId}
        onCreate={() => setIsReceiptModalOpen(true)}
      />

      <GehaltsquittungModal
        open={isReceiptModalOpen}
        onOpenChange={setIsReceiptModalOpen}
        onChanged={() => setReceiptsVersion(version => version + 1)}
      />
    </div>
  );
};

export default SalariesPage;
