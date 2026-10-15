/**
 * The fleet import: a new company connects to Reidey and pulls its data in.
 *
 * Its own route rather than a card on the Fahrer page, because it spans three
 * things (drivers, vehicles, earnings) and the first thing a new company needs
 * is the connection, which belongs above all of them. The Fahrer and Fahrzeuge
 * pages link here; Einstellungen keeps the connection card for later changes.
 *
 * Earnings are not rebuilt: the Uber earnings import lives on the Umsätze page
 * and this screen links to it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Wallet } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { PartnerConnectCard } from '../components/partner/PartnerConnectCard';
import { FleetImportCard } from '../components/partner/FleetImportCard';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '../components/ui';

export default function DataImportPage() {
  const { t } = useTranslation();
  const { isAdmin } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { canEdit } = useCompanyScope();

  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadConnection = useCallback(async () => {
    if (!companyId) {
      setConnected(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    try {
      const { data, error } = await supabase
        .from('partner_connections')
        .select('id')
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .limit(1);
      if (error) throw error;
      setConnected((data ?? []).length > 0);
    } catch {
      // "Not connected" is a claim; a failed read must not make it.
      setLoadFailed(true);
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void loadConnection(); }, [loadConnection]);

  // The database asks is_company_admin() and refuses a support session itself;
  // this only keeps the button honest.
  const mayImport = isAdmin && canEdit(undefined, 'drivers');

  return (
    <div className="font-ui grid grid-cols-1 gap-6">
      <PageHeader title={t('import.title')} description={t('import.description')} />

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle as="h2">{t('import.connection.title')}</CardTitle>
            <CardDescription>{t('import.connection.body')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <PartnerConnectCard companyId={companyId} onChanged={() => void loadConnection()} />
        </CardContent>
      </Card>

      {loading ? (
        <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('common.loading')}
        </div>
      ) : loadFailed ? (
        <Alert
          tone="critical"
          title={t('partner.connect.loadFailedTitle')}
          action={<Button variant="secondary" size="sm" onClick={() => void loadConnection()}>
            {t('partner.connect.retry')}
          </Button>}
        >
          {t('partner.connect.loadFailedBody')}
        </Alert>
      ) : (
        <FleetImportCard connected={connected} mayImport={mayImport} />
      )}

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle as="h2">
              <span className="inline-flex items-center gap-2">
                <Wallet className="size-4" aria-hidden />
                {t('import.earnings.title')}
              </span>
            </CardTitle>
            <CardDescription>{t('import.earnings.body')}</CardDescription>
          </div>
          <Button asChild variant="secondary">
            <Link to="/umsaetze">{t('import.earnings.action')}</Link>
          </Button>
        </CardHeader>
      </Card>
    </div>
  );
}
